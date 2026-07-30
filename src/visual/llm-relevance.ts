/**
 * LLM-judged element relevance for the semantic attention layer.
 *
 * WHAT THIS REPLACES. `computeGoalRelevance` scores an element by counting how
 * many goal keywords appear as substrings of its text, then scaling by 2.0. It
 * has no stemming, no synonyms and no semantics, so for the goal "buy a
 * subscription" the button "Checkout" scores ZERO, "Get Started" scores ZERO and
 * "Upgrade to Pro" scores ZERO — while a footer link reading "Subscription
 * terms" takes the full boost. Substring matching also fires on fragments:
 * "car rental" boosts "careers" and "shopping cart".
 *
 * That layer is supposed to model task-driven attention — Yarbus 1967, one of
 * the most replicated findings in eye-tracking — and it systematically misses
 * exactly the elements a goal-directed user goes for, because real calls to
 * action are rarely worded like the goal.
 *
 * WHAT IT DOES INSTEAD. One LLM call per (persona, goal, element-set) judges
 * every element at once. The model gets the persona's traits, motivational
 * values and description, not just its name, so relevance is judged the way the
 * persona would weigh it: an impatient power-user and an anxious first-timer
 * looking for the same thing do not attend to the same elements, and a semantic
 * vocabulary can express that where six element-type multipliers cannot.
 *
 * ONE CALL PER PAGE, NOT PER ELEMENT. A page carries tens of elements and the
 * overlay runs per frame; per-element or per-frame calls would make this
 * unusable. The cache key covers everything that can change the answer, so a
 * repeated run is free and deterministic — an LLM layer is only usable in a
 * regression context if repeating a run repeats the answer.
 *
 * FAILURE IS A DOWNGRADE, NEVER AN ERROR. No API key, a refused call, or
 * unparseable output falls back to the keyword scorer and reports `source`
 * accordingly. A relevance score whose provenance is unknown is worse than a
 * weak one: the caller must be able to say which method produced the number.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_DIR = join(
  process.env.CBROWSER_DATA_DIR || join(homedir(), ".cbrowser"),
  "llm-relevance-cache",
);

/** Element as the relevance judge sees it. Geometry is irrelevant to relevance. */
export interface RelevanceElement {
  /** Stable index the model scores against, so scores map back unambiguously. */
  index: number;
  type: string;
  text: string;
}

export interface RelevanceContext {
  goal?: string;
  personaName: string;
  /** Free-text persona description, when the persona carries one. */
  personaDescription?: string;
  /** Cognitive traits, 0-1. Patience, comprehension, risk tolerance and so on. */
  traits?: Record<string, number>;
  /** Schwartz motivational values, 0-1. */
  values?: Record<string, number>;
}

export interface RelevanceResult {
  /** Relevance per element index, 0-1. Missing index means zero. */
  scores: Record<number, number>;
  /** Which method produced these numbers. Never omit this from telemetry. */
  source: "llm" | "keyword-fallback";
  cached: boolean;
  model?: string;
  /** Present when the LLM path was attempted and could not be used. */
  unavailable?: string;
}

/** The model rung this layer runs on. Judgement task, not a reasoning task. */
const RELEVANCE_MODEL = "claude-sonnet-5";

function cacheKey(elements: RelevanceElement[], ctx: RelevanceContext): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(elements.map((e) => [e.index, e.type, e.text])));
  h.update(`|${ctx.personaName}|${ctx.goal ?? ""}|${RELEVANCE_MODEL}|`);
  h.update(JSON.stringify(ctx.traits ?? {}));
  h.update(JSON.stringify(ctx.values ?? {}));
  return h.digest("hex").slice(0, 32);
}

function readCache(key: string): RelevanceResult | null {
  try {
    const p = join(CACHE_DIR, `${key}.json`);
    if (!existsSync(p)) return null;
    return { ...(JSON.parse(readFileSync(p, "utf8")) as RelevanceResult), cached: true };
  } catch {
    return null;
  }
}

function writeCache(key: string, value: RelevanceResult): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
  } catch { /* a cold cache is slower, never wrong */ }
}

/** Render traits as prose the model can weigh, keeping only the extremes. */
function describeTraits(traits?: Record<string, number>): string {
  if (!traits) return "unspecified";
  const notable = Object.entries(traits)
    .filter(([, v]) => typeof v === "number" && (v <= 0.3 || v >= 0.7))
    .sort((a, b) => Math.abs(b[1] - 0.5) - Math.abs(a[1] - 0.5))
    .slice(0, 10)
    .map(([k, v]) => `${k} ${v.toFixed(2)} (${v >= 0.7 ? "high" : "low"})`);
  return notable.length > 0 ? notable.join(", ") : "all traits near baseline";
}

/**
 * The keyword scorer this layer replaces, kept as the fallback.
 *
 * Deliberately identical to the historical behaviour so a downgrade changes the
 * source field and nothing else.
 */
export function keywordRelevance(elementText: string, goal: string): number {
  if (!goal || !elementText) return 0;
  const stopWords = new Set(["the", "a", "an", "to", "for", "of", "in", "on", "at", "is", "it", "my", "i", "me", "and", "or", "how", "do", "can"]);
  const goalWords = goal.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
  if (goalWords.length === 0) return 0;
  const textLower = elementText.toLowerCase();
  const matches = goalWords.filter((w) => textLower.includes(w)).length;
  return matches === 0 ? 0 : (matches / goalWords.length) * 2.0;
}

function keywordFallback(
  elements: RelevanceElement[],
  ctx: RelevanceContext,
  unavailable: string,
): RelevanceResult {
  const scores: Record<number, number> = {};
  if (ctx.goal) {
    for (const el of elements) {
      // Historical scorer runs 0-2; this layer's contract is 0-1.
      const raw = keywordRelevance(el.text, ctx.goal) / 2;
      if (raw > 0) scores[el.index] = Math.min(1, raw);
    }
  }
  return { scores, source: "keyword-fallback", cached: false, unavailable };
}

/**
 * Judge how much each element deserves this persona's attention.
 *
 * Returns 0-1 per element index. Callers multiply their existing element weight
 * by `1 + k * score` rather than replacing it — relevance modulates the
 * element-type prior, it does not override it.
 */
export async function judgeRelevance(
  elements: RelevanceElement[],
  ctx: RelevanceContext,
  getApiKey: () => string | null,
): Promise<RelevanceResult> {
  if (elements.length === 0) {
    return { scores: {}, source: "llm", cached: false };
  }

  const key = cacheKey(elements, ctx);
  const hit = readCache(key);
  if (hit) return hit;

  const apiKey = getApiKey();
  if (!apiKey) return keywordFallback(elements, ctx, "No Anthropic API key configured");

  const system =
    "You judge which page elements a specific person would pay attention to. " +
    "You are modelling ONE person's attention, described by their traits, values and goal. " +
    "Score every element 0.0-1.0 for how much THIS person's attention it deserves.\n\n" +
    "Judge by meaning, not word overlap. For the goal \"buy a subscription\", a button " +
    "labelled \"Checkout\", \"Get Started\" or \"Upgrade to Pro\" is highly relevant even though " +
    "it shares no words with the goal, while a footer link reading \"Subscription terms\" is not.\n\n" +
    "Weigh the persona. Low patience skips explanatory copy and hunts for the action. High " +
    "anxiety or low trust dwells on security, price and reassurance. High conformity is pulled " +
    "by social proof and ratings; high self-direction ignores them. Low comprehension needs " +
    "labels and headings before controls. Let these genuinely change the ranking — two personas " +
    "with the same goal should not produce the same scores.\n\n" +
    "Return ONLY JSON: {\"scores\": {\"<index>\": <0.0-1.0>, ...}}. Omit elements scoring 0.";

  const user = [
    `Persona: ${ctx.personaName}`,
    ctx.personaDescription ? `Description: ${ctx.personaDescription}` : "",
    `Notable traits: ${describeTraits(ctx.traits)}`,
    ctx.values ? `Motivational values: ${describeTraits(ctx.values)}` : "",
    ctx.goal ? `Goal on this page: ${ctx.goal}` : "No stated goal — judge by what this persona is drawn to.",
    "",
    "Elements:",
    ...elements.map((e) => `${e.index}. [${e.type}] ${e.text.slice(0, 120)}`),
  ].filter(Boolean).join("\n");

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: RELEVANCE_MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return keywordFallback(elements, ctx, "Model returned no parseable JSON");

    const parsed = JSON.parse(match[0]) as { scores?: Record<string, number> };
    const scores: Record<number, number> = {};
    for (const [k, v] of Object.entries(parsed.scores ?? {})) {
      const idx = Number(k);
      // Reject anything that is not a real index or a real 0-1 score rather
      // than letting a malformed key become element 0 at NaN weight.
      if (!Number.isInteger(idx) || typeof v !== "number" || !Number.isFinite(v)) continue;
      if (idx < 0 || idx >= elements.length) continue;
      if (v > 0) scores[idx] = Math.max(0, Math.min(1, v));
    }

    const result: RelevanceResult = { scores, source: "llm", cached: false, model: RELEVANCE_MODEL };
    writeCache(key, result);
    return result;
  } catch (e) {
    return keywordFallback(elements, ctx, `LLM relevance failed: ${(e as Error).message}`);
  }
}
