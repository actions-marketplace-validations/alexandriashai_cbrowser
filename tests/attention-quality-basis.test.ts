/**
 * The ratios round to 3dp, so `basis` ships beside them.
 *
 * Three decimals is enough precision to look like identity when it is not. Two
 * personas returned `ctaCaptureRate: 0.343` from 122.531/357.183 and
 * 118.899/346.169 — different in the fourth decimal — and a reader diffing the
 * two runs concluded, reasonably, that `attentionQuality` ignored persona
 * entirely and filed it as a P0. It was a rounding collision, and `power-user`
 * (0.769) later disproved the invariance claim outright.
 *
 * The two obvious fixes are both wrong. More decimals implies precision a ratio
 * over three or four coarse buckets does not have. FEWER decimals — the "report
 * to two" suggestion — collides strictly more often, not less.
 *
 * Publishing the numerator and denominator is the fix that actually answers the
 * question a reader comparing runs is asking: is this the same measurement, or
 * two different measurements that round alike?
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */
import { describe, test, expect } from "bun:test";
import { computeAttentionQuality } from "../src/visual/attention-quality.js";

type El = Parameters<typeof computeAttentionQuality>[1][number];

/**
 * Two pages whose CTA/heading ratios collide at 3dp but differ in the fourth —
 * the exact shape of the incident.
 */
function collidingPair() {
  const elements: El[] = [
    { text: "Headline", type: "h1", x: 100, y: 100, width: 400, height: 60, isHeading: true },
    { text: "Try Free", type: "a", x: 100, y: 300, width: 200, height: 50, isCTA: true },
  ];
  const mk = (ctaMass: number, headMass: number) => {
    const hotspots: Array<{ x: number; y: number; saliency: number }> = [];
    // One hotspot per element carrying the whole mass keeps the arithmetic exact.
    hotspots.push({ x: 300, y: 130, saliency: headMass });
    hotspots.push({ x: 200, y: 325, saliency: ctaMass });
    return { hotspots, elements };
  };
  // 122.531 / (122.531+234.652) = 0.343107...
  // 118.899 / (118.899+227.270) = 0.343487...
  return { a: mk(122.531, 234.652), b: mk(118.899, 227.270) };
}

describe("basis distinguishes a true match from a rounding collision", () => {
  test("the two runs really do collide at the reported precision", () => {
    // If this ever stops colliding the fixture has drifted and the rest of the
    // file stops testing what it claims to.
    const { a, b } = collidingPair();
    const qa = computeAttentionQuality(a.hotspots, a.elements, 4);
    const qb = computeAttentionQuality(b.hotspots, b.elements, 4);
    expect(qa.ctaCaptureRate).toBe(qb.ctaCaptureRate);
    expect(qa.ctaCaptureRate).toBeCloseTo(0.343, 3);
  });

  test("but their basis values differ, so a diff can tell them apart", () => {
    const { a, b } = collidingPair();
    const qa = computeAttentionQuality(a.hotspots, a.elements, 4);
    const qb = computeAttentionQuality(b.hotspots, b.elements, 4);
    expect(qa.basis).toBeDefined();
    expect(qa.basis!.cta).not.toBe(qb.basis!.cta);
    expect(qa.basis!.total).not.toBe(qb.basis!.total);
  });

  test("basis carries the actual masses, not a re-derivation", () => {
    const { a } = collidingPair();
    const q = computeAttentionQuality(a.hotspots, a.elements, 4);
    expect(q.basis!.cta).toBeCloseTo(122.531, 3);
    expect(q.basis!.heading).toBeCloseTo(234.652, 3);
    expect(q.basis!.total).toBeCloseTo(357.183, 3);
  });

  test("the published ratio equals numerator over denominator", () => {
    // The basis must describe the SAME computation, not a parallel one that
    // could drift from it — that would be a new instance of the defect class
    // this whole session has been about.
    const { a } = collidingPair();
    const q = computeAttentionQuality(a.hotspots, a.elements, 4);
    const recomputed = Math.round((q.basis!.cta / q.basis!.total) * 1000) / 1000;
    expect(recomputed).toBe(q.ctaCaptureRate);
  });

  test("every bucket is present, including the ones that are zero", () => {
    // A bucket omitted when empty is indistinguishable from a bucket that was
    // never measured.
    const { a } = collidingPair();
    const b = computeAttentionQuality(a.hotspots, a.elements, 4).basis!;
    for (const k of ["cta", "heading", "navigation", "decorative", "content", "unaccounted", "total"]) {
      expect(typeof (b as unknown as Record<string, number>)[k]).toBe("number");
    }
    expect(b.navigation).toBe(0);
    expect(b.decorative).toBe(0);
  });

  test("the buckets sum to the total", () => {
    const { a } = collidingPair();
    const b = computeAttentionQuality(a.hotspots, a.elements, 4).basis!;
    const sum = b.cta + b.heading + b.navigation + b.decorative + b.content + b.unaccounted;
    expect(sum).toBeCloseTo(b.total, 5);
  });

  test("the note tells a reader to check basis before concluding two runs match", () => {
    const { a } = collidingPair();
    const q = computeAttentionQuality(a.hotspots, a.elements, 4);
    expect(q.ratioNote).toContain("basis");
  });
});

describe("degenerate input", () => {
  test("an empty page does not emit a misleading basis", () => {
    const q = computeAttentionQuality([], [], 4);
    expect(q.topAttentionTargets).toEqual([]);
    expect(q.basis).toBeUndefined();
  });
});
