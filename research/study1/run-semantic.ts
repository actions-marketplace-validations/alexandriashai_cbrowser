/**
 * Study 1c -- does the 65% SEMANTIC channel predict where people look?
 *
 * Every Study 1 number to date -- published, retracted, and re-run -- describes
 * `computeLabSaliency`, which is 35% of `analyzeAttention`. The other 65% is
 * `buildSemanticMap` over DOM elements, and a screenshot has no DOM, so on this
 * corpus it has never executed. This run supplies reconstructed elements from
 * ocr-extract.ts (deterministic, no model) and finally scores that channel.
 *
 * ## The arms, and what each one isolates
 *
 * | arm                 | what it is                                             |
 * |---------------------|--------------------------------------------------------|
 * | Semantic_typed      | cbrowser's weighting over the extractor's element types  |
 * | Semantic_flat       | SAME elements, type labels stripped -- uniform weight    |
 * | Shipped_blend_wN     | the whole product: analyzeAttention with those elements  |
 * | Shipped_LabSaliency | the 35% visual channel alone (the old Study 1 number)    |
 * | CenterBias          | a centred Gaussian                                       |
 * | Uniform             | the floor -- must score exactly 0.5000 AUC               |
 *
 * **Semantic_typed vs Semantic_flat is the load-bearing comparison and the whole
 * reason this design works.** There is no element ground truth for UEyes, so the
 * extractor's own accuracy cannot be measured, and a bad extraction would be
 * scored as cbrowser error. Holding the extractor constant across both arms
 * removes it from the comparison: identical boxes, identical painted words,
 * identical persona filter, differing ONLY in whether cbrowser's element-type
 * weights are applied. Whatever separates them is attributable to the weighting.
 * If they tie, the 10x weight spread (cta 1.0 to decorative 0.1) buys nothing on
 * real gaze, and that is a finding.
 *
 * ## Two things this still cannot answer
 *
 * 1. **Goal relevance never runs.** `computeGoalRelevance` needs a goal, and
 *    UEyes is FREE-VIEWING -- participants were given no task. So Layer 3 of the
 *    semantic weighting is inert here regardless of what the extractor does. This
 *    tests element weighting, not goal-driven attention.
 * 2. **Persona differentiation.** UEyes ground truth is aggregate over 62
 *    participants. Agreement with an aggregate is not evidence about any
 *    population, and moving away from it is not evidence of persona fidelity.
 *
 * Usage:
 *   bun research/study1/run-semantic.ts [--limit N] [--persona NAME] [--out DIR]
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import {
  computeLabSaliency,
  analyzeAttentionFromDOM,
  analyzeAttention,
  GAZE_CALIBRATION,
  type DOMAttentionElement,
} from "../../src/visual/attention-transport.js";
import { computeAUCJudd, computeNSS, computeCC, type SaliencyGrid, type Fixation } from "../../src/visual/saliency-metrics.js";
import { loadUEyesCorpus, parseGazepointLog, type RawFixation } from "../../src/visual/fixation-corpus.js";
import { extractElements } from "./ocr-extract.js";

const ROOT = join(import.meta.dir, "UEyes_dataset");
const CELL = 16;
/** computeLabSaliency downsamples 0.5x before celling, so one cell spans 32 image px. */
const IMG_SCALE = 0.5;
/**
 * Arm label derived from the live constant, never typed by hand.
 *
 * This column was hardcoded "Blend_35_65". The shipped weights changed to
 * 0.2/0.8 on 2026-08-04 and the header kept asserting the old ratio — a result
 * table naming a configuration that no longer existed. Deriving it means the
 * label cannot drift from the code it describes.
 */
const SHIPPED_ARM = `Shipped_blend_w${GAZE_CALIBRATION.visualWeight}`;

function centerBias(rows: number, cols: number): SaliencyGrid {
  const v = new Float64Array(rows * cols);
  const cy = (rows - 1) / 2, cx = (cols - 1) / 2, sy = rows / 4, sx = cols / 4;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const dy = (r - cy) / sy, dx = (c - cx) / sx;
      v[r * cols + c] = Math.exp(-0.5 * (dy * dy + dx * dx));
    }
  return { values: v, width: cols, height: rows };
}

function uniform(rows: number, cols: number): SaliencyGrid {
  return { values: new Float64Array(rows * cols).fill(1), width: cols, height: rows };
}

/** Fixations ship NORMALISED (xNorm/yNorm in 0..1); the cell is the fraction times the grid. */
function toGrid(fx: RawFixation[], rows: number, cols: number): Fixation[] {
  const out: Fixation[] = [];
  for (const f of fx) {
    const c = Math.floor((f as any).xNorm * cols);
    const r = Math.floor((f as any).yNorm * rows);
    if (r >= 0 && r < rows && c >= 0 && c < cols) out.push({ x: c, y: r });
  }
  return out;
}

/**
 * Strip every semantic label while preserving geometry, text and word boxes.
 *
 * This is the control. `buildSemanticMap` falls back to `elType = "content"`
 * (weight 0.2) for anything unlabelled, so every element lands on the same
 * base weight and the map becomes pure element-coverage. Text is deliberately
 * KEPT: the Schwartz value-pattern boost reads `el.text`, and dropping it here
 * would make this arm differ from the typed arm in two ways instead of one.
 */
function stripTypes(els: DOMAttentionElement[]): DOMAttentionElement[] {
  return els.map((e) => ({
    type: "content",
    x: e.x, y: e.y, width: e.width, height: e.height,
    text: e.text, words: e.words,
  }));
}

/** Scale element boxes into the downsampled space the saliency grid lives in. */
function scaleEls(els: DOMAttentionElement[], s: number): DOMAttentionElement[] {
  return els.map((e) => ({
    ...e,
    x: e.x * s, y: e.y * s, width: e.width * s, height: e.height * s,
    words: e.words?.map((w) => ({ ...w, x: w.x * s, y: w.y * s, width: w.width * s, height: w.height * s })),
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const limit = arg("--limit") ? Number(arg("--limit")) : Infinity;
  const persona = arg("--persona") ?? "first-timer";
  const outDir = arg("--out") ?? join(import.meta.dir, "results/2026-08-04_semantic");

  const corpus = loadUEyesCorpus(ROOT);
  if (!corpus) throw new Error(`UEyes corpus not loadable at ${ROOT}`);

  // WEB ONLY. The corpus is 495 each of web / mobile / desktop / poster; a poster
  // has no DOM even in principle, so reconstructing one for it would be theatre.
  const webNames = new Set<string>();
  for (const line of readFileSync(join(ROOT, "image_types.csv"), "utf8").split("\n").slice(1)) {
    const [name, cat] = line.split(";");
    if (cat?.trim() === "web") webNames.add(name.trim().replace(/\.[^.]+$/, "").toLowerCase());
  }
  console.log(`web-category stimuli in corpus: ${webNames.size}`);

  const logDir = join(ROOT, "eyetracker_logs");
  const byImage = new Map<string, RawFixation[]>();
  let logs = 0;
  for (const f of readdirSync(logDir)) {
    if (!f.endsWith(".csv") || f.startsWith("._")) continue;
    logs++;
    for (const fx of parseGazepointLog(join(logDir, f))) {
      const k = String((fx as any).stimulusId ?? "").toLowerCase();
      if (!k) continue;
      if (!byImage.has(k)) byImage.set(k, []);
      byImage.get(k)!.push(fx);
    }
  }
  console.log(`participant logs: ${logs}`);

  const rows: Array<{ image: string; method: string; auc: number; nss: number; cc: number }> = [];
  const extractStats: Array<Record<string, number | string>> = [];
  let n = 0, skippedNoFix = 0, skippedGrid = 0, skippedErr = 0;

  for (const st of corpus.stimuli) {
    if (n >= limit) break;
    const key = basename(st.imagePath).replace(/\.[^.]+$/, "").toLowerCase();
    if (!webNames.has(key)) continue;
    const fx = byImage.get(key);
    if (!fx?.length) { skippedNoFix++; continue; }

    try {
      const sal = await computeLabSaliency(st.imagePath, CELL);
      const pts = toGrid(fx, sal.rows, sal.cols);
      if (!pts.length) { skippedNoFix++; continue; }

      const ex = await extractElements(st.imagePath);
      const scaled = scaleEls(ex.elements, IMG_SCALE);
      const vw = ex.width * IMG_SCALE, vh = ex.height * IMG_SCALE;

      const typed = await analyzeAttentionFromDOM(vw, vh, scaled, persona, CELL);
      const flat = await analyzeAttentionFromDOM(vw, vh, stripTypes(scaled), persona, CELL);
      // NOT `scaled`. `analyzeAttention` hands `computeLabSaliency`'s width/height
      // to buildSemanticMap, and those are the ORIGINAL image dims -- it halves
      // internally and doubles cellSize on the way out. So this path wants
      // FULL-resolution element coordinates, exactly like production's
      // getBoundingClientRect values. The first version of this file passed
      // `scaled` here and crushed every element into the top-left quadrant
      // (centre of mass 0.23,0.21 instead of 0.49,0.45), which produced a
      // perfectly plausible Blend arm that was measuring the wrong geometry.
      // `analyzeAttentionFromDOM` above is different: it takes the viewport dims
      // as arguments, so scaled elements + scaled dims are self-consistent there.
      const blend = await analyzeAttention(st.imagePath, persona, CELL, undefined, ex.elements);

      // A grid mismatch would silently compare maps of different shapes. Skip and
      // count rather than resample -- a resampled arm is a different arm.
      const shapeOk = (m: { rows: number; cols: number }) => m.rows === sal.rows && m.cols === sal.cols;
      if (!shapeOk(typed.saliencyMap) || !shapeOk(flat.saliencyMap) || !shapeOk(blend.saliencyMap)) {
        skippedGrid++;
        continue;
      }

      const gt = new Float64Array(sal.rows * sal.cols);
      for (const p of pts) gt[p.y * sal.cols + p.x] += 1;
      const gtGrid: SaliencyGrid = { values: gt, width: sal.cols, height: sal.rows };
      const g = (cells: Float64Array): SaliencyGrid => ({ values: cells, width: sal.cols, height: sal.rows });

      for (const [m, grid] of [
        ["Semantic_typed", g(typed.saliencyMap.cells)],
        ["Semantic_flat", g(flat.saliencyMap.cells)],
        [SHIPPED_ARM, g(blend.saliencyMap.cells)],
        ["Shipped_LabSaliency", g(sal.cells)],
        ["CenterBias", centerBias(sal.rows, sal.cols)],
        ["Uniform", uniform(sal.rows, sal.cols)],
      ] as Array<[string, SaliencyGrid]>) {
        rows.push({
          image: key, method: m,
          auc: computeAUCJudd(grid, pts).auc,
          nss: computeNSS(grid, pts).nss,
          cc: computeCC(grid, gtGrid),
        });
      }

      extractStats.push({
        image: key, words: ex.stats.words, lines: ex.stats.lines,
        ...Object.fromEntries(Object.entries(ex.stats.byType).map(([k, v]) => [`n_${k}`, v])),
      });

      n++;
      if (n % 25 === 0) console.log(`  ${n} scored`);
    } catch (e) {
      skippedErr++;
      console.warn(`  skip ${key}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  const summary: Record<string, { auc: number; nss: number; cc: number; n: number }> = {};
  for (const r of rows) {
    const s = (summary[r.method] ??= { auc: 0, nss: 0, cc: 0, n: 0 });
    s.auc += r.auc; s.nss += r.nss; s.cc += r.cc; s.n++;
  }
  for (const s of Object.values(summary)) { s.auc /= s.n; s.nss /= s.n; s.cc /= s.n; }

  const byImg = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (!byImg.has(r.image)) byImg.set(r.image, {});
    byImg.get(r.image)![r.method] = r.auc;
  }
  const pairRate = (a: string, b: string) => {
    let w = 0, p = 0, d = 0;
    for (const m of byImg.values()) if (m[a] != null && m[b] != null) { p++; d += m[a] - m[b]; if (m[a] > m[b]) w++; }
    return { wins: w, pairs: p, rate: p ? w / p : 0, mean_delta: p ? d / p : 0 };
  };

  const paired = {
    typed_beats_flat: pairRate("Semantic_typed", "Semantic_flat"),
    typed_beats_centerbias: pairRate("Semantic_typed", "CenterBias"),
    typed_beats_shipped: pairRate("Semantic_typed", "Shipped_LabSaliency"),
    blend_beats_centerbias: pairRate(SHIPPED_ARM, "CenterBias"),
    blend_beats_shipped: pairRate(SHIPPED_ARM, "Shipped_LabSaliency"),
    shipped_beats_centerbias: pairRate("Shipped_LabSaliency", "CenterBias"),
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "semantic_summary.json"), JSON.stringify({
    ran: new Date().toISOString(),
    scope: "UEyes web category only",
    persona, images: n,
    skipped: { no_fixations: skippedNoFix, grid_mismatch: skippedGrid, error: skippedErr },
    elements_from: "ocr-extract.ts (tesseract 5.3.4 + sharp; no model)",
    summary, paired,
  }, null, 2));
  writeFileSync(join(outDir, "semantic_per_image.csv"),
    "image,method,auc,nss,cc\n" + rows.map((r) => `${r.image},${r.method},${r.auc.toFixed(6)},${r.nss.toFixed(6)},${r.cc.toFixed(6)}`).join("\n"));
  writeFileSync(join(outDir, "extraction_stats.csv"),
    (extractStats.length ? Object.keys(extractStats[0]).join(",") + "\n" : "") +
    extractStats.map((s) => Object.values(s).join(",")).join("\n"));

  console.log("\n" + "-".repeat(66));
  console.log(`${"arm".padEnd(22)}${"AUC".padStart(9)}${"NSS".padStart(9)}${"CC".padStart(9)}${"n".padStart(6)}`);
  for (const [k, s] of Object.entries(summary).sort((a, b) => b[1].auc - a[1].auc))
    console.log(`${k.padEnd(22)}${s.auc.toFixed(4).padStart(9)}${s.nss.toFixed(4).padStart(9)}${s.cc.toFixed(4).padStart(9)}${String(s.n).padStart(6)}`);
  console.log("-".repeat(66));
  for (const [k, v] of Object.entries(paired))
    console.log(`${k.padEnd(26)} ${v.wins}/${v.pairs} (${(v.rate * 100).toFixed(1)}%)  mean delta ${v.mean_delta >= 0 ? "+" : ""}${v.mean_delta.toFixed(4)}`);
  console.log(`\nscored ${n} web stimuli; skipped: ${skippedNoFix} no-fixations, ${skippedGrid} grid-mismatch, ${skippedErr} error`);
  console.log(`wrote ${outDir}`);
  void existsSync;
}

main().catch((e) => { console.error(e); process.exit(1); });
