/**
 * Study 1, ceiling arm: what is the visual channel worth at its best?
 *
 * ── HYPOTHESES ────────────────────────────────────────────────────────────────
 *
 * H1 — THE CEILING. Mutually exclusive, and this arm discriminates them.
 *   H1a  The shipped model is weak. A strong visual model beats center bias by a
 *        wide margin, so pixels DO carry attention information on UI stimuli and
 *        the visual channel is worth investing in.
 *   H1b  Web layouts are so convention-bound that no visual model gains much over
 *        "look at the middle". Then the shipped model is not especially bad, the
 *        whole channel is low-information, and its 35% blend weight is too high.
 *   Discriminator: VLM AUC minus CenterBias AUC, paired per image.
 *
 * H2 — PERSONA CONDITIONING, against an AGGREGATE ground truth (62 free-viewing
 *      participants, so the target is the average viewer, not any one person).
 *   H2a  Null. Persona ≈ generic. Persona conditioning is undetectable at this
 *        resolution, converging with the July finding (filters change map mass
 *        4.5x, change agreement 0.0037) from a new direction.
 *   H2b  Deviation. Persona scores LOWER. Expected for a correct persona model
 *        measured against an average, and it would establish that aggregate ground
 *        truth can never validate the persona claim — a result about the CORPUS.
 *   H2c  Improvement. Persona scores HIGHER. The surprising one: it would mean the
 *        trait vocabulary is supplying general attention knowledge rather than
 *        population-specific knowledge, i.e. doing something other than its name.
 *
 * H3 — VENDOR. Created by asking two models the same question.
 *   H3a  The ceiling is a property of the TASK. OpenAI and Claude land within
 *        noise, and "what the visual channel is worth" is a real quantity.
 *   H3b  The ceiling is a property of the MODEL. They diverge materially, there is
 *        no single ceiling, and any figure cited from here must name its model.
 *
 * NOT hypotheses — controls that make the above readable:
 *   Uniform must score exactly 0.5000 AUC (it does), and the shipped model must
 *   reproduce the July re-run (0.5854 then, 0.5871 now on 4x the stimuli). A
 *   benchmark whose floor is wrong cannot tell you anything about its ceiling.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * The shipped Lab-saliency model scores 0.5871 AUC on UEyes while a centred Gaussian
 * scores 0.6813. Two readings of that fit the same evidence:
 *
 *   (a) the model is weak, and a better visual model would win, or
 *   (b) web stimuli are so convention-bound that pixels carry little information
 *       beyond "look at the middle", and NO visual model gains much over center bias.
 *
 * Those imply opposite decisions — invest in the visual channel, or cut its 35% weight
 * — and the benchmark as it stands cannot separate them. A ceiling measurement can: run
 * a strong general vision model on the same stimuli, score it with the same metrics
 * against the same fixations, and read the gap.
 *
 * WHY A GRID AND NOT REGIONS. The production LLM layer (src/visual/llm-relevance.ts)
 * scores a supplied element list and can be handed a screenshot, but UEyes gives pixels
 * with no DOM, so there are no elements to score. Rather than invent a region-proposal
 * step — which would put an untested component between the model and the number — the
 * model is asked directly for a coarse attention grid. That maps onto the same
 * SaliencyGrid the other arms produce, so all three are scored by identical code.
 *
 * NO GOAL, AND NO SYNTHETIC PERSONA — both deliberate, and both follow from the ground
 * truth. UEyes is 62 participants FREE-VIEWING 1,980 screenshots; the corpus README
 * mentions no task, and it ships multi-duration scanpaths (1s/3s/7s), which is a
 * free-viewing protocol. So the ground truth contains no task-driven attention. Sending
 * the model a goal would have it predict something the data does not contain, and the
 * score would punish it for being right about a question nobody asked.
 *
 * The same logic rules out a synthetic "neurotypical" persona or a trait vector pinned
 * to 0.5. The ground truth is an AGGREGATE over 62 people; the closest match to that is
 * a model asked about "a person", not about an invented midpoint nobody occupies. And
 * the July run already showed the persona filters change total map mass 4.5x while
 * changing agreement with fixations by 0.0037 -- a synthetic persona adds a variable
 * with no referent and no demonstrated signal.
 *
 * A REAL persona is a different matter, and it is the second arm here. Running one
 * genuine roster persona against the SAME aggregate ground truth asks a question worth
 * answering: does persona conditioning move the prediction toward the average viewer or
 * away from it? If it lands on top of the generic arm, persona conditioning is
 * undetectable at this resolution. If it scores lower, that is expected rather than
 * damning -- a persona model SHOULD deviate from the average viewer -- but it means
 * aggregate ground truth can never validate the persona claim, which is itself the
 * finding.
 *
 * TWO VENDORS, BECAUSE A CEILING THAT MOVES WITH THE VENDOR IS NOT A CEILING. If OpenAI
 * and Claude land within noise of each other, "what the visual channel is worth" is a
 * property of the task and the number means something. If they diverge materially, there
 * is no single ceiling and every claim has to name its model. That is worth knowing
 * before anyone cites a figure from this file.
 *
 * PAIRED, ON THE SAME SUBSAMPLE. Every arm is scored on exactly the images the VLM saw.
 * Comparing a VLM subsample against the full-corpus means of the other arms would make
 * the stimulus set a hidden variable.
 *
 * Usage:
 *   OPENAI_API_KEY=... bun research/study1/run-vlm-ceiling.ts [--limit 60] [--model gpt-4.1]
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { computeLabSaliency } from "../../src/visual/attention-transport.js";
import { computeAUCJudd, computeNSS, computeCC, type SaliencyGrid, type Fixation } from "../../src/visual/saliency-metrics.js";
import { loadUEyesCorpus, parseGazepointLog, type RawFixation } from "../../src/visual/fixation-corpus.js";

const ROOT = join(import.meta.dir, "UEyes_dataset");
const CELL = 16;
/** Coarse grid the model reports. Fine enough to localise, coarse enough to be answerable. */
const GW = 16, GH = 10;

function centerBias(rows: number, cols: number): SaliencyGrid {
  const v = new Float64Array(rows * cols);
  const cy = (rows - 1) / 2, cx = (cols - 1) / 2, sy = rows / 4, sx = cols / 4;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const dy = (r - cy) / sy, dx = (c - cx) / sx;
    v[r * cols + c] = Math.exp(-0.5 * (dy * dy + dx * dx));
  }
  return { values: v, width: cols, height: rows };
}

function toGrid(fx: RawFixation[], rows: number, cols: number): Fixation[] {
  const out: Fixation[] = [];
  for (const f of fx) {
    const c = Math.floor((f as any).xNorm * cols), r = Math.floor((f as any).yNorm * rows);
    if (r >= 0 && r < rows && c >= 0 && c < cols) out.push({ x: c, y: r });
  }
  return out;
}

/** Nearest-neighbour upsample of the model's coarse grid to the scoring resolution. */
function upsample(coarse: number[][], rows: number, cols: number): SaliencyGrid {
  const v = new Float64Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const gr = Math.min(GH - 1, Math.floor((r / rows) * GH));
    const gc = Math.min(GW - 1, Math.floor((c / cols) * GW));
    v[r * cols + c] = coarse[gr]?.[gc] ?? 0;
  }
  return { values: v, width: cols, height: rows };
}

const PERSONA_ARM = "cognitive-adhd";

function personaPreamble(name: string, traits: Record<string, number>): string {
  const notable = Object.entries(traits)
    .filter(([, v]) => v <= 0.3 || v >= 0.7)
    .sort((a, b) => Math.abs(b[1] - 0.5) - Math.abs(a[1] - 0.5))
    .slice(0, 8)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(", ");
  return `You are predicting the gaze of one specific person, not an average viewer.\n` +
    `Persona: ${name}\nNotable traits (0-1): ${notable}\n` +
    `Let these genuinely change where attention lands.\n\n`;
}

const PROMPT =
  `This is a screenshot of a user interface. Predict where a person's eyes would go in the ` +
  `first few seconds of looking at it, before they have read anything carefully.\n\n` +
  `Return a ${GH}-row by ${GW}-column grid of integers 0-100, where each number is how much ` +
  `visual attention that cell of the image receives. Row 1 is the top of the image, column 1 ` +
  `the left.\n\n` +
  `Judge by what actually pulls the eye: contrast against surroundings, size, faces, isolated ` +
  `elements, the primary call to action, motion cues. Do NOT simply weight the centre — if the ` +
  `interesting content is off-centre, say so.\n\n` +
  `Return ONLY JSON: {"grid": [[...${GW} numbers...], ... ${GH} rows ...]}`;

function parseGrid(text: string): number[][] | null {
  try {
    // Accept BOTH {"grid": [[...]]} and a bare [[...]].
    //
    // Vendors disagree on the wrapper even under an explicit JSON instruction:
    // gemini-3-flash-preview returns the object, gemini-3.6-flash returns the
    // bare array. Rejecting the bare form would have scored a working model as
    // "could not answer" -- the same silent-null class that made the Claude arm
    // look broken when it was actually a media-type mismatch.
    const obj = text.match(/\{[\s\S]*\}/);
    const arr = text.match(/\[[\s\S]*\]/);
    const parsed = obj ? JSON.parse(obj[0]) : arr ? JSON.parse(arr[0]) : JSON.parse(text);
    const grid = Array.isArray(parsed) ? parsed : parsed.grid;
    if (!Array.isArray(grid) || grid.length !== GH) return null;
    // Reject a malformed grid rather than pad it: a silently reshaped prediction would
    // score, and score wrongly, with nothing indicating the model never answered.
    if (grid.some((r: unknown) => !Array.isArray(r) || (r as unknown[]).length !== GW)) return null;
    return grid.map((r: number[]) => r.map((n) => (Number.isFinite(n) ? Number(n) : 0)));
  } catch { return null; }
}

/**
 * Media type from the MAGIC BYTES, never the file extension.
 *
 * 136 of the corpus's 1,147 `.png` files are actually JPEG (and 0 the other
 * way). Trusting the extension therefore sent `media_type: image/png` with JPEG
 * bytes on ~12% of stimuli. Anthropic validates the declared type against the
 * payload and returns HTTP 400; OpenAI does not check, and scored those images
 * fine. So the vendor comparison was quietly running Claude on a SUBSET of the
 * images OpenAI saw -- an arm-vs-arm result computed over different samples,
 * which is exactly the defect this study exists to stop reporting.
 */
function sniffMime(bytes: Buffer): "image/png" | "image/jpeg" {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg" : "image/png";
}

/**
 * Gemini arm. Same prompt, same grid contract, same magic-byte mime discipline.
 *
 * Uses the REST API rather than the `gemini` CLI on purpose. The CLI does work
 * with an OAuth login and no key -- verified 2026-08-04, it returns a valid
 * 12x16 grid -- but it took 174s per image against 18-39s here, and it runs an
 * agent loop rather than a single inference (the probe printed "Ripgrep is not
 * available. Falling back to GrepTool." mid-task). That means a CLI number would
 * carry the CLI's own system prompt, tool scaffolding and sampling defaults,
 * none of which can be pinned to match the OpenAI and Anthropic arms. Putting it
 * in the same table would be a comparison the harness does not support.
 */
async function askGemini(imgPath: string, model: string, key: string, preamble = ""): Promise<number[][] | null> {
  // Retry on TRANSIENT capacity errors only, with backoff and a cap.
  //
  // Measured 2026-08-04: gemini-3-flash-preview returned HTTP 503 "This model is
  // currently experiencing high demand" on roughly 1 call in 10. Left alone that
  // silently shrinks the Gemini arm's sample while OpenAI and Claude keep all 60
  // -- the unequal-sample defect this study already hit once via the media-type
  // bug, and the reason every arm now prints its own n.
  //
  // 429 and 5xx only. A 4xx other than 429 is a real rejection (bad model name,
  // malformed request, revoked key) and retrying it just repeats the mistake
  // more slowly, so those still fail loudly on the first attempt.
  for (let attempt = 0; ; attempt++) {
    const grid = await askGeminiOnce(imgPath, model, key, preamble, attempt);
    if (grid !== RETRYABLE) return grid;
    if (attempt >= 4) {
      console.warn(`  gemini: giving up after ${attempt + 1} attempts (capacity)`);
      return null;
    }
    const backoff = 2000 * 2 ** attempt + Math.floor(Math.random() * 1000);
    await new Promise((r) => setTimeout(r, backoff));
  }
}

/** Sentinel distinguishing "retry me" from "this genuinely produced nothing". */
const RETRYABLE = Symbol("retryable") as unknown as number[][];

async function askGeminiOnce(
  imgPath: string, model: string, key: string, preamble: string, attempt: number,
): Promise<number[][] | null> {
  const raw = readFileSync(imgPath);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: sniffMime(raw), data: raw.toString("base64") } },
            { text: preamble + PROMPT },
          ],
        }],
        generationConfig: { responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!res.ok) {
    const body = (await res.text()).slice(0, 140);
    if (res.status === 429 || res.status >= 500) {
      console.warn(`  gemini ${res.status} (attempt ${attempt + 1}, will retry): ${body.slice(0, 80)}`);
      return RETRYABLE;
    }
    console.warn(`  gemini ${res.status}: ${body}`);
    return null;
  }
  const j: any = await res.json();
  const text = j?.candidates?.[0]?.content?.parts?.find?.((p: any) => typeof p.text === "string")?.text ?? "";
  return parseGrid(text);
}

/** Claude arm. Same prompt, same grid contract, different vendor. */
async function askClaude(imgPath: string, model: string, key: string, preamble = ""): Promise<number[][] | null> {
  const raw = readFileSync(imgPath);
  const b64 = raw.toString("base64");
  const mime = sniffMime(raw);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      // No `temperature`: deprecated on claude-fable-5, and sending it returns HTTP 400.
      // Both vendors rejected this harness's original parameter shape, and both
      // rejections were being swallowed by `if (!res.ok) return null` -- so the arm
      // reported "the model could not answer" for what was actually a 400 from a
      // deprecated field. Failures now name themselves.
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
          { type: "text", text: preamble + PROMPT },
        ],
      }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    console.warn(`  claude ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return null;
  }
  const j: any = await res.json();
  const text = j?.content?.find?.((c: any) => c.type === "text")?.text ?? "";
  return parseGrid(text);
}

async function askVLM(imgPath: string, model: string, key: string, preamble = ""): Promise<number[][] | null> {
  const raw = readFileSync(imgPath);
  const b64 = raw.toString("base64");
  const mime = sniffMime(raw);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: preamble + PROMPT },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      }],
      response_format: { type: "json_object" },
      // gpt-5.x rejects `max_tokens` (use `max_completion_tokens`) and rejects a
      // `temperature` override entirely. Probed against gpt-5.6-sol before this run
      // rather than assumed: the 4.x parameter shape returns HTTP 400, so a harness
      // written against the old names would have failed every call and recorded it as
      // "the model could not answer".
      max_completion_tokens: 4000,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    console.warn(`  openai ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return null;
  }
  const j: any = await res.json();
  return parseGrid(j?.choices?.[0]?.message?.content ?? "");
}

async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 60;
  const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "gpt-5.6-sol";
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  // Second vendor is optional: absent key means the arm is skipped, not that the run
  // fails. A missing comparison should cost you the comparison, not the study.
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const claudeModel = args.includes("--claude-model") ? args[args.indexOf("--claude-model") + 1] : "claude-fable-5";
  let claudeFailed = 0;
  const geminiKey = process.env.GEMINI_API_KEY;
  const geminiModel = args.includes("--gemini-model") ? args[args.indexOf("--gemini-model") + 1] : "gemini-3-flash-preview";
  let geminiFailed = 0;
  // `--out` honoured, and a small run REFUSES to write to the default directory.
  //
  // This file had no --out at all, unlike its sibling runners. On 2026-08-04 a
  // 3-image smoke test was launched with --out pointing at a scratch path, the
  // flag was silently ignored, and the run overwrote a completed 60-image
  // two-vendor result with three images. Nothing warned, because "wrote <dir>"
  // looks identical whether it wrote 3 rows or 60.
  //
  // Two guards: honour the flag, and refuse to clobber the canonical directory
  // from a run too small to be a real result. A destructive default is not a
  // default, it is a trap.
  const outDir = args.includes("--out")
    ? args[args.indexOf("--out") + 1]
    : join(import.meta.dir, "results/2026-08-04_vlm-ceiling");
  if (!args.includes("--out") && Number.isFinite(limit) && limit < 20) {
    throw new Error(
      `Refusing to write a ${limit}-image run to the canonical results directory.\n` +
      `Small runs are smoke tests and must not overwrite a real result. Pass --out <dir>.`,
    );
  }

  // A REAL persona from the shipped roster, not an invented one.
  const { getAnyPersona } = await import("../../src/personas.js");
  const pObj: any = getAnyPersona(PERSONA_ARM);
  const pTraits: Record<string, number> = (pObj?.cognitiveTraits ?? {}) as Record<string, number>;
  if (!Object.keys(pTraits).length) throw new Error(`persona ${PERSONA_ARM} has no traits`);
  const personaPre = personaPreamble(PERSONA_ARM, pTraits);

  const corpus = loadUEyesCorpus(ROOT)!;
  const byImage = new Map<string, RawFixation[]>();
  for (const f of readdirSync(join(ROOT, "eyetracker_logs"))) {
    if (!f.endsWith(".csv") || f.startsWith("._")) continue;
    for (const fx of parseGazepointLog(join(ROOT, "eyetracker_logs", f))) {
      const k = String((fx as any).stimulusId ?? "").toLowerCase();
      if (!k) continue;
      if (!byImage.has(k)) byImage.set(k, []);
      byImage.get(k)!.push(fx);
    }
  }

  // Deterministic spread across the corpus rather than the first N, which would be one
  // alphabetical slice of whatever the dataset happens to order first.
  const eligible = corpus.stimuli.filter((s) =>
    byImage.has(basename(s.imagePath).replace(/\.[^.]+$/, "").toLowerCase()));
  const step = Math.max(1, Math.floor(eligible.length / limit));
  const sample = eligible.filter((_, i) => i % step === 0).slice(0, limit);
  console.log(`sampling ${sample.length} of ${eligible.length} stimuli, model=${model}`);

  const rows: Array<Record<string, string | number>> = [];
  let ok = 0, failed = 0;

  for (const st of sample) {
    const key2 = basename(st.imagePath).replace(/\.[^.]+$/, "").toLowerCase();
    const fx = byImage.get(key2)!;
    let sal;
    try { sal = await computeLabSaliency(st.imagePath, CELL); } catch { continue; }
    const pts = toGrid(fx, sal.rows, sal.cols);
    if (!pts.length) continue;

    const coarse = await askVLM(st.imagePath, model, key);
    if (!coarse) { failed++; continue; }
    const coarsePersona = await askVLM(st.imagePath, model, key, personaPre);
    const coarseClaude = claudeKey ? await askClaude(st.imagePath, claudeModel, claudeKey) : null;
    if (claudeKey && !coarseClaude) claudeFailed++;
    const coarseGemini = geminiKey ? await askGemini(st.imagePath, geminiModel, geminiKey) : null;
    if (geminiKey && !coarseGemini) geminiFailed++;
    ok++;

    const gt = new Float64Array(sal.rows * sal.cols);
    for (const p of pts) gt[p.y * sal.cols + p.x] += 1;
    const gtGrid: SaliencyGrid = { values: gt, width: sal.cols, height: sal.rows };

    const arms: Array<[string, SaliencyGrid]> = [
      ["VLM_openai_generic", upsample(coarse, sal.rows, sal.cols)],
      ...(coarsePersona ? [[`VLM_openai_persona_${PERSONA_ARM}`, upsample(coarsePersona, sal.rows, sal.cols)] as [string, SaliencyGrid]] : []),
      ...(coarseClaude ? [["VLM_claude_generic", upsample(coarseClaude, sal.rows, sal.cols)] as [string, SaliencyGrid]] : []),
      ...(coarseGemini ? [["VLM_gemini_generic", upsample(coarseGemini, sal.rows, sal.cols)] as [string, SaliencyGrid]] : []),
      ["Shipped_LabSaliency", { values: sal.cells, width: sal.cols, height: sal.rows }],
      ["CenterBias", centerBias(sal.rows, sal.cols)],
    ];
    for (const [m, g] of arms) {
      rows.push({
        image: key2, method: m,
        auc: computeAUCJudd(g, pts).auc,
        nss: computeNSS(g, pts).nss,
        cc: computeCC(g, gtGrid),
      });
    }
    if (ok % 10 === 0) console.log(`  ${ok} scored (openai ${failed} fail, claude ${claudeFailed} fail, gemini ${geminiFailed} fail)`);
  }

  const summary: Record<string, { auc: number; nss: number; cc: number; n: number }> = {};
  for (const r of rows) {
    const s = (summary[r.method as string] ??= { auc: 0, nss: 0, cc: 0, n: 0 });
    s.auc += r.auc as number; s.nss += r.nss as number; s.cc += r.cc as number; s.n++;
  }
  for (const s of Object.values(summary)) { s.auc /= s.n; s.nss /= s.n; s.cc /= s.n; }

  // Paired win rates on the identical stimulus set.
  const byImg = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const k = r.image as string;
    if (!byImg.has(k)) byImg.set(k, {});
    byImg.get(k)![r.method as string] = r.auc as number;
  }
  const pairRate = (a: string, b: string) => {
    let w = 0, n = 0;
    for (const m of byImg.values()) if (m[a] != null && m[b] != null) { n++; if (m[a] > m[b]) w++; }
    return { wins: w, pairs: n, rate: n ? w / n : 0 };
  };

  mkdirSync(outDir, { recursive: true });
  const out = {
    ran: new Date().toISOString(), openai_model: model, claude_model: claudeKey ? claudeModel : null, images: ok, openai_failures: failed, claude_failures: claudeFailed, gemini_model: geminiKey ? geminiModel : null, gemini_failures: geminiFailed,
    summary,
    paired: {
      openai_beats_centerbias: pairRate("VLM_openai_generic", "CenterBias"),
      openai_beats_shipped: pairRate("VLM_openai_generic", "Shipped_LabSaliency"),
      openai_generic_beats_persona: pairRate("VLM_openai_generic", `VLM_openai_persona_${PERSONA_ARM}`),
      claude_beats_centerbias: pairRate("VLM_claude_generic", "CenterBias"),
      openai_beats_claude: pairRate("VLM_openai_generic", "VLM_claude_generic"),
      gemini_beats_centerbias: pairRate("VLM_gemini_generic", "CenterBias"),
      claude_beats_gemini: pairRate("VLM_claude_generic", "VLM_gemini_generic"),
      openai_beats_gemini: pairRate("VLM_openai_generic", "VLM_gemini_generic"),
      shipped_beats_centerbias: pairRate("Shipped_LabSaliency", "CenterBias"),
    },
  };
  writeFileSync(join(outDir, "vlm_ceiling_summary.json"), JSON.stringify(out, null, 2));
  writeFileSync(join(outDir, "vlm_per_image.csv"),
    "image,method,auc,nss,cc\n" + rows.map((r) => `${r.image},${r.method},${(r.auc as number).toFixed(6)},${(r.nss as number).toFixed(6)},${(r.cc as number).toFixed(6)}`).join("\n"));

  console.log("\n" + "─".repeat(60));
  // `n` is printed per arm on purpose. An arm that failed on some stimuli simply
  // has no row for them, so its mean is computed over a different subset -- a
  // vendor comparison across unequal samples reads exactly like a real result.
  // The paired win-rates below are already subset-safe (both-present only); this
  // column is what makes the mean column's sample visible too.
  console.log(`${"arm".padEnd(24)}${"AUC".padStart(8)}${"NSS".padStart(9)}${"CC".padStart(9)}${"n".padStart(6)}`);
  for (const [k, s] of Object.entries(summary).sort((a, b) => b[1].auc - a[1].auc))
    console.log(`${k.padEnd(24)}${s.auc.toFixed(4).padStart(8)}${s.nss.toFixed(4).padStart(9)}${s.cc.toFixed(4).padStart(9)}${String(s.n).padStart(6)}`);
  console.log("─".repeat(60));
  for (const [k, v] of Object.entries(out.paired))
    console.log(`${k.padEnd(28)} ${v.wins}/${v.pairs} (${(v.rate * 100).toFixed(1)}%)`);
  console.log(`\nwrote ${outDir}`);
  void existsSync;
}

main().catch((e) => { console.error(e); process.exit(1); });
