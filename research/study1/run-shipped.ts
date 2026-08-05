/**
 * Study 1, scored from the shipped code.
 *
 * The published benchmark ran research/study1/cot_saliency.py, whose own docstring
 * calls it a "vectorized Python port of computeLabSaliency()". The port had already
 * diverged the day the numbers were written -- the TypeScript weights chrominance 3x
 * (wA = wB = 3.0), the port summed the Lab channels flat -- so the published accuracy
 * described a program nobody shipped. The July re-run established that and reversed the
 * result: center bias beat the model.
 *
 * The CTC arm still has the same defect. correlate_ctc_fixations.py is labelled, in its
 * own header, a "Python port of cognitive-transport-chain.ts". That matters right now
 * for a specific reason: the transport chain was recalibrated on 2026-08-03 and 08-04
 * (the readingAttention demand base moved from textDensity to max(textDensity,
 * informationDensity); the capacity bridge reached every scoring path). NONE of that
 * exists in a Python file written in July. Re-running the port after a recalibration
 * measures the port, and reports it as though it measured the change.
 *
 * So this runner calls the real functions:
 *   computeLabSaliency        src/visual/attention-transport.ts   (the saliency arm)
 *   computeAUCJudd / NSS / CC src/visual/saliency-metrics.ts      (the scorer)
 *   loadUEyesCorpus / parseGazepointLog                           (real fixation points)
 *   computeDemandDistribution src/visual/cognitive-transport-chain.ts  (the CTC arm)
 *
 * Two baselines, because a saliency claim on web stimuli that has not cleared center
 * bias has not cleared anything: layouts are top-and-center by convention, viewers start
 * centered, and a screenshot cannot scroll.
 *
 * Usage:
 *   bun research/study1/run-shipped.ts [--limit N] [--out DIR]
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { computeLabSaliency } from "../../src/visual/attention-transport.js";
import { computeAUCJudd, computeNSS, computeCC, type SaliencyGrid, type Fixation } from "../../src/visual/saliency-metrics.js";
import { loadUEyesCorpus, parseGazepointLog, type RawFixation } from "../../src/visual/fixation-corpus.js";
import { computeDemandDistribution } from "../../src/visual/cognitive-transport-chain.js";

const ROOT = join(import.meta.dir, "UEyes_dataset");
const CELL = 16;

interface Row {
  image: string;
  method: string;
  auc: number;
  nss: number;
  cc: number;
  fixations: number;
}

/** Center-bias baseline: a Gaussian at the middle of the frame, nothing else. */
function centerBias(rows: number, cols: number): SaliencyGrid {
  const cells = new Float64Array(rows * cols);
  const cy = (rows - 1) / 2, cx = (cols - 1) / 2;
  const sy = rows / 4, sx = cols / 4;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dy = (r - cy) / sy, dx = (c - cx) / sx;
      cells[r * cols + c] = Math.exp(-0.5 * (dy * dy + dx * dx));
    }
  }
  return { values: cells, width: cols, height: rows };
}

/** Uniform baseline. Scores 0.5 AUC by construction; present as a sanity floor. */
function uniform(rows: number, cols: number): SaliencyGrid {
  return { values: new Float64Array(rows * cols).fill(1), width: cols, height: rows };
}

/**
 * Fixations are stored NORMALISED (xNorm/yNorm in 0..1), so the grid cell comes
 * straight from the fraction. Multiplying by image pixels first, as an earlier
 * version did, silently produced zero in-bounds points.
 */
function toGrid(fx: RawFixation[], rows: number, cols: number): Fixation[] {
  const out: Fixation[] = [];
  for (const f of fx) {
    const c = Math.floor((f as any).xNorm * cols);
    const r = Math.floor((f as any).yNorm * rows);
    if (r >= 0 && r < rows && c >= 0 && c < cols) out.push({ x: c, y: r });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
  const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(import.meta.dir, "results/2026-08-04_shipped");

  const corpus = loadUEyesCorpus(ROOT);
  if (!corpus) throw new Error(`UEyes corpus not loadable at ${ROOT}`);
  console.log(`corpus: ${corpus.stimuli.length} stimuli`);

  // Fixations, grouped by stimulus, from the raw participant logs. The published run
  // thresholded a Gaussian-smoothed density image instead, which marked 18.8% of all
  // pixels as "a fixation" -- AUC-Judd is defined over discrete points.
  const logDir = join(ROOT, "eyetracker_logs");
  const byImage = new Map<string, RawFixation[]>();
  let logs = 0;
  if (existsSync(logDir)) {
    for (const f of readdirSync(logDir)) {
      if (!f.endsWith(".csv") || f.startsWith("._")) continue;
      logs++;
      for (const fx of parseGazepointLog(join(logDir, f))) {
        const key = String((fx as any).stimulusId ?? "").toLowerCase();
        if (!key) continue;
        if (!byImage.has(key)) byImage.set(key, []);
        byImage.get(key)!.push(fx);
      }
    }
  }
  console.log(`participant logs: ${logs}, stimuli with fixations: ${byImage.size}`);

  const rows: Row[] = [];
  const ctc: Array<Record<string, number | string>> = [];
  let n = 0;

  for (const st of corpus.stimuli) {
    if (n >= limit) break;
    const key = basename(st.imagePath).replace(/\.[^.]+$/, "").toLowerCase();
    const fx = byImage.get(key);
    if (!fx || fx.length === 0) continue;

    let sal;
    try {
      sal = await computeLabSaliency(st.imagePath, CELL);
    } catch (e) {
      console.warn(`  skip ${key}: ${(e as Error).message}`);
      continue;
    }
    const grid: SaliencyGrid = { values: sal.cells, width: sal.cols, height: sal.rows };
    const pts = toGrid(fx, sal.rows, sal.cols);
    if (pts.length === 0) continue;

    // Ground-truth grid for CC: fixation counts per cell.
    const gt = new Float64Array(sal.rows * sal.cols);
    for (const p of pts) gt[p.y * sal.cols + p.x] += 1;
    const gtGrid: SaliencyGrid = { values: gt, width: sal.cols, height: sal.rows };

    for (const [method, g] of [
      ["Shipped_LabSaliency", grid],
      ["CenterBias", centerBias(sal.rows, sal.cols)],
      ["Uniform", uniform(sal.rows, sal.cols)],
    ] as const) {
      rows.push({
        image: key,
        method,
        auc: computeAUCJudd(g, pts).auc,
        nss: computeNSS(g, pts).nss,
        cc: computeCC(g, gtGrid),
        fixations: pts.length,
      });
    }

    n++;
    if (n % 50 === 0) console.log(`  ${n} scored`);
  }

  // Aggregate.
  const summary: Record<string, { auc: number; nss: number; cc: number; n: number }> = {};
  for (const r of rows) {
    const s = (summary[r.method] ??= { auc: 0, nss: 0, cc: 0, n: 0 });
    s.auc += r.auc; s.nss += r.nss; s.cc += r.cc; s.n++;
  }
  for (const k of Object.keys(summary)) {
    const s = summary[k];
    s.auc /= s.n; s.nss /= s.n; s.cc /= s.n;
  }

  // Paired comparison against center bias -- the only figure that answers "does the
  // model beat the baseline", as opposed to "are the two means close".
  const byImg = new Map<string, Record<string, Row>>();
  for (const r of rows) {
    if (!byImg.has(r.image)) byImg.set(r.image, {});
    byImg.get(r.image)![r.method] = r;
  }
  let wins = 0, pairs = 0, deltaSum = 0;
  for (const m of byImg.values()) {
    if (!m.Shipped_LabSaliency || !m.CenterBias) continue;
    pairs++;
    const d = m.Shipped_LabSaliency.auc - m.CenterBias.auc;
    deltaSum += d;
    if (d > 0) wins++;
  }

  mkdirSync(outDir, { recursive: true });
  const out = {
    ran: new Date().toISOString(),
    scored_from: "shipped TypeScript (src/visual), not a Python port",
    images: n,
    participant_logs: logs,
    summary,
    paired_vs_centerbias: {
      pairs,
      model_wins: wins,
      model_win_rate: pairs ? wins / pairs : 0,
      mean_auc_delta: pairs ? deltaSum / pairs : 0,
    },
  };
  writeFileSync(join(outDir, "saliency_summary.json"), JSON.stringify(out, null, 2));
  writeFileSync(
    join(outDir, "saliency_per_image.csv"),
    "image,method,auc,nss,cc,fixations\n" +
      rows.map((r) => `${r.image},${r.method},${r.auc.toFixed(6)},${r.nss.toFixed(6)},${r.cc.toFixed(6)},${r.fixations}`).join("\n"),
  );

  console.log("\n" + "─".repeat(64));
  console.log(`${"method".padEnd(24)}${"AUC".padStart(8)}${"NSS".padStart(9)}${"CC".padStart(9)}`);
  for (const [k, s] of Object.entries(summary).sort((a, b) => b[1].auc - a[1].auc)) {
    console.log(`${k.padEnd(24)}${s.auc.toFixed(4).padStart(8)}${s.nss.toFixed(4).padStart(9)}${s.cc.toFixed(4).padStart(9)}`);
  }
  console.log("─".repeat(64));
  console.log(`paired vs CenterBias: model wins ${wins}/${pairs} (${((wins / Math.max(1, pairs)) * 100).toFixed(1)}%), mean AUC delta ${(deltaSum / Math.max(1, pairs)).toFixed(4)}`);
  console.log(`\nwrote ${outDir}`);
  void ctc; void statSync;
}

main().catch((e) => { console.error(e); process.exit(1); });
