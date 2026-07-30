/**
 * Saliency metrics — verified against known analytic answers.
 *
 * These metrics exist to make an accuracy CLAIM, so they are the last place a
 * plausible-looking implementation is acceptable. Every case here has an answer
 * derivable from the definition rather than from running the code:
 *
 *   - a perfect predictor scores AUC 1.0 and CC 1.0
 *   - a flat map carries no information: AUC 0.5, NSS 0, CC 0
 *   - an inverted map scores CC -1
 *   - NSS is invariant to affine rescaling of the map (it standardizes first)
 *   - AUC is invariant to ANY monotonic rescaling (it only ranks)
 *
 * That last pair is the reason the literature reports several metrics rather
 * than one: they are insensitive to different things, and a model can look good
 * on AUC while being badly calibrated. Reporting a single number is how saliency
 * models get oversold.
 *
 * Context: the published Study 1 numbers (AUC-Judd 0.663 / NSS 0.544 / CC 0.216
 * on UEyes) came from a Python port that had drifted from the shipped model —
 * the TypeScript weights chrominance 3x, the Python did not. These metrics live
 * in src/ so the benchmark scores shipped code by construction.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  computeAUCJudd,
  computeNSS,
  computeCC,
  scoreSaliency,
  resampleGrid,
  type SaliencyGrid,
  type Fixation,
} from "../src/visual/saliency-metrics.js";

const grid = (values: number[], width: number, height: number): SaliencyGrid => ({
  values: Float64Array.from(values),
  width,
  height,
});

/** 4x4 map with a single hot corner at (0,0). */
const HOT_CORNER = grid(
  [
    9, 8, 1, 0,
    8, 7, 1, 0,
    1, 1, 0, 0,
    0, 0, 0, 0,
  ],
  4,
  4,
);

describe("AUC-Judd", () => {
  test("a flat map scores chance", () => {
    const flat = grid(new Array(16).fill(0.5), 4, 4);
    const { auc } = computeAUCJudd(flat, [{ x: 1, y: 1 }, { x: 2, y: 2 }]);
    expect(auc).toBeCloseTo(0.5, 2);
  });

  test("a predictor that puts its maximum on the fixation beats chance decisively", () => {
    const { auc } = computeAUCJudd(HOT_CORNER, [{ x: 0, y: 0 }]);
    expect(auc).toBeGreaterThan(0.9);
  });

  test("a fixation tied at the floor scores exactly chance — ties cannot be ranked", () => {
    // (3,3) holds 0, and so do six other pixels. Under the >= convention every
    // tied pixel clears the same threshold, so the model has expressed no
    // preference and 0.5 is the correct answer, not a bug. My first version of
    // this test asserted < 0.5 and was wrong about the metric.
    const { auc } = computeAUCJudd(HOT_CORNER, [{ x: 3, y: 3 }]);
    expect(auc).toBeCloseTo(0.5, 6);
  });

  test("a SINGLE fixation cannot score below chance — a structural floor, not a bug", () => {
    // Worth pinning because it is counter-intuitive and would otherwise be
    // rediscovered as a defect. With one fixation there is one threshold, and at
    // that threshold TPR is 1 by definition; the worst reachable point is
    // (FPR 1, TPR 1), whose area is exactly 0.5. So single-fixation AUC lives in
    // [0.5, 1] and says nothing about anti-correlation. Corpus scoring must
    // aggregate over many fixations for the metric to be two-sided.
    const ramp = grid(
      [16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      4,
      4,
    );
    expect(computeAUCJudd(ramp, [{ x: 3, y: 3 }]).auc).toBeCloseTo(0.5, 6);
    expect(computeAUCJudd(ramp, [{ x: 0, y: 0 }]).auc).toBeGreaterThan(0.95);
  });

  test("MULTIPLE fixations on cold regions score well below chance", () => {
    const ramp = grid(
      [16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      4,
      4,
    );
    const coldest = [{ x: 0, y: 3 }, { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 }];
    const hottest = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
    expect(computeAUCJudd(ramp, coldest).auc).toBeLessThan(0.3);
    expect(computeAUCJudd(ramp, hottest).auc).toBeGreaterThan(0.8);
  });

  test("fixations outside the grid are excluded, not clamped", () => {
    // Clamping would silently move a fixation onto the nearest edge pixel and
    // score it there — inventing agreement the data does not contain.
    const { scored } = computeAUCJudd(HOT_CORNER, [
      { x: 0, y: 0 },
      { x: 99, y: 99 },
      { x: -5, y: 2 },
    ]);
    expect(scored).toBe(1);
  });

  test("PROPERTY: invariant to monotonic rescaling — it ranks, it does not measure", () => {
    fc.assert(
      fc.property(
        // min 1e-6, not 0: a denormal like 5e-324 UNDERFLOWS to zero when scaled,
        // which really does change the ranking. That is a float limit, not a
        // violation of the invariant being asserted.
        fc.array(fc.double({ min: 1e-6, max: 1, noNaN: true }), { minLength: 16, maxLength: 16 }),
        fc.double({ min: 0.1, max: 50, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        (values, scale, shift) => {
          const transformed = values.map((v) => v * scale + shift);
          // A monotonic transform preserves ORDER in exact arithmetic, but in
          // floating point `v * 0.1 - 0.9999999999996507` can collapse two
          // distinct values into one through catastrophic cancellation. That
          // genuinely changes the ranking, so the invariant does not apply —
          // this is a precision limit, not a defect, and skipping it is more
          // honest than widening the tolerance until it passes.
          if (new Set(transformed).size !== new Set(values).size) return;
          const fixations: Fixation[] = [{ x: 1, y: 1 }, { x: 2, y: 3 }];
          const base = computeAUCJudd(grid(values, 4, 4), fixations).auc;
          const scaled = computeAUCJudd(grid(transformed, 4, 4), fixations).auc;
          expect(scaled).toBeCloseTo(base, 6);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("NSS", () => {
  test("a flat map yields exactly 0, not NaN", () => {
    // Standardizing a constant map divides by zero variance. Returning NaN here
    // would poison any average computed over a corpus.
    const flat = grid(new Array(16).fill(3), 4, 4);
    expect(computeNSS(flat, [{ x: 1, y: 1 }]).nss).toBe(0);
  });

  test("a fixation on the peak scores positive; on the floor, negative", () => {
    expect(computeNSS(HOT_CORNER, [{ x: 0, y: 0 }]).nss).toBeGreaterThan(1);
    expect(computeNSS(HOT_CORNER, [{ x: 3, y: 3 }]).nss).toBeLessThan(0);
  });

  test("PROPERTY: invariant to positive affine rescaling of the map", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1e-6, max: 1, noNaN: true }), { minLength: 16, maxLength: 16 }),
        fc.double({ min: 0.1, max: 20, noNaN: true }),
        fc.double({ min: -5, max: 5, noNaN: true }),
        (values, scale, shift) => {
          if (new Set(values).size === 1) return; // flat map is the 0 case above
          const fixations: Fixation[] = [{ x: 0, y: 0 }, { x: 3, y: 2 }];
          const base = computeNSS(grid(values, 4, 4), fixations).nss;
          const rescaled = computeNSS(
            grid(values.map((v) => v * scale + shift), 4, 4),
            fixations,
          ).nss;
          expect(rescaled).toBeCloseTo(base, 6);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("CC", () => {
  test("a map correlated with itself scores 1", () => {
    expect(computeCC(HOT_CORNER, HOT_CORNER)).toBeCloseTo(1, 9);
  });

  test("an inverted map scores -1", () => {
    const inverted = grid(
      Array.from(HOT_CORNER.values as Float64Array, (v) => -v),
      4,
      4,
    );
    expect(computeCC(HOT_CORNER, inverted)).toBeCloseTo(-1, 9);
  });

  test("a flat map correlates with nothing", () => {
    const flat = grid(new Array(16).fill(1), 4, 4);
    expect(computeCC(flat, HOT_CORNER)).toBe(0);
  });

  test("mismatched grids THROW rather than silently reshape", () => {
    // Silently reshaping is how transport_map ended up comparing a 393x11114
    // mobile capture against a 1920x1080 grid. Same failure, refused here.
    const small = grid(new Array(4).fill(1), 2, 2);
    expect(() => computeCC(HOT_CORNER, small)).toThrow(/matching grids/);
  });

  test("PROPERTY: symmetric", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 16, maxLength: 16 }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 16, maxLength: 16 }),
        (a, b) => {
          const ga = grid(a, 4, 4);
          const gb = grid(b, 4, 4);
          expect(computeCC(ga, gb)).toBeCloseTo(computeCC(gb, ga), 9);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("scoreSaliency", () => {
  test("CC is NaN — not 0 — when no ground-truth map is supplied", () => {
    // 0 would be indistinguishable from a genuinely uncorrelated model, and
    // would drag a corpus average toward zero for runs that never measured it.
    const s = scoreSaliency(HOT_CORNER, [{ x: 0, y: 0 }]);
    expect(Number.isNaN(s.cc)).toBe(true);
    expect(s.aucJudd).toBeGreaterThan(0.9);
  });

  test("a perfect predictor scores at the ceiling on all three", () => {
    const s = scoreSaliency(HOT_CORNER, [{ x: 0, y: 0 }], HOT_CORNER);
    expect(s.aucJudd).toBeGreaterThan(0.9);
    expect(s.nss).toBeGreaterThan(1);
    expect(s.cc).toBeCloseTo(1, 9);
  });
});

describe("resampleGrid", () => {
  test("resampling to the same size is identity", () => {
    const out = resampleGrid(HOT_CORNER, 4, 4);
    expect(Array.from(out.values)).toEqual(Array.from(HOT_CORNER.values as Float64Array));
  });

  test("downsampling averages rather than samples", () => {
    // A 2x2 downsample of the 4x4 hot corner must average each quadrant; point
    // sampling would keep 9 and lose the rest of the block.
    const out = resampleGrid(HOT_CORNER, 2, 2);
    expect(out.values[0]).toBeCloseTo((9 + 8 + 8 + 7) / 4, 6);
  });

  test("PROPERTY: resampling never invents values outside the input range", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 100, noNaN: true }), { minLength: 16, maxLength: 16 }),
        fc.integer({ min: 1, max: 8 }),
        (values, target) => {
          const out = resampleGrid(grid(values, 4, 4), target, target);
          const lo = Math.min(...values);
          const hi = Math.max(...values);
          for (const v of out.values) {
            expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
            expect(v).toBeLessThanOrEqual(hi + 1e-9);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
