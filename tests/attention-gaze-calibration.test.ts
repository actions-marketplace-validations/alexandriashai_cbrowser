/**
 * Tests for the foveal smoothing + spatial prior shipped 2026-08-04.
 *
 * Written the same way as `attention-blend-weight.test.ts` and for the same
 * reason: before that file existed, zeroing the semantic channel -- 95% of the
 * model -- left the suite at 1058 pass / 0 fail. Constants in this file are only
 * meaningful if something notices when they stop being used, so every assertion
 * below is behavioural except the two that deliberately pin the fitted values.
 *
 * Provenance of the numbers under test: nested 5-fold CV over 495 UEyes web
 * stimuli against 554 participant logs, all five folds unanimous
 * (`research/study1/run-optimize.ts --freeze-types`). Held-out 0.7367 vs 0.6567
 * for the prior configuration; human inter-observer ceiling 0.8112.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, expect, test } from "bun:test";
import {
  applyGazeCalibration, smoothSaliency, GAZE_CALIBRATION,
} from "../src/visual/attention-transport.js";

const ROWS = 24, COLS = 32;

/** A single hot cell in an otherwise empty map. */
function impulse(r = 12, c = 16): Float64Array {
  const m = new Float64Array(ROWS * COLS);
  m[r * COLS + c] = 1;
  return m;
}

function nonZeroCells(m: Float64Array): number {
  let n = 0;
  for (const v of m) if (v > 1e-9) n++;
  return n;
}

/** Row index of the map's centre of mass, as a 0..1 fraction. */
function comRow(m: Float64Array): number {
  let s = 0, t = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const v = m[r * COLS + c]; s += r * v; t += v; }
  return t > 0 ? s / t / ROWS : 0.5;
}

function comCol(m: Float64Array): number {
  let s = 0, t = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const v = m[r * COLS + c]; s += c * v; t += v; }
  return t > 0 ? s / t / COLS : 0.5;
}

describe("gaze calibration", () => {
  test("fitted operating point is the one the CV selected", () => {
    // All five outer folds picked exactly these. Changing them without re-running
    // run-optimize.ts is the failure this pins.
    expect(GAZE_CALIBRATION.visualWeight).toBe(0.2);
    expect(GAZE_CALIBRATION.sigmaCells).toBe(2.5);
    expect(GAZE_CALIBRATION.spatialPrior).toBe(1.0);
  });

  test("smoothing spreads a point into a neighbourhood", () => {
    // The whole justification: the fovea spans ~35-60px and fixations scatter,
    // so a map with one hot cell is claiming precision the eye does not have.
    const before = impulse();
    expect(nonZeroCells(before)).toBe(1);
    const after = smoothSaliency(before, ROWS, COLS, GAZE_CALIBRATION.sigmaCells);
    expect(nonZeroCells(after)).toBeGreaterThan(50);
    // Mass conserved, not invented: the peak must drop as it spreads.
    expect(Math.max(...after)).toBeLessThan(Math.max(...before));
  });

  test("sigma = 0 is a no-op, so the knob is real", () => {
    const m = impulse();
    expect(Array.from(smoothSaliency(m, ROWS, COLS, 0))).toEqual(Array.from(m));
  });

  test("the spatial prior pulls a flat map up and left", () => {
    // A uniform map has its centre of mass dead centre. After the prior it must
    // move toward the F-pattern peak. This fails if the prior is all-ones, if it
    // is indexed wrongly, or if it is applied with strength 0.
    const flat = new Float64Array(ROWS * COLS).fill(1);
    const out = applyGazeCalibration(flat, ROWS, COLS, 0, 1.0);
    expect(comRow(out)).toBeLessThan(0.45);
    expect(comCol(out)).toBeLessThan(0.48);
  });

  test("prior strength 0 leaves the map alone", () => {
    const flat = new Float64Array(ROWS * COLS).fill(1);
    const out = applyGazeCalibration(flat, ROWS, COLS, 0, 0);
    expect(comRow(out)).toBeCloseTo(0.5, 1);
    expect(Array.from(out)).toEqual(Array.from(flat));
  });

  test("the prior never zeroes a cell", () => {
    // Floored at 0.05 during fitting. A zero here would let a region the corpus
    // happened not to cover veto a real prediction -- silently, since a zeroed
    // cell just looks like "nothing salient there".
    const flat = new Float64Array(ROWS * COLS).fill(1);
    const out = applyGazeCalibration(flat, ROWS, COLS, 0, 1.0);
    for (const v of out) expect(v).toBeGreaterThan(0);
  });

  test("calibration is applied at the defaults, not merely defined", () => {
    // The failure this catches: constants exist, function exists, nobody calls
    // it. Defaults must visibly transform a flat map on both axes at once.
    const flat = new Float64Array(ROWS * COLS).fill(1);
    const out = applyGazeCalibration(flat, ROWS, COLS);
    expect(comRow(out)).toBeLessThan(0.45);
    expect(Array.from(out)).not.toEqual(Array.from(flat));
  });
});

describe("gaze calibration is wired into the public path", () => {
  test("analyzeAttentionFromDOM output carries the prior and the smoothing", async () => {
    // The gap the function-level tests above do NOT close: a correct constant, a
    // correct function, and nobody calling it. This is the exact failure mode
    // that left the blend untested for months, so it gets its own assertion
    // against the PUBLIC entry point rather than the helper.
    const { analyzeAttentionFromDOM } = await import("../src/visual/attention-transport.js");

    // Two identical elements, one top-left and one bottom-right. Symmetric input,
    // so any asymmetry in the output came from the prior.
    const els = [
      { type: "content", x: 40, y: 40, width: 120, height: 40, text: "aaa" },
      { type: "content", x: 360, y: 300, width: 120, height: 40, text: "bbb" },
    ];
    const a = await analyzeAttentionFromDOM(512, 384, els as any, "first-timer", 16);
    const { cells, rows, cols } = a.saliencyMap;

    let topLeft = 0, bottomRight = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const v = cells[r * cols + c];
      if (r < rows / 2 && c < cols / 2) topLeft += v;
      if (r >= rows / 2 && c >= cols / 2) bottomRight += v;
    }
    // The F-pattern prior must favour the upper-left element over the lower-right.
    expect(topLeft).toBeGreaterThan(bottomRight);

    // And smoothing must have spread heat beyond the two element rectangles:
    // two 120x40 boxes on a 32x24 grid cover well under half the cells.
    let nonZero = 0;
    for (const v of cells) if (v > 1e-6) nonZero++;
    expect(nonZero).toBeGreaterThan(rows * cols * 0.5);
  });
});
