/**
 * The inter-observer ceiling: how well do humans predict each other?
 *
 * Every accuracy number this project has produced is unanchored without this.
 * "0.6567 AUC" means nothing until you know whether the achievable maximum is
 * 0.70 or 0.95. It is the standard upper bound in saliency research (Judd et al.
 * 2009 / Bylinskii et al. 2019) and it is the number that decides whether more
 * modelling effort is worth spending.
 *
 * Method: split the 62 participants into two halves by participant id. Build a
 * fixation-density map from half A. Score it, with the identical AUC-Judd code
 * every other arm uses, against half B's discrete fixation points. That is a
 * REAL model -- 31 actual humans looking at the actual page -- so whatever it
 * scores is roughly the best any model of "the average viewer" can do.
 *
 * Two controls run beside it, because a ceiling that is not sanity-checked is
 * just another number:
 *   - the same half-A map scored against half A's OWN points (an upper-upper
 *     bound; it is fit to its own data and must score higher)
 *   - CenterBias on the same half-B points (so the ceiling and the baseline are
 *     measured against the identical ground truth, not across runs)
 *
 * Usage:
 *   bun research/study1/run-ceiling.ts [--limit N]
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { readdirSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { computeAUCJudd, computeNSS, type SaliencyGrid, type Fixation } from "../../src/visual/saliency-metrics.js";
import { parseGazepointLog, type RawFixation } from "../../src/visual/fixation-corpus.js";

const ROOT = join(import.meta.dir, "UEyes_dataset");
/** Matches the 24x32 grid every other arm scores on (1024x768 at 32px/cell). */
const ROWS = 24, COLS = 32;
/** Gaussian sigma in cells for the density map built from half A. */
const SIGMA = 1.5;

function toGrid(fx: RawFixation[]): Fixation[] {
  const out: Fixation[] = [];
  for (const f of fx) {
    const c = Math.floor((f as any).xNorm * COLS), r = Math.floor((f as any).yNorm * ROWS);
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) out.push({ x: c, y: r });
  }
  return out;
}

/** Fixation density with a Gaussian kernel -- what a "human model" looks like. */
function densityMap(pts: Fixation[]): Float64Array {
  const m = new Float64Array(ROWS * COLS);
  const rad = Math.ceil(SIGMA * 3), inv = 1 / (2 * SIGMA * SIGMA);
  for (const p of pts) {
    for (let dr = -rad; dr <= rad; dr++) {
      const r = p.y + dr;
      if (r < 0 || r >= ROWS) continue;
      for (let dc = -rad; dc <= rad; dc++) {
        const c = p.x + dc;
        if (c < 0 || c >= COLS) continue;
        m[r * COLS + c] += Math.exp(-(dr * dr + dc * dc) * inv);
      }
    }
  }
  return m;
}

function centerBias(): Float64Array {
  const v = new Float64Array(ROWS * COLS);
  const cy = (ROWS - 1) / 2, cx = (COLS - 1) / 2, sy = ROWS / 4, sx = COLS / 4;
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const dy = (r - cy) / sy, dx = (c - cx) / sx;
      v[r * COLS + c] = Math.exp(-0.5 * (dy * dy + dx * dx));
    }
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
  const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(import.meta.dir, "results/2026-08-04_ceiling");

  const webNames = new Set<string>();
  for (const line of readFileSync(join(ROOT, "image_types.csv"), "utf8").split("\n").slice(1)) {
    const [name, cat] = line.split(";");
    if (cat?.trim() === "web") webNames.add(name.trim().replace(/\.[^.]+$/, "").toLowerCase());
  }

  // Participant id comes from the log filename: XX_hk0YY_fixations.csv -> YY.
  // Splitting by PARTICIPANT, not by fixation, is what makes this a held-out
  // test. Splitting the pooled points at random would let the same person appear
  // on both sides and inflate the ceiling toward 1.0.
  const byImage = new Map<string, Map<string, RawFixation[]>>();
  const participants = new Set<string>();
  for (const f of readdirSync(join(ROOT, "eyetracker_logs"))) {
    if (!f.endsWith(".csv") || f.startsWith("._")) continue;
    const pid = (f.match(/hk0*(\d+)/i)?.[1]) ?? f;
    participants.add(pid);
    for (const fx of parseGazepointLog(join(ROOT, "eyetracker_logs", f))) {
      const k = String((fx as any).stimulusId ?? "").toLowerCase();
      if (!k || !webNames.has(k)) continue;
      if (!byImage.has(k)) byImage.set(k, new Map());
      const m = byImage.get(k)!;
      if (!m.has(pid)) m.set(pid, []);
      m.get(pid)!.push(fx);
    }
  }
  const pids = [...participants].sort();
  const halfA = new Set(pids.filter((_, i) => i % 2 === 0));
  console.log(`participants: ${pids.length} (half A = ${halfA.size}), web stimuli with fixations: ${byImage.size}`);

  const cb = centerBias();
  const acc = { ceiling: [] as number[], selfFit: [] as number[], center: [] as number[],
                ceilingNss: [] as number[], centerNss: [] as number[] };
  let n = 0, skippedThin = 0;

  for (const [key, perPid] of byImage) {
    if (n >= limit) break;
    const A: RawFixation[] = [], B: RawFixation[] = [];
    for (const [pid, fx] of perPid) (halfA.has(pid) ? A : B).push(...fx);
    const ptsA = toGrid(A), ptsB = toGrid(B);
    // Both sides need enough points for AUC to mean anything.
    if (ptsA.length < 10 || ptsB.length < 10) { skippedThin++; continue; }

    const mapA = densityMap(ptsA);
    const g = (v: Float64Array): SaliencyGrid => ({ values: v, width: COLS, height: ROWS });

    acc.ceiling.push(computeAUCJudd(g(mapA), ptsB).auc);
    acc.ceilingNss.push(computeNSS(g(mapA), ptsB).nss);
    acc.selfFit.push(computeAUCJudd(g(mapA), ptsA).auc);
    acc.center.push(computeAUCJudd(g(cb), ptsB).auc);
    acc.centerNss.push(computeNSS(g(cb), ptsB).nss);
    n++;
    void key;
  }

  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const out = {
    ran: new Date().toISOString(), images: n, skipped_thin: skippedThin,
    participants: pids.length, half_a: halfA.size, sigma_cells: SIGMA,
    human_ceiling_auc: +avg(acc.ceiling).toFixed(4),
    human_ceiling_nss: +avg(acc.ceilingNss).toFixed(4),
    self_fit_auc: +avg(acc.selfFit).toFixed(4),
    centerbias_auc_same_gt: +avg(acc.center).toFixed(4),
    centerbias_nss_same_gt: +avg(acc.centerNss).toFixed(4),
    headroom_over_centerbias: +(avg(acc.ceiling) - avg(acc.center)).toFixed(4),
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "ceiling.json"), JSON.stringify(out, null, 2));

  console.log(`\nHUMAN CEILING (half A predicting half B)   AUC ${out.human_ceiling_auc}   NSS ${out.human_ceiling_nss}`);
  console.log(`  self-fit upper-upper bound (A on A)      AUC ${out.self_fit_auc}`);
  console.log(`  CenterBias on the SAME half-B points     AUC ${out.centerbias_auc_same_gt}   NSS ${out.centerbias_nss_same_gt}`);
  console.log(`  headroom between baseline and ceiling    ${out.headroom_over_centerbias >= 0 ? "+" : ""}${out.headroom_over_centerbias} AUC`);
  console.log(`\nn=${n} web stimuli (${skippedThin} skipped for <10 fixations on a side). Wrote ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
