/**
 * The visual/semantic blend had NO test coverage until 2026-08-04.
 *
 * Verified by absence rather than assumed: with the call site edited to
 * `blendSaliencyMaps(lab, semantic, 1.0, 0.0)` -- the semantic channel, 95% of
 * the model, weighted to zero -- `src/visual/attention-transport.test.ts`
 * reported 7 pass / 0 fail. The whole suite reported 1058 pass / 0 fail. A green
 * suite was not evidence the operating point was safe; it was evidence nothing
 * looked at it.
 *
 * These tests exist so that changing the blend has to be a DECISION. Two of them
 * are behavioural rather than literal, because a test that only asserts
 * `=== 0.05` is satisfied by a constant that is never used.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, expect, test } from "bun:test";
import { blendSaliencyMaps } from "../src/visual/attention-transport.js";

/** Unit-mass L1 distance. 0 = same distribution, 2 = disjoint. Gain-invariant. */
function divergence(a: Float64Array, b: Float64Array): number {
  let sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; }
  if (sa <= 0 || sb <= 0) return 2;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] / sa - b[i] / sb);
  return d;
}

/** Two deliberately disjoint maps: visual lights the left half, semantic the right. */
function fixtures(n = 64) {
  const visual = new Float64Array(n), semantic = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    visual[i] = i < n / 2 ? 1 : 0;
    semantic[i] = i >= n / 2 ? 1 : 0;
  }
  return { visual, semantic };
}

describe("attention blend weight", () => {
  test("defaults to 5% visual / 95% semantic", () => {
    // Pinned to the operating point selected by research/study1/run-blend-sweep.ts:
    // swept 0..1 over all 495 UEyes web stimuli against 554 participant logs.
    // w=0.05 beat the previous 0.35 by +0.0231 AUC (p<0.0001, 386/495 pages) and
    // was picked by 5-fold CV in 5/5 folds with a 0.0000 optimism gap.
    //
    // Changing this number is allowed. Changing it WITHOUT re-running the sweep
    // is what this assertion is here to stop.
    const { visual, semantic } = fixtures();
    const withDefaults = blendSaliencyMaps(visual, semantic);
    const explicit = blendSaliencyMaps(visual, semantic, 0.05, 0.95);
    expect(Array.from(withDefaults)).toEqual(Array.from(explicit));
  });

  test("semantic channel dominates the blend at the shipped weight", () => {
    // Behavioural, not literal. This fails if the weights are swapped, equalised,
    // or if the semantic term is dropped -- none of which a `=== 0.05` assertion
    // would catch, because a constant can be correct and unused.
    const { visual, semantic } = fixtures();
    const blended = blendSaliencyMaps(visual, semantic);
    const dVisual = divergence(blended, visual);
    const dSemantic = divergence(blended, semantic);
    expect(dSemantic).toBeLessThan(dVisual);
    // 95:5 is a wide margin; require a real one so a drift toward 50/50 fails.
    expect(dVisual - dSemantic).toBeGreaterThan(1.0);
  });

  test("both channels are actually wired in", () => {
    // The failure this catches: a channel silently contributing nothing. Perturb
    // one input, and the output must move. Zero movement means the term is dead.
    const { visual, semantic } = fixtures();
    const base = blendSaliencyMaps(visual, semantic);

    const visualMoved = new Float64Array(visual);
    visualMoved[0] = 0; visualMoved[visual.length - 1] = 1;
    expect(divergence(base, blendSaliencyMaps(visualMoved, semantic))).toBeGreaterThan(0);

    const semanticMoved = new Float64Array(semantic);
    semanticMoved[0] = 1;
    expect(divergence(base, blendSaliencyMaps(visual, semanticMoved))).toBeGreaterThan(0);
  });

  test("weights are honoured across the range, monotonically", () => {
    // Sweeping w from 0 to 1 must walk the blend from the semantic map to the
    // visual one without reversals. A hardcoded weight ignoring its arguments
    // makes this flat, which is the other way the constant can be a lie.
    const { visual, semantic } = fixtures();
    let prev = Infinity;
    for (const w of [0, 0.25, 0.5, 0.75, 1]) {
      const d = divergence(blendSaliencyMaps(visual, semantic, w, 1 - w), visual);
      expect(d).toBeLessThanOrEqual(prev);
      prev = d;
    }
    expect(divergence(blendSaliencyMaps(visual, semantic, 1, 0), visual)).toBeCloseTo(0, 6);
    expect(divergence(blendSaliencyMaps(visual, semantic, 0, 1), semantic)).toBeCloseTo(0, 6);
  });
});
