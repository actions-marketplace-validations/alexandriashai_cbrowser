/**
 * What should the visual/semantic blend weight actually be?
 *
 * `analyzeAttention` hardcodes `blendSaliencyMaps(lab, semantic, 0.35, 0.65)`.
 * Study 1c showed the blend scores WORSE than the semantic map alone (+0.0166
 * AUC for dropping the visual channel, p<0.0001), so the constant is wrong. This
 * finds what it should be -- and first checks whether it means what it says.
 *
 * ## The constant does not name a mixing ratio
 *
 * `blendSaliencyMaps` is a raw weighted sum with no cross-normalisation:
 *
 *     blended[i] = visual[i] * visualWeight + semantic[i] * semanticWeight;
 *
 * Both inputs are p95-normalised to [0,1] individually, so both peak at 1.0 --
 * but their MEAN MASS is not matched, and it varies per page with how much of it
 * the element list covers. Measured on six web stimuli:
 *
 *     9efc81  lab mean 0.270  semantic mean 0.864  -> effective 14% / 86%
 *     5c88b8  lab mean 0.154  semantic mean 0.091  -> effective 48% / 52%
 *
 * Same constant, ratios from 14/86 to 48/52. So "35/65" is a coefficient whose
 * effect floats with element density, not a mixing ratio. Recommending a
 * different number for it would be recommending a different arbitrary
 * coefficient in a scheme that does not control what it claims to.
 *
 * Hence two sweeps:
 *   RAW  -- production's arithmetic, exactly as shipped. Answers "what number
 *           should the existing constant be", taking the mechanism as given.
 *   MASS -- each map divided by its own mean before weighting, so weight w
 *           really is w of the blended mass. Answers "what should it be if the
 *           mechanism is fixed first", and shows what fixing it buys.
 *
 * ## Why cross-validation
 *
 * Picking the argmax of a curve and reporting that same curve's peak is how a
 * tuning parameter becomes an overfit. UEyes ships a Train/Test split but its
 * web slice is 468/27 -- 27 held-out images is too few to estimate a weight
 * from. So: 5-fold CV over all 495. Select w on 4 folds, score it on the 5th,
 * rotate. The reported number is out-of-sample; the in-sample peak is printed
 * beside it so the optimism gap is visible rather than hidden.
 *
 * Usage:
 *   bun research/study1/run-blend-sweep.ts [--limit N] [--persona NAME]
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { readdirSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import {
  computeLabSaliency, buildSemanticMap, applyPersonaFilter,
  type DOMAttentionElement,
} from "../../src/visual/attention-transport.js";
import { getPerceptualProfile } from "../../src/visual/perceptual-transport.js";
import { computeAUCJudd, type SaliencyGrid, type Fixation } from "../../src/visual/saliency-metrics.js";
import { loadUEyesCorpus, parseGazepointLog, type RawFixation } from "../../src/visual/fixation-corpus.js";
import { extractElements } from "./ocr-extract.js";

const ROOT = join(import.meta.dir, "UEyes_dataset");
const CELL = 16;
const IMG_SCALE = 0.5;
/** 0.00 to 1.00 in 0.05 steps. 0.35 is the shipped value and lands on a step. */
const WEIGHTS = Array.from({ length: 21 }, (_, i) => i / 20);
const FOLDS = 5;

function toGrid(fx: RawFixation[], rows: number, cols: number): Fixation[] {
  const out: Fixation[] = [];
  for (const f of fx) {
    const c = Math.floor((f as any).xNorm * cols), r = Math.floor((f as any).yNorm * rows);
    if (r >= 0 && r < rows && c >= 0 && c < cols) out.push({ x: c, y: r });
  }
  return out;
}

function mean(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length || 0;
}

/** Production's arithmetic, lifted verbatim: weighted sum then max-renormalise. */
function blendRaw(vis: Float64Array, sem: Float64Array, w: number): Float64Array {
  const out = new Float64Array(vis.length);
  for (let i = 0; i < vis.length; i++) out[i] = vis[i] * w + sem[i] * (1 - w);
  let mx = 0.001;
  for (let i = 0; i < out.length; i++) if (out[i] > mx) mx = out[i];
  for (let i = 0; i < out.length; i++) out[i] /= mx;
  return out;
}

/** Equal-mass blend: each map contributes exactly its weight's share of total mass. */
function blendMass(vis: Float64Array, sem: Float64Array, w: number): Float64Array {
  const mv = mean(vis) || 1e-9, ms = mean(sem) || 1e-9;
  const out = new Float64Array(vis.length);
  for (let i = 0; i < vis.length; i++) out[i] = (vis[i] / mv) * w + (sem[i] / ms) * (1 - w);
  let mx = 0.001;
  for (let i = 0; i < out.length; i++) if (out[i] > mx) mx = out[i];
  for (let i = 0; i < out.length; i++) out[i] /= mx;
  return out;
}

function scaleEls(els: DOMAttentionElement[], s: number): DOMAttentionElement[] {
  return els.map((e) => ({
    ...e, x: e.x * s, y: e.y * s, width: e.width * s, height: e.height * s,
    words: e.words?.map((w) => ({ ...w, x: w.x * s, y: w.y * s, width: w.width * s, height: w.height * s })),
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const limit = arg("--limit") ? Number(arg("--limit")) : Infinity;
  const persona = arg("--persona") ?? "first-timer";
  const outDir = arg("--out") ?? join(import.meta.dir, "results/2026-08-04_blend-sweep");

  const corpus = loadUEyesCorpus(ROOT);
  if (!corpus) throw new Error("corpus not loadable");

  const webNames = new Set<string>();
  for (const line of readFileSync(join(ROOT, "image_types.csv"), "utf8").split("\n").slice(1)) {
    const [name, cat] = line.split(";");
    if (cat?.trim() === "web") webNames.add(name.trim().replace(/\.[^.]+$/, "").toLowerCase());
  }

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

  // Resolve persona traits/values exactly as analyzeAttention does, so the
  // semantic map under sweep is the one production would build.
  const profile = getPerceptualProfile(persona);
  let values: Record<string, number> | undefined;
  let traits: Record<string, number> | undefined;
  try {
    const { resolveValuesForPersona } = await import("../../src/values/index.js");
    const pv = resolveValuesForPersona(persona);
    if (pv) values = {
      selfDirection: pv.selfDirection, stimulation: pv.stimulation, hedonism: pv.hedonism,
      achievement: pv.achievement, power: pv.power, security: pv.security,
      conformity: pv.conformity, tradition: pv.tradition, benevolence: pv.benevolence,
      universalism: pv.universalism,
    };
  } catch { /* falls back to the static modifier table, as production does */ }
  try {
    const { getAnyPersona, getCognitiveProfile } = await import("../../src/personas.js");
    const p = getAnyPersona(persona);
    if (p) traits = getCognitiveProfile(p as any).traits as unknown as Record<string, number>;
  } catch { /* same */ }

  // aucs[variant][imageIndex][weightIndex]
  const aucs: Record<"raw" | "mass", number[][]> = { raw: [], mass: [] };
  const massRatios: number[] = [];
  const images: string[] = [];
  let n = 0;

  for (const st of corpus.stimuli) {
    if (n >= limit) break;
    const key = basename(st.imagePath).replace(/\.[^.]+$/, "").toLowerCase();
    if (!webNames.has(key)) continue;
    const fx = byImage.get(key);
    if (!fx?.length) continue;

    try {
      const sal = await computeLabSaliency(st.imagePath, CELL);
      const pts = toGrid(fx, sal.rows, sal.cols);
      if (!pts.length) continue;

      const ex = await extractElements(st.imagePath);
      // FULL-RESOLUTION element coordinates, paired with `sal.width/height`.
      //
      // `computeLabSaliency` returns `width`/`height` as the ORIGINAL image dims
      // (1024x768), not the downsampled ones -- it halves internally and doubles
      // `cellSize` on the way out. `buildSemanticMap` derives px-per-cell from
      // the dims it is handed, so passing half-scaled elements alongside
      // full-size dims silently compresses every element into the top-left
      // quadrant: centre of mass moves from (0.49, 0.45) to (0.23, 0.21). It
      // still produces a plausible-looking map and a plausible-looking AUC.
      // Verified by measuring the centre of mass under all three pairings.
      const sem = buildSemanticMap(
        ex.elements,
        sal.rows, sal.cols, CELL, sal.width, sal.height,
        persona, undefined, traits, values, undefined,
      );

      // What fraction of blended mass the visual channel ACTUALLY contributes at
      // the shipped constant, on this page.
      const mv = mean(sal.cells), ms = mean(sem);
      massRatios.push((0.35 * mv) / (0.35 * mv + 0.65 * ms || 1e-9));

      const rowRaw: number[] = [], rowMass: number[] = [];
      for (const w of WEIGHTS) {
        for (const [blend, row] of [[blendRaw, rowRaw], [blendMass, rowMass]] as const) {
          const filtered = applyPersonaFilter(
            blend(sal.cells, sem, w), sal.rows, sal.cols, profile.visualFilter, values,
          );
          const g: SaliencyGrid = { values: filtered, width: sal.cols, height: sal.rows };
          row.push(computeAUCJudd(g, pts).auc);
        }
      }
      aucs.raw.push(rowRaw); aucs.mass.push(rowMass); images.push(key);

      n++;
      if (n % 50 === 0) console.log(`  ${n} swept`);
    } catch (e) {
      console.warn(`  skip ${key}: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  const colMean = (m: number[][], wi: number, idx: number[]) =>
    idx.reduce((s, i) => s + m[i][wi], 0) / idx.length;

  const report: Record<string, unknown> = { images: n, weights: WEIGHTS, persona };

  for (const variant of ["raw", "mass"] as const) {
    const m = aucs[variant];
    const all = m.map((_, i) => i);
    const curve = WEIGHTS.map((_, wi) => colMean(m, wi, all));
    const inSampleBest = curve.indexOf(Math.max(...curve));

    // 5-fold CV. Deterministic assignment (i % FOLDS) -- no RNG, so the run is
    // reproducible and nothing here depends on Math.random.
    const picks: number[] = [], heldOut: number[] = [];
    for (let f = 0; f < FOLDS; f++) {
      const train = all.filter((i) => i % FOLDS !== f);
      const test = all.filter((i) => i % FOLDS === f);
      const tc = WEIGHTS.map((_, wi) => colMean(m, wi, train));
      const pick = tc.indexOf(Math.max(...tc));
      picks.push(WEIGHTS[pick]);
      heldOut.push(colMean(m, pick, test));
    }
    const cvAuc = heldOut.reduce((a, b) => a + b, 0) / FOLDS;

    report[variant] = {
      curve: curve.map((v) => +v.toFixed(4)),
      in_sample_best_w: WEIGHTS[inSampleBest],
      in_sample_best_auc: +curve[inSampleBest].toFixed(4),
      cv_selected_w: picks,
      cv_heldout_auc: +cvAuc.toFixed(4),
      optimism_gap: +(curve[inSampleBest] - cvAuc).toFixed(4),
      auc_at_shipped_035: +curve[WEIGHTS.indexOf(0.35)].toFixed(4),
      auc_at_zero: +curve[0].toFixed(4),
    };

    console.log(`\n=== ${variant.toUpperCase()} blend (w = visual share) ===`);
    for (let i = 0; i < WEIGHTS.length; i += 2)
      console.log(`  w=${WEIGHTS[i].toFixed(2)}  AUC ${curve[i].toFixed(4)}${WEIGHTS[i] === 0.35 ? "   <- shipped" : ""}${i === inSampleBest ? "   <- in-sample peak" : ""}`);
    console.log(`  in-sample peak w=${WEIGHTS[inSampleBest].toFixed(2)} AUC ${curve[inSampleBest].toFixed(4)}`);
    console.log(`  5-fold CV: picked ${picks.map((p) => p.toFixed(2)).join(", ")}  held-out AUC ${cvAuc.toFixed(4)}  optimism ${(curve[inSampleBest] - cvAuc).toFixed(4)}`);
  }

  const mr = massRatios.sort((a, b) => a - b);
  report.effective_visual_share_at_shipped_constant = {
    min: +mr[0].toFixed(3), p25: +mr[Math.floor(mr.length * 0.25)].toFixed(3),
    median: +mr[Math.floor(mr.length * 0.5)].toFixed(3),
    p75: +mr[Math.floor(mr.length * 0.75)].toFixed(3), max: +mr[mr.length - 1].toFixed(3),
  };
  console.log(`\n=== what "0.35" actually mixes, per page (visual share of blended mass) ===`);
  console.log(`  min ${mr[0].toFixed(3)}  p25 ${mr[Math.floor(mr.length * .25)].toFixed(3)}  median ${mr[Math.floor(mr.length * .5)].toFixed(3)}  p75 ${mr[Math.floor(mr.length * .75)].toFixed(3)}  max ${mr[mr.length - 1].toFixed(3)}`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "blend_sweep.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "blend_per_image.csv"),
    "image,variant," + WEIGHTS.map((w) => `w${w.toFixed(2)}`).join(",") + "\n" +
    images.flatMap((img, i) => (["raw", "mass"] as const).map((v) =>
      `${img},${v},${aucs[v][i].map((x) => x.toFixed(6)).join(",")}`)).join("\n"));
  console.log(`\nwrote ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
