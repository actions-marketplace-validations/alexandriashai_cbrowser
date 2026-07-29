/**
 * AI attention layer — persona-aware semantic reading of the rendered page.
 *
 * WHAT THE EXISTING TWO LAYERS CANNOT SEE
 *
 * Layer 1 (bottom-up saliency) knows where colour and texture pop. Layer 2
 * (DOM semantics) knows element TYPE — CTA, heading, nav — times persona
 * priority, plus keyword overlap with the goal. Neither knows what the content
 * MEANS to this particular person. "Start free trial" and "Contact enterprise
 * sales" are both CTAs of identical type and similar contrast; to a
 * price-anxious first-timer they are not remotely the same object. Nor do the
 * first two layers read text baked into images, judge compositional hierarchy
 * (size, whitespace, alignment), or model reading order.
 *
 * That is the headroom this layer addresses: meaning, weighted by what this
 * persona values.
 *
 * WHY IT IS A SEPARATE LAYER AND NOT A BLEND
 *
 * The deliberate design choice, and the one worth defending. Layers 1 and 2 are
 * deterministic — the same screenshot yields the same map, which is what makes
 * visual baselines and regression comparisons meaningful. An LLM's opinion is
 * not deterministic, and silently averaging it into the same `saliency` number
 * would make every downstream metric unreproducible while looking unchanged.
 * This codebase has repeatedly shipped exactly that shape: a value quietly
 * folded in under a name that already meant something else.
 *
 * So the AI regions are returned ALONGSIDE, named, with the model's own
 * reasoning attached, and a caller opts in explicitly. A blended convenience
 * field exists but says so in `attentionModel`.
 *
 * WHAT WE CANNOT CURRENTLY CLAIM
 *
 * There is no eye-tracking ground truth in this repository, so there is no
 * measurement that says this layer makes the map more accurate — only that it
 * makes it different. It is offered as an interpretive aid, and its output is
 * labelled as a model's judgement rather than a measurement. Validating it
 * needs a fixation dataset; until then, treat confident agreement between this
 * layer and the other two as the useful signal, and disagreement as a question,
 * not an answer.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { createHash } from "crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** A region the model expects this persona to attend to, in image pixels. */
export interface AIAttentionRegion {
  /** Bounding box in the screenshot's own pixel space. */
  rect: { x: number; y: number; width: number; height: number };
  /** 0-1 — how strongly this persona is expected to attend here. */
  weight: number;
  /** What is actually there. */
  label: string;
  /** Why THIS persona attends to it. The value of the layer is in this string. */
  reasoning: string;
}

export interface AIAttentionResult {
  regions: AIAttentionRegion[];
  /** One-paragraph account of how this persona reads the page. */
  narrative: string;
  model: string;
  cached: boolean;
  /** Populated instead of throwing when the layer cannot run. */
  unavailable?: string;
}

const CACHE_DIR = join(
  process.env.CBROWSER_DATA_DIR || join(homedir(), ".cbrowser"),
  "ai-attention-cache",
);

/**
 * Cache key covers everything that can change the answer: the exact image, the
 * persona, the goal, the values and the model. An LLM layer is only usable in a
 * regression context if repeating a run repeats the answer — and it makes the
 * layer nearly free on re-analysis of an unchanged page.
 */
function cacheKey(
  imageBytes: Buffer,
  persona: string,
  goal: string | undefined,
  values: Record<string, number> | undefined,
  model: string,
): string {
  const h = createHash("sha256");
  h.update(imageBytes);
  h.update(`|${persona}|${goal ?? ""}|${model}|`);
  h.update(JSON.stringify(values ?? {}));
  return h.digest("hex").slice(0, 32);
}

function readCache(key: string): AIAttentionResult | null {
  try {
    const p = join(CACHE_DIR, `${key}.json`);
    if (!existsSync(p)) return null;
    return { ...(JSON.parse(readFileSync(p, "utf8")) as AIAttentionResult), cached: true };
  } catch {
    return null;
  }
}

function writeCache(key: string, value: AIAttentionResult): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
  } catch {
    /* cache is an optimisation; never fail the analysis for it */
  }
}

/** Describe persona values in words the model can act on. */
function describeValues(values: Record<string, number> | undefined): string {
  if (!values) return "No specific motivational profile supplied.";
  const notable = Object.entries(values)
    .filter(([, v]) => typeof v === "number" && (v >= 0.7 || v <= 0.3))
    .map(([k, v]) => `${k}=${v.toFixed(2)} (${v >= 0.7 ? "high" : "low"})`);
  return notable.length ? notable.join(", ") : "Values are mid-range across the board.";
}

/**
 * Ask the model where this persona looks and why.
 *
 * Returns `unavailable` rather than throwing when there is no key or the call
 * fails: this layer is additive, and an attention map without it is the same
 * map the product shipped before it existed.
 */
export async function analyzeAttentionWithAI(
  screenshotPath: string,
  persona: string,
  options: {
    goal?: string;
    values?: Record<string, number>;
    personaDescription?: string;
    imageWidth?: number;
    imageHeight?: number;
  } = {},
): Promise<AIAttentionResult> {
  const { getAnthropicApiKey, getAnthropicModel, isApiKeyConfigured } = await import(
    "../cognitive/index.js"
  );

  if (!isApiKeyConfigured()) {
    return {
      regions: [],
      narrative: "",
      model: "",
      cached: false,
      unavailable:
        "No Anthropic API key configured. The AI attention layer is opt-in and keyed; the visual and semantic layers are unaffected.",
    };
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(screenshotPath);
  } catch {
    return { regions: [], narrative: "", model: "", cached: false, unavailable: `Could not read ${screenshotPath}` };
  }

  const model = getAnthropicModel();
  const key = cacheKey(bytes, persona, options.goal, options.values, model);
  const hit = readCache(key);
  if (hit) return hit;

  const dims =
    options.imageWidth && options.imageHeight
      ? `The image is ${options.imageWidth}x${options.imageHeight} pixels.`
      : "Coordinates must be in the image's own pixel space.";

  const system = `You model visual attention for a specific person looking at a web page. You are not describing what is on the page — you are predicting where THIS person's eyes go, and why, given who they are.

Return ONLY a JSON object, no prose outside it:
{"regions":[{"rect":{"x":0,"y":0,"width":0,"height":0},"weight":0.0,"label":"","reasoning":""}],"narrative":""}

Rules:
- ${dims} Coordinates are top-left origin.
- weight is 0-1: how strongly this person attends, relative to everything else on the page.
- Return at most 8 regions. Fewer is better than padding.
- reasoning must name something about THIS PERSON, not the page in general. "Large red button" is a description; "a price-anxious first-timer checks cost before anything else, so the pricing link pulls first" is a prediction.
- Attend to what the DOM cannot express: what the copy MEANS to them, text inside images, compositional hierarchy, and what they will deliberately SKIP.
- narrative: 2-4 sentences on how this person reads this page.`;

  const goalLine = options.goal
    ? `They are trying to: ${options.goal}. Goal-relevant content should dominate.`
    : `They have no specific task — this is undirected first-contact browsing.`;

  const user = `Person: ${persona}
${options.personaDescription ? `Who they are: ${options.personaDescription}` : ""}
Motivational profile: ${describeValues(options.values)}
${goalLine}

Where do their eyes go on this page, and why?`;

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: getAnthropicApiKey() });
    const response = await client.messages.create({
      model,
      max_tokens: 1500,
      system,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
            },
            { type: "text", text: user },
          ],
        },
      ],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return { regions: [], narrative: "", model, cached: false, unavailable: "Model returned no parseable JSON" };
    }
    const parsed = JSON.parse(match[0]) as { regions?: AIAttentionRegion[]; narrative?: string };

    const result: AIAttentionResult = {
      // Clamp rather than trust: a hallucinated weight of 12 would silently
      // dominate any blend it is fed into.
      regions: (parsed.regions ?? []).slice(0, 8).map((r) => ({
        rect: {
          x: Math.max(0, Math.round(r.rect?.x ?? 0)),
          y: Math.max(0, Math.round(r.rect?.y ?? 0)),
          width: Math.max(1, Math.round(r.rect?.width ?? 1)),
          height: Math.max(1, Math.round(r.rect?.height ?? 1)),
        },
        weight: Math.min(1, Math.max(0, Number(r.weight) || 0)),
        label: String(r.label ?? "").slice(0, 120),
        reasoning: String(r.reasoning ?? "").slice(0, 400),
      })),
      narrative: String(parsed.narrative ?? "").slice(0, 1200),
      model,
      cached: false,
    };
    writeCache(key, result);
    return result;
  } catch (err) {
    return {
      regions: [],
      narrative: "",
      model,
      cached: false,
      unavailable: `AI attention layer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Rasterise AI regions onto the analysis grid so they can be compared with, or
 * blended into, the existing saliency cells.
 *
 * Kept separate from the fetch so a caller can display the regions and their
 * reasoning WITHOUT blending — which is the recommended use, since the blend
 * makes the map non-deterministic.
 */
export function aiRegionsToGrid(
  regions: AIAttentionRegion[],
  rows: number,
  cols: number,
  imageWidth: number,
  imageHeight: number,
): Float64Array {
  const grid = new Float64Array(rows * cols);
  if (regions.length === 0 || imageWidth <= 0 || imageHeight <= 0) return grid;

  for (const region of regions) {
    const c0 = Math.max(0, Math.floor((region.rect.x / imageWidth) * cols));
    const c1 = Math.min(cols - 1, Math.ceil(((region.rect.x + region.rect.width) / imageWidth) * cols) - 1);
    const r0 = Math.max(0, Math.floor((region.rect.y / imageHeight) * rows));
    const r1 = Math.min(rows - 1, Math.ceil(((region.rect.y + region.rect.height) / imageHeight) * rows) - 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        // Max, not sum: overlapping regions should not compound into a hotspot
        // that neither region claimed on its own.
        if (region.weight > grid[i]) grid[i] = region.weight;
      }
    }
  }
  return grid;
}
