/**
 * Barrier overlay HTML.
 *
 * An empathy score in prose has to be taken on faith. The same score with the
 * barriers drawn on the page is falsifiable by eye — which is only true if the
 * boxes land where the barriers actually are, so these pin the positioning
 * rather than the appearance.
 *
 * The scaling property is the load-bearing one. Rects arrive in document CSS
 * pixels against a capture of known size, but the rendered width depends on the
 * host's iframe and is unknowable here, so any fixed pixel scale is wrong at
 * every width but one. Expressing rects as percentages of the same capture box
 * makes image and rects share one scale by construction; the property test is
 * what says "by construction" rather than "I checked one case".
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  buildBarrierOverlayHtml,
  rectToPercent,
  isInBounds,
  esc,
  SEVERITY_COLORS,
  type OverlayRect,
} from "../src/visual/barrier-overlay-html.js";

const IMG = "https://cbrowser.ai/heatmaps/empathy-cognitive-adhd-ab12cd34ef56.png";

function input(overrides: Partial<Parameters<typeof buildBarrierOverlayHtml>[0]> = {}) {
  return {
    imageUrl: IMG,
    imageWidth: 1280,
    captureHeight: 4000,
    persona: "cognitive-adhd",
    pageUrl: "https://cbrowser.ai",
    score: 71,
    barrierRects: [
      { type: "touch_target", severity: "critical", element: "button.cta",
        description: "Target 152x20 below 24x24", wcag: ["2.5.8"],
        rect: { x: 100, y: 200, width: 152, height: 20 } },
      { type: "contrast", severity: "major", element: "p.muted",
        description: "Contrast 3.1:1", wcag: ["1.4.3"],
        rect: { x: 0, y: 3951, width: 300, height: 18 } },
    ] as OverlayRect[],
    ...overrides,
  };
}

describe("ISC-61 — one positioned box per in-bounds rect", () => {
  test("every in-bounds barrier is drawn", () => {
    const html = buildBarrierOverlayHtml(input())!;
    expect((html.match(/class="bx"/g) ?? []).length).toBe(2);
  });

  test("the capture is referenced, not embedded", () => {
    const html = buildBarrierOverlayHtml(input())!;
    expect(html).toContain(`src="${IMG}"`);
    expect(html).not.toContain("data:image");
  });

  test("no image means no overlay rather than a legend over nothing", () => {
    expect(buildBarrierOverlayHtml(input({ imageUrl: "" }))).toBeNull();
    expect(buildBarrierOverlayHtml(input({ imageWidth: 0 }))).toBeNull();
    expect(buildBarrierOverlayHtml(input({ captureHeight: 0 }))).toBeNull();
  });
});

describe("ISC-75 — image and rects share one scale, by construction", () => {
  test("a rect at y=3951 lands near the bottom of a 4000px full-page capture", () => {
    // The concrete case from the real payload: document coordinates against a
    // full_page capture. Under a viewport-height assumption this would be off
    // the canvas entirely.
    const p = rectToPercent({ x: 0, y: 3951, width: 300, height: 18 }, 1280, 4000);
    expect(p.top).toBeCloseTo(98.775, 3);
    expect(p.top).toBeLessThan(100);
  });

  test("PROPERTY: a rect's percentage box is invariant under capture rescaling", () => {
    // Scaling the whole capture (image AND rects) must not move a rect
    // relative to the image — that is exactly what "one scale factor" means.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 20000 }),
        fc.integer({ min: 0, max: 3999 }),
        fc.integer({ min: 0, max: 19999 }),
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 500 }),
        fc.double({ min: 0.1, max: 8, noNaN: true }),
        (w, h, x, y, rw, rh, k) => {
          const base = rectToPercent({ x, y, width: rw, height: rh }, w, h);
          const scaled = rectToPercent(
            { x: x * k, y: y * k, width: rw * k, height: rh * k },
            w * k,
            h * k,
          );
          expect(scaled.left).toBeCloseTo(base.left, 6);
          expect(scaled.top).toBeCloseTo(base.top, 6);
          expect(scaled.width).toBeCloseTo(base.width, 6);
          expect(scaled.height).toBeCloseTo(base.height, 6);
        },
      ),
      { numRuns: 1000 },
    );
  });

  test("PROPERTY: an in-bounds rect never positions outside the image", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 4000 }),
        fc.integer({ min: 100, max: 20000 }),
        fc.integer({ min: 0, max: 3999 }),
        fc.integer({ min: 0, max: 19999 }),
        (w, h, x, y) => {
          const rect = { x: x % w, y: y % h, width: 10, height: 10 };
          if (!isInBounds(rect, w, h)) return;
          const p = rectToPercent(rect, w, h);
          expect(p.left).toBeGreaterThanOrEqual(0);
          expect(p.top).toBeGreaterThanOrEqual(0);
          expect(p.left).toBeLessThan(100);
          expect(p.top).toBeLessThan(100);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("ISC-76 — out-of-bounds rects are listed, never drawn", () => {
  const offscreen: OverlayRect[] = [
    { type: "contrast", severity: "major", element: "footer a",
      rect: { x: 0, y: -400, width: 100, height: 20 }, outsideScreenshot: true },
    { type: "touch_target", severity: "critical", element: "nav button",
      rect: { x: 0, y: 99999, width: 100, height: 20 } },
  ];

  test("they do not become positioned boxes", () => {
    const html = buildBarrierOverlayHtml(input({ barrierRects: offscreen }))!;
    expect((html.match(/class="bx"/g) ?? []).length).toBe(0);
  });

  test("they are reported rather than silently dropped", () => {
    const html = buildBarrierOverlayHtml(input({ barrierRects: offscreen }))!;
    expect(html).toContain("Outside the capture (2)");
    expect(html).toContain("nav button");
  });

  test("a mixed set draws only the in-bounds ones", () => {
    const html = buildBarrierOverlayHtml(
      input({ barrierRects: [...input().barrierRects, ...offscreen] }),
    )!;
    expect((html.match(/class="bx"/g) ?? []).length).toBe(2);
    expect(html).toContain("Outside the capture (2)");
  });
});

describe("ISC-77 — severity colour is fixed and has a legend", () => {
  test("a legend entry exists per severity present, with counts", () => {
    const html = buildBarrierOverlayHtml(input())!;
    expect(html).toContain(SEVERITY_COLORS.critical);
    expect(html).toContain(SEVERITY_COLORS.major);
    expect(html).toContain("critical (1)");
    expect(html).toContain("major (1)");
  });

  test("a severity absent from the input gets no legend entry", () => {
    const html = buildBarrierOverlayHtml(input())!;
    expect(html).not.toContain("minor (");
  });

  test("no barriers in frame says so instead of showing an empty legend", () => {
    const html = buildBarrierOverlayHtml(input({ barrierRects: [] }))!;
    expect(html).toContain("No barriers fell within the captured image");
  });
});

describe("ISC-78 — colour is never the only carrier of meaning", () => {
  test("every box has a non-empty accessible name", () => {
    const html = buildBarrierOverlayHtml(input())!;
    const boxes = html.match(/<div class="bx"[^>]*>/g) ?? [];
    expect(boxes.length).toBe(2);
    for (const box of boxes) {
      const label = /aria-label="([^"]*)"/.exec(box)?.[1] ?? "";
      expect(label.length).toBeGreaterThan(0);
      expect(box).toContain("title=");
    }
  });

  test("the label carries severity, type and WCAG criterion", () => {
    const html = buildBarrierOverlayHtml(input())!;
    expect(html).toContain("critical: touch_target (WCAG 2.5.8)");
  });

  test("the image has a descriptive alt", () => {
    const html = buildBarrierOverlayHtml(input())!;
    expect(/alt="Screenshot of [^"]+barriers outlined"/.test(html)).toBe(true);
  });
});

describe("ISC-82 — hostile content cannot break out", () => {
  test("a description containing markup and quotes is escaped everywhere", () => {
    const nasty = `</div><script>alert(1)</script>" onmouseover="evil()`;
    const html = buildBarrierOverlayHtml(
      input({
        persona: nasty,
        pageUrl: nasty,
        barrierRects: [
          { type: nasty, severity: "critical", element: nasty, description: nasty,
            wcag: [nasty], rect: { x: 1, y: 1, width: 10, height: 10 } },
        ],
      }),
    )!;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`onmouseover="evil()`);
    // Still exactly one box — the payload did not spawn extra elements.
    expect((html.match(/class="bx"/g) ?? []).length).toBe(1);
  });

  test("PROPERTY: esc output never reintroduces a raw angle bracket or quote", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const out = esc(raw);
        expect(out.includes("<")).toBe(false);
        expect(out.includes(">")).toBe(false);
        expect(out.includes('"')).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("ISC-83 — the document reaches nowhere off-origin", () => {
  test("no remote script, stylesheet, font or fetch", () => {
    const html = buildBarrierOverlayHtml(input())!;
    expect(/<script/i.test(html)).toBe(false);
    expect(/@import/i.test(html)).toBe(false);
    expect(/<link[^>]+href="https?:/i.test(html)).toBe(false);
    expect(/\bfetch\s*\(/.test(html)).toBe(false);
    // The only external reference is our own served capture.
    const srcs = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs).toEqual([IMG]);
  });
});
