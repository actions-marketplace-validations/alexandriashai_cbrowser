/**
 * Hit probability against movement time, and what was actually inverted.
 *
 * The report saw `2276ms / 1%` for one persona and `2647ms / 2%` for another
 * and read it as hit probability inverting against movement time. It was
 * blocked for rounds because the only element producing those numbers was a
 * `visually-hidden` skip link with 1x1 geometry, which BUG-09 then filtered
 * out, leaving nothing to measure.
 *
 * The two quantities share no parameter but W. Movement time is (distance,
 * width, throughput); hit probability is (width, height, sigma, rho). They were
 * never expected to track each other, and a persona can legitimately be fast
 * and inaccurate.
 *
 * What WAS inverted is hit probability against sigma. The Plackett correlated
 * correction has `pX * pY` in its denominator, so it diverges as the target
 * shrinks -- and because rho co-varies with sigma across personas, the worse
 * pointer won:
 *
 *   on a 1x1 target, BEFORE
 *     cognitive-adhd           sigma  5.5  rho 0.00   0.52%
 *     dyslexic-user            sigma  7.7  rho 0.14   2.46%   <- worse, scored higher
 *     motor-impairment-tremor  sigma 12.0  rho 0.30   4.88%   <- worst, scored highest
 *
 * @since 2026-08-03
 */
import { test, expect, describe } from "bun:test";
import { computeHitProbability, computeFittsTime, type PointingProfile } from "../src/visual/cognitive-models.js";

const target = (w: number, h = w) => ({ selector: "x", width: w, height: h, distance: 300 } as never);
const p = (sigma: number, rho = 0, throughput = 4): PointingProfile =>
  ({ sigmaX: sigma, sigmaY: sigma, rho, throughput });

describe("the ordering the report actually caught", () => {
  test("a worse pointer never scores higher, at ANY target size", () => {
    // The claim in its strongest form. Sigma ascending must give probability
    // descending, including in the degenerate range where the approximation
    // used to blow up.
    for (const size of [1, 2, 3, 6, 12, 24, 48]) {
      const probs = [4, 5.5, 7.7, 12].map((sg) => computeHitProbability(target(size), p(sg, 0.13)));
      for (let i = 1; i < probs.length; i++) {
        expect({ size, sigma: [4, 5.5, 7.7, 12][i], ordered: probs[i] <= probs[i - 1] + 1e-12 })
          .toEqual({ size, sigma: [4, 5.5, 7.7, 12][i], ordered: true });
      }
    }
  });

  test("the three personas from the report are in the right order on 1x1", () => {
    const adhd = computeHitProbability(target(1), p(5.5, 0));
    const dyslexic = computeHitProbability(target(1), p(7.7, 0.138));
    const tremor = computeHitProbability(target(1), p(12, 0.30));
    expect(adhd).toBeGreaterThan(dyslexic);
    expect(dyslexic).toBeGreaterThan(tremor);
    // And tremor is no longer NINE TIMES better than adhd, which was the shape
    // of the defect: 4.88% against 0.52%.
    expect(tremor).toBeLessThan(adhd);
  });

  test("more correlation never increases the probability", () => {
    // rho tightens the joint distribution along one diagonal; it cannot make a
    // small target easier to hit than independence does by an unbounded factor.
    for (const size of [1, 3, 6, 12, 24]) {
      const none = computeHitProbability(target(size), p(7.7, 0));
      for (const rho of [0.1, 0.3, 0.6, 0.9]) {
        const withRho = computeHitProbability(target(size), p(7.7, rho));
        expect({ size, rho, ratio: withRho / none < 1.3 }).toEqual({ size, rho, ratio: true });
      }
    }
  });
});

describe("the correction is still applied where it is valid", () => {
  test("realistic target sizes are unchanged by the bound", () => {
    // The bound must not have neutered the correlated model. Measured factors
    // before the fix: 1.00x at 48 and 24px, 1.04x at 12px, 1.19x at 6px -- all
    // inside the bound, so all still applied.
    for (const size of [6, 12, 24, 48]) {
      const independent = computeHitProbability(target(size), p(7.7, 0));
      const corrected = computeHitProbability(target(size), p(7.7, 0.13));
      expect({ size, differs: Math.abs(corrected - independent) > 1e-9 })
        .toEqual({ size, differs: true });
    }
  });

  test("a joint probability never exceeds its smaller marginal", () => {
    // Frechet. Exact, and true for every rho -- not an approximation.
    for (const size of [1, 3, 6, 12, 24, 48]) {
      for (const rho of [0, 0.3, 0.9]) {
        const joint = computeHitProbability(target(size), p(7.7, rho));
        const marginal = computeHitProbability({ ...target(size), height: 100000 } as never, p(7.7, 0));
        expect({ size, rho, bounded: joint <= marginal + 1e-9 }).toEqual({ size, rho, bounded: true });
      }
    }
  });

  test("probabilities stay in range", () => {
    for (const size of [0.5, 1, 10, 500]) {
      for (const rho of [-0.9, 0, 0.9]) {
        const v = computeHitProbability(target(size), p(7.7, rho));
        expect({ size, rho, inRange: v >= 0 && v <= 1 }).toEqual({ size, rho, inRange: true });
      }
    }
  });
});

describe("movement time and hit probability are independent by construction", () => {
  test("throughput moves movement time and not hit probability", () => {
    const probs = [2, 4, 6].map((tp) => computeHitProbability(target(24), p(5, 0, tp)));
    expect(new Set(probs.map((x) => x.toFixed(12))).size).toBe(1);
    const times = [2, 4, 6].map((tp) => computeFittsTime(300, 24, tp));
    expect(new Set(times.map((x) => x.toFixed(6))).size).toBe(3);
  });

  test("sigma moves hit probability and not movement time", () => {
    const probs = [4, 8, 12].map((sg) => computeHitProbability(target(24), p(sg)));
    expect(new Set(probs.map((x) => x.toFixed(12))).size).toBe(3);
    // computeFittsTime does not take sigma at all, which is the point.
    expect(computeFittsTime.length).toBe(3);
  });

  test("so being fast and inaccurate is a legal combination, not a defect", () => {
    // A high-throughput, high-dispersion pointer. The report read this pairing
    // as an inversion; it is a description of someone who moves quickly and
    // lands imprecisely, which is a real kind of person.
    const fastLoose = p(12, 0, 6);
    const slowTight = p(4, 0, 2);
    expect(computeFittsTime(300, 24, fastLoose.throughput)).toBeLessThan(computeFittsTime(300, 24, slowTight.throughput));
    expect(computeHitProbability(target(24), fastLoose)).toBeLessThan(computeHitProbability(target(24), slowTight));
  });
});

describe("Fitts' law behaves", () => {
  test("movement time rises with distance and falls with width", () => {
    expect(computeFittsTime(600, 24, 4)).toBeGreaterThan(computeFittsTime(300, 24, 4));
    expect(computeFittsTime(300, 12, 4)).toBeGreaterThan(computeFittsTime(300, 48, 4));
  });

  test("degenerate inputs return 0 rather than Infinity or NaN", () => {
    for (const args of [[0, 24, 4], [300, 0, 4], [300, 24, 0], [-5, 24, 4]] as const) {
      expect({ args, v: computeFittsTime(args[0], args[1], args[2]) }).toEqual({ args, v: 0 });
    }
  });
});
