/**
 * Fit the attention model's free parameters jointly, with nested cross-validation.
 *
 * Items 1-3 of the improvement list, done together rather than in sequence,
 * because they interact: the best smoothing depends on whether a spatial prior
 * is absorbing the same signal, and the best blend weight depends on both.
 * Fitting them one at a time and stacking the winners overfits three times.
 *
 * Free parameters:
 *   blend w        visual share of the blend (currently 0.05, swept 2026-08-04)
 *   sigma          Gaussian smoothing of the final map, in grid cells
 *   priorStrength  how much of a fitted spatial prior to multiply in
 *   typeWeights    the 5 live ELEMENT_TYPE_WEIGHTS entries, learned
 *
 * ## Why a spatial prior is the interesting one
 *
 * cbrowser has none. A centred Gaussian scores 0.6493 on this corpus against the
 * model's 0.6567 -- the baseline is within 0.007 of the product, which means the
 * model has largely rediscovered "content sits in the middle" and added little
 * else. Every competitive saliency model since Judd 2009 multiplies in a learned
 * position prior; it is the cheapest known gain in this literature. Here the
 * prior is FITTED FROM TRAINING FIXATIONS ONLY, never from the held-out fold.
 *
 * ## Nested CV, and why it is not optional
 *
 * Outer 5 folds hold out a test set. Inside each outer fold, the prior is
 * estimated and every parameter fitted by coordinate ascent on the training
 * images alone. The reported number is mean AUC on outer-fold test images the
 * fit never saw. The in-sample number is printed beside it; the gap between them
 * IS the overfitting, made visible rather than assumed away.
 *
 * ## What this does NOT do
 *
 * It does not make the product predict abandonment. `cognitive_effort` and
 * `site_cognitive_assessment` read `pageMetrics.visualComplexity`, which is
 * `logScale(uniqueColors*3 + imageCount*2 + visibleCount*0.5, 200)` -- a counting
 * function. No saliency map reaches the cognitive-transport chain. Everything
 * fitted here improves `attention_analysis`, `transport_map`, `empathy_audit`'s
 * perceptual score and `visual_cognitive_story`, and nothing else.
 *
 * Usage:
 *   bun research/study1/run-optimize.ts [--limit N] [--rounds N]
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import {
  computeLabSaliency, buildSemanticMap, applyPersonaFilter,
} from "../../src/visual/attention-transport.js";
import { getPerceptualProfile } from "../../src/visual/perceptual-transport.js";
import { computeAUCJudd, type SaliencyGrid, type Fixation } from "../../src/visual/saliency-metrics.js";
import { loadUEyesCorpus, parseGazepointLog, type RawFixation } from "../../src/visual/fixation-corpus.js";
import { extractElements } from "./ocr-extract.js";

const ROOT = join(import.meta.dir, "UEyes_dataset");
const CELL = 16;
const PERSONA = "first-timer";
const CACHE = join(import.meta.dir, ".cache-features.json");
/** The live entries in ELEMENT_TYPE_WEIGHTS that this extractor can actually produce. */
const TYPES = ["cta", "heading", "navigation", "content", "image"] as const;
const SHIPPED_W: Record<string, number> = { cta: 1.0, heading: 0.8, navigation: 0.4, content: 0.2, image: 0.5 };

interface Feature {
  key: string;
  rows: number; cols: number; width: number; height: number;
  sal: number[];
  elements: any[];
  pts: Array<{ x: number; y: number }>;
}

interface Params {
  w: number; sigma: number; priorStrength: number; tw: Record<string, number>;
}

function smooth(m: Float64Array, rows: number, cols: number, s: number): Float64Array {
  if (s <= 0) return m;
  const rad = Math.ceil(s * 3), inv = 1 / (2 * s * s), k: number[] = [];
  for (let d = -rad; d <= rad; d++) k.push(Math.exp(-d * d * inv));
  const t = new Float64Array(m.length), o = new Float64Array(m.length);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let sm = 0, wt = 0;
    for (let d = -rad; d <= rad; d++) { const cc = c + d; if (cc < 0 || cc >= cols) continue; sm += m[r * cols + cc] * k[d + rad]; wt += k[d + rad]; }
    t[r * cols + c] = sm / wt;
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let sm = 0, wt = 0;
    for (let d = -rad; d <= rad; d++) { const rr = r + d; if (rr < 0 || rr >= rows) continue; sm += t[rr * cols + c] * k[d + rad]; wt += k[d + rad]; }
    o[r * cols + c] = sm / wt;
  }
  return o;
}

function blend(vis: Float64Array, sem: Float64Array, w: number): Float64Array {
  const o = new Float64Array(vis.length);
  for (let i = 0; i < vis.length; i++) o[i] = vis[i] * w + sem[i] * (1 - w);
  let mx = 0.001;
  for (let i = 0; i < o.length; i++) if (o[i] > mx) mx = o[i];
  for (let i = 0; i < o.length; i++) o[i] /= mx;
  return o;
}

/**
 * Spatial prior fitted from TRAINING fixations only, on a normalised grid so
 * images of differing aspect ratio pool correctly. Smoothed and floored so a
 * cell that happened to receive no training fixation cannot zero out a
 * prediction on the test fold.
 */
function fitPrior(train: Feature[], rows: number, cols: number): Float64Array {
  const p = new Float64Array(rows * cols);
  for (const f of train) {
    for (const pt of f.pts) {
      const r = Math.min(rows - 1, Math.floor((pt.y / f.rows) * rows));
      const c = Math.min(cols - 1, Math.floor((pt.x / f.cols) * cols));
      p[r * cols + c] += 1;
    }
  }
  const sm = smooth(p, rows, cols, 1.5);
  let mx = 0;
  for (const v of sm) if (v > mx) mx = v;
  if (mx <= 0) return new Float64Array(rows * cols).fill(1);
  for (let i = 0; i < sm.length; i++) sm[i] = 0.05 + 0.95 * (sm[i] / mx);
  return sm;
}

function scoreOne(f: Feature, p: Params, prior: Float64Array, priorRows: number, priorCols: number, ctx: any): number {
  const sal = Float64Array.from(f.sal);
  const sem = buildSemanticMap(
    f.elements, f.rows, f.cols, CELL, f.width, f.height,
    PERSONA, undefined, ctx.traits, ctx.values, undefined, p.tw,
  );
  let m = applyPersonaFilter(blend(sal, sem, p.w), f.rows, f.cols, ctx.profile.visualFilter, ctx.values);
  m = smooth(m, f.rows, f.cols, p.sigma);
  if (p.priorStrength > 0) {
    const out = new Float64Array(m.length);
    for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) {
      const pr = prior[Math.min(priorRows - 1, Math.floor((r / f.rows) * priorRows)) * priorCols
        + Math.min(priorCols - 1, Math.floor((c / f.cols) * priorCols))];
      out[r * f.cols + c] = m[r * f.cols + c] * (1 - p.priorStrength + p.priorStrength * pr);
    }
    m = out;
  }
  const g: SaliencyGrid = { values: m, width: f.cols, height: f.rows };
  return computeAUCJudd(g, f.pts as Fixation[]).auc;
}

const meanScore = (fs: Feature[], p: Params, prior: Float64Array, pr: number, pc: number, ctx: any) =>
  fs.reduce((s, f) => s + scoreOne(f, p, prior, pr, pc, ctx), 0) / (fs.length || 1);

async function buildCache(limit: number): Promise<Feature[]> {
  if (existsSync(CACHE)) {
    const c = JSON.parse(readFileSync(CACHE, "utf8")) as Feature[];
    if (c.length >= Math.min(limit, 400)) { console.log(`cache hit: ${c.length} images`); return c.slice(0, limit); }
  }
  const corpus = loadUEyesCorpus(ROOT);
  if (!corpus) throw new Error("corpus not loadable");
  const web = new Set<string>();
  for (const l of readFileSync(join(ROOT, "image_types.csv"), "utf8").split("\n").slice(1)) {
    const [n, c] = l.split(";");
    if (c?.trim() === "web") web.add(n.trim().replace(/\.[^.]+$/, "").toLowerCase());
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
  const out: Feature[] = [];
  for (const st of corpus.stimuli) {
    if (out.length >= limit) break;
    const key = basename(st.imagePath).replace(/\.[^.]+$/, "").toLowerCase();
    if (!web.has(key)) continue;
    const fx = byImage.get(key);
    if (!fx?.length) continue;
    try {
      const sal = await computeLabSaliency(st.imagePath, CELL);
      const pts: Array<{ x: number; y: number }> = [];
      for (const f of fx) {
        const c = Math.floor((f as any).xNorm * sal.cols), r = Math.floor((f as any).yNorm * sal.rows);
        if (r >= 0 && r < sal.rows && c >= 0 && c < sal.cols) pts.push({ x: c, y: r });
      }
      if (!pts.length) continue;
      const ex = await extractElements(st.imagePath);
      out.push({
        key, rows: sal.rows, cols: sal.cols, width: sal.width, height: sal.height,
        sal: Array.from(sal.cells), elements: ex.elements, pts,
      });
      if (out.length % 50 === 0) console.log(`  cached ${out.length}`);
    } catch (e) { console.warn(`  skip ${key}: ${(e as Error).message.slice(0, 80)}`); }
  }
  writeFileSync(CACHE, JSON.stringify(out));
  console.log(`cached ${out.length} images -> ${CACHE}`);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const limit = arg("--limit") ? Number(arg("--limit")) : Infinity;
  const rounds = arg("--rounds") ? Number(arg("--rounds")) : 3;
  const freezeTypes = args.includes("--freeze-types");
  const outDir = arg("--out") ?? join(import.meta.dir, "results/2026-08-04_optimize");

  if (args.includes("--emit-prior")) {
    const fs2 = await buildCache(limit);
    const pr = fitPrior(fs2, 12, 16);
    const rowsOut: string[] = [];
    for (let r = 0; r < 12; r++) rowsOut.push("  " + Array.from(pr.slice(r * 16, r * 16 + 16)).map((v) => v.toFixed(4)).join(", ") + ",");
    console.log("PRIOR_12x16 = [\n" + rowsOut.join("\n") + "\n];");
    return;
  }
  const feats = await buildCache(limit);
  console.log(`optimizing over ${feats.length} images, ${rounds} coordinate-ascent rounds`);

  const { resolveValuesForPersona } = await import("../../src/values/index.js");
  const { getAnyPersona, getCognitiveProfile } = await import("../../src/personas.js");
  const pv = resolveValuesForPersona(PERSONA);
  const ctx = {
    profile: getPerceptualProfile(PERSONA),
    values: pv ? {
      selfDirection: pv.selfDirection, stimulation: pv.stimulation, hedonism: pv.hedonism,
      achievement: pv.achievement, power: pv.power, security: pv.security,
      conformity: pv.conformity, tradition: pv.tradition, benevolence: pv.benevolence,
      universalism: pv.universalism,
    } : undefined,
    traits: (() => { const o = getAnyPersona(PERSONA); return o ? getCognitiveProfile(o as any).traits as any : undefined; })(),
  };

  const PR_ROWS = 12, PR_COLS = 16;
  const GRID = {
    w: [0, 0.025, 0.05, 0.1, 0.15, 0.2],
    sigma: [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0],
    priorStrength: [0, 0.2, 0.4, 0.6, 0.8, 1.0],
    tw: [0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0],
  };

  /** Coordinate ascent on the training set only. */
  function fit(train: Feature[], prior: Float64Array): Params {
    const p: Params = { w: 0.05, sigma: 0, priorStrength: 0, tw: { ...SHIPPED_W } };
    let best = meanScore(train, p, prior, PR_ROWS, PR_COLS, ctx);
    for (let r = 0; r < rounds; r++) {
      for (const key of ["w", "sigma", "priorStrength"] as const) {
        for (const v of GRID[key]) {
          const cand = { ...p, tw: { ...p.tw }, [key]: v } as Params;
          const s = meanScore(train, cand, prior, PR_ROWS, PR_COLS, ctx);
          if (s > best) { best = s; (p as any)[key] = v; }
        }
      }
      // --freeze-types holds ELEMENT_TYPE_WEIGHTS at the shipped table.
      //
      // Needed because the parameters interact. The unfrozen fit chose w=0.2
      // JOINTLY with a learned type table, and that table is not being shipped:
      // it was fitted on free-viewing data and inverts the product's model
      // (content 0.2 -> 1.0, image 0.5 -> 0.05, cta 1.0 -> 0.4), which is what
      // people do when they have no task. Carrying w=0.2 over to a build that
      // keeps the shipped weights would be importing half of an optimum.
      if (!freezeTypes) {
        for (const t of TYPES) {
          for (const v of GRID.tw) {
            const cand = { ...p, tw: { ...p.tw, [t]: v } };
            const s = meanScore(train, cand, prior, PR_ROWS, PR_COLS, ctx);
            if (s > best) { best = s; p.tw[t] = v; }
          }
        }
      }
      console.log(`    round ${r + 1}: train AUC ${best.toFixed(4)}  w=${p.w} sigma=${p.sigma} prior=${p.priorStrength} tw=${TYPES.map((t) => p.tw[t]).join("/")}`);
    }
    return p;
  }

  const all = feats.map((_, i) => i);
  const heldOut: number[] = [], inSample: number[] = [], chosen: Params[] = [];
  for (let f = 0; f < 5; f++) {
    console.log(`\n  outer fold ${f + 1}/5`);
    const tr = all.filter((i) => i % 5 !== f).map((i) => feats[i]);
    const te = all.filter((i) => i % 5 === f).map((i) => feats[i]);
    const prior = fitPrior(tr, PR_ROWS, PR_COLS);
    const p = fit(tr, prior);
    chosen.push(p);
    inSample.push(meanScore(tr, p, prior, PR_ROWS, PR_COLS, ctx));
    heldOut.push(meanScore(te, p, prior, PR_ROWS, PR_COLS, ctx));
    console.log(`    held-out AUC ${heldOut[f].toFixed(4)}`);
  }

  // Baseline: today's shipped configuration, scored the same way.
  const priorAll = fitPrior(feats, PR_ROWS, PR_COLS);
  const shipped: Params = { w: 0.05, sigma: 0, priorStrength: 0, tw: { ...SHIPPED_W } };
  const shippedAuc = meanScore(feats, shipped, priorAll, PR_ROWS, PR_COLS, ctx);

  // Ablations at the fold-1 operating point, to attribute the gain.
  const ref = chosen[0];
  const abl: Record<string, number> = {
    full: meanScore(feats, ref, priorAll, PR_ROWS, PR_COLS, ctx),
    no_prior: meanScore(feats, { ...ref, priorStrength: 0 }, priorAll, PR_ROWS, PR_COLS, ctx),
    no_smoothing: meanScore(feats, { ...ref, sigma: 0 }, priorAll, PR_ROWS, PR_COLS, ctx),
    shipped_type_weights: meanScore(feats, { ...ref, tw: { ...SHIPPED_W } }, priorAll, PR_ROWS, PR_COLS, ctx),
  };

  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const out = {
    ran: new Date().toISOString(), images: feats.length, persona: PERSONA,
    shipped_auc: +shippedAuc.toFixed(4),
    nested_cv_heldout_auc: +avg(heldOut).toFixed(4),
    nested_cv_insample_auc: +avg(inSample).toFixed(4),
    optimism_gap: +(avg(inSample) - avg(heldOut)).toFixed(4),
    gain_over_shipped: +(avg(heldOut) - shippedAuc).toFixed(4),
    per_fold_params: chosen,
    ablations: Object.fromEntries(Object.entries(abl).map(([k, v]) => [k, +v.toFixed(4)])),
    note: "Improves attention_analysis / transport_map / empathy_audit only. cognitive_effort reads pageMetrics.visualComplexity, a colour-and-element counter; no saliency map reaches the transport chain.",
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "optimize.json"), JSON.stringify(out, null, 2));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`shipped config (w=0.05, no smoothing, no prior)   AUC ${out.shipped_auc}`);
  console.log(`nested-CV HELD-OUT (the honest number)            AUC ${out.nested_cv_heldout_auc}`);
  console.log(`  in-sample                                      AUC ${out.nested_cv_insample_auc}   optimism ${out.optimism_gap}`);
  console.log(`  gain over shipped                              ${out.gain_over_shipped >= 0 ? "+" : ""}${out.gain_over_shipped}`);
  console.log(`\nablations (fold-1 params, scored on all):`);
  for (const [k, v] of Object.entries(out.ablations)) console.log(`  ${k.padEnd(22)} ${v}`);
  console.log(`\nper-fold selections:`);
  for (const [i, p] of chosen.entries())
    console.log(`  fold ${i + 1}: w=${p.w} sigma=${p.sigma} prior=${p.priorStrength} tw=${TYPES.map((t) => p.tw[t]).join("/")}`);
  console.log(`\nwrote ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Emit the fitted spatial prior as a TypeScript literal for shipping.
 *
 *   bun research/study1/run-optimize.ts --emit-prior
 *
 * Fitted on ALL 495 web stimuli, which is correct for a SHIPPED constant and
 * would be wrong for a reported accuracy. The accuracy figure comes from the
 * nested CV above, where the prior is re-estimated inside each training fold and
 * never sees the held-out images.
 */
export {};
