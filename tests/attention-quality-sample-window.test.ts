/**
 * The attention-quality ratios must be computed over a sample of ELEMENTS.
 *
 * `hotspots` are 4px grid cells, so one H1 spans dozens of them. The window was
 * a flat `slice(0, 20)` over CELLS, which on a page with one dominant headline
 * sampled a single element twenty times. Every ratio then came out 0 or 1:
 *
 *   ctaCaptureRate 0 · valuePropSalience 1 · headingShare 1
 *   distractorRatio 0 · contentRatio 0 · topAttentionTargets: [1 entry]
 *
 * Reproduced live against cbrowser.ai on 2026-08-05, and matching the July
 * report's "attention quality saturates and fails to separate personas".
 *
 * The fix widens the window until it covers MIN_DISTINCT_ELEMENTS (8) distinct
 * elements. These tests pin the degenerate case specifically, because it is the
 * one a flat cell window gets wrong and an element-aware window gets right.
 */
import { describe, test, expect } from "bun:test";
import { computeAttentionQuality } from "../src/visual/attention-quality.js";

type El = Parameters<typeof computeAttentionQuality>[1][number];

/** A dominant heading occupying the hottest 40 cells, then 12 smaller elements. */
function dominantHeadingPage(): { hotspots: Array<{ x: number; y: number; saliency: number }>; elements: El[] } {
  const elements: El[] = [
    { text: "One Big Headline", type: "h1", x: 400, y: 200, width: 400, height: 60, isHeading: true },
  ];
  const hotspots: Array<{ x: number; y: number; saliency: number }> = [];

  // 40 hot cells, all inside the headline — more than the old 20-cell window.
  for (let i = 0; i < 40; i++) {
    hotspots.push({ x: 410 + (i % 20) * 18, y: 210 + Math.floor(i / 20) * 20, saliency: 0.9 - i * 0.001 });
  }

  // Then a CTA, some nav, and content — all cooler, so a cell window never
  // reaches them but an element-aware window does.
  const rest: El[] = [
    { text: "Try Free", type: "a", x: 400, y: 400, width: 120, height: 40, isCTA: true },
    { text: "See Example Report", type: "a", x: 560, y: 400, width: 180, height: 40, isCTA: true },
    { text: "Pricing", type: "a", x: 100, y: 40, width: 70, height: 20, isNav: true },
    { text: "Docs", type: "a", x: 200, y: 40, width: 60, height: 20, isNav: true },
    { text: "Blog", type: "a", x: 280, y: 40, width: 60, height: 20, isNav: true },
    { text: "Body copy about the product", type: "p", x: 400, y: 500, width: 400, height: 80 },
    { text: "More body copy", type: "p", x: 400, y: 600, width: 400, height: 60 },
    { text: "Footer note", type: "p", x: 400, y: 700, width: 300, height: 30 },
    { text: "Decorative swoosh", type: "img", x: 900, y: 300, width: 100, height: 100, isDecorative: true },
    { text: "Second decorative", type: "img", x: 900, y: 450, width: 100, height: 100, isDecorative: true },
  ];
  elements.push(...rest);
  for (const el of rest) {
    hotspots.push({ x: el.x + 5, y: el.y + 5, saliency: 0.4 });
  }
  return { hotspots, elements };
}

describe("attention-quality sample window", () => {
  test("a single dominant element cannot drive every ratio to 0 or 1", () => {
    const { hotspots, elements } = dominantHeadingPage();
    const q = computeAttentionQuality(hotspots, elements, 4);

    // The old flat 20-cell window saw only the headline, so headingShare was
    // exactly 1 and everything else exactly 0. This is the assertion that fails
    // on the pre-fix code.
    expect(q.headingShare).toBeLessThan(1);
    expect(q.ctaCaptureRate).toBeGreaterThan(0);
    expect(q.distractorRatio).toBeGreaterThan(0);
  });

  test("the window reaches past the dominant element to real competitors", () => {
    const { hotspots, elements } = dominantHeadingPage();
    const q = computeAttentionQuality(hotspots, elements, 4);
    expect(q.sampledElements).toBeGreaterThanOrEqual(8);
    // 40 headline cells had to be walked before any competitor appeared, so the
    // window must be wider than the old fixed 20.
    expect(q.sampledHotspots!).toBeGreaterThan(20);
  });

  test("more than one element reaches topAttentionTargets", () => {
    const { hotspots, elements } = dominantHeadingPage();
    const q = computeAttentionQuality(hotspots, elements, 4);
    expect(q.topAttentionTargets.length).toBeGreaterThan(1);
  });

  test("ratios still sum to 1 — widening the window must not break the identity", () => {
    const { hotspots, elements } = dominantHeadingPage();
    const q = computeAttentionQuality(hotspots, elements, 4);
    const sum = q.ctaCaptureRate + (q.headingShare ?? 0) + q.distractorRatio + (q.contentRatio ?? 0);
    expect(sum).toBeCloseTo(1, 2);
  });
});

describe("attention-quality thin-sample honesty", () => {
  test("a genuinely thin page says so instead of publishing a confident 1.0", () => {
    const elements: El[] = [
      { text: "Only Heading", type: "h1", x: 400, y: 200, width: 400, height: 60, isHeading: true },
    ];
    const hotspots = Array.from({ length: 30 }, (_, i) => ({
      x: 410 + (i % 20) * 18, y: 210 + Math.floor(i / 20) * 20, saliency: 0.9,
    }));
    const q = computeAttentionQuality(hotspots, elements, 4);

    // Here headingShare genuinely IS 1 — one element is all there is. The fix is
    // not to fake a spread, it is to disclose the sample size.
    expect(q.sampledElements).toBe(1);
    expect(q.sampleNote).toBeDefined();
    expect(q.sampleNote).toContain("1 distinct element");
  });

  test("a well-populated page carries no thin-sample note", () => {
    const { hotspots, elements } = dominantHeadingPage();
    const q = computeAttentionQuality(hotspots, elements, 4);
    expect(q.sampleNote).toBeUndefined();
  });

  test("empty hotspots stay a clean zero rather than throwing", () => {
    const q = computeAttentionQuality([], [], 4);
    expect(q.topAttentionTargets).toEqual([]);
    expect(q.qualityScore).toBe(0);
  });
});
