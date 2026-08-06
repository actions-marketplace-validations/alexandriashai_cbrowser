/**
 * Attention is familiarity-INDEPENDENT by design.
 *
 * Alexa's design call, 2026-08-05: "attention familiarity is independent now by
 * design so it is only used on tool call. the first timer vs returning user
 * case." siteFamiliarity belongs to the cognitive-transport chain, where
 * `cognitive_effort` takes it as an explicit per-call parameter. It does not
 * belong in the saliency map.
 *
 * What the code was doing instead:
 *
 *   navigation: 0.4 + (1.0 - t("siteFamiliarity")) * 0.6
 *
 * `attention_analysis` exposes no siteFamiliarity parameter, so no caller could
 * steer it — but it WAS being steered, by whatever value happened to be baked
 * into the persona's static trait vector. Invisible input, invisible effect.
 *
 * This is an anti-test: it asserts the absence of a coupling, so it is exactly
 * the kind that silently passes for the wrong reason. The first case therefore
 * proves the probe can detect coupling at all before the rest assert there is
 * none.
 */
import { describe, test, expect } from "bun:test";
import { buildSemanticMap } from "../src/visual/attention-transport.js";

const ROWS = 12, COLS = 16, CELL = 32;
const W = COLS * CELL, H = ROWS * CELL;

const ELEMENTS = [
  { text: "Home", type: "a", x: 20, y: 10, width: 80, height: 24, isNav: true },
  { text: "Pricing", type: "a", x: 120, y: 10, width: 80, height: 24, isNav: true },
  { text: "Big Headline Here", type: "h1", x: 60, y: 120, width: 380, height: 60, isHeading: true },
  { text: "Try Free", type: "button", x: 60, y: 240, width: 140, height: 44, isCTA: true },
  { text: "Body copy for the page", type: "p", x: 60, y: 320, width: 380, height: 80 },
];

function mapFor(traits: Record<string, number>): Float64Array {
  return buildSemanticMap(ELEMENTS, ROWS, COLS, CELL, W, H, "first-timer", undefined, traits);
}

function identical(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-12) return false;
  return true;
}

const BASE = { patience: 0.5, curiosity: 0.5, readingTendency: 0.5, selfEfficacy: 0.5,
               riskTolerance: 0.5, metacognitivePlanning: 0.5, proceduralFluency: 0.5 };

describe("the probe can detect trait coupling at all", () => {
  // Without this, every assertion below could pass because buildSemanticMap
  // ignores traits entirely, and the suite would prove nothing.
  test("a trait attention DOES depend on changes the map", () => {
    const low = mapFor({ ...BASE, curiosity: 0.0 });
    const high = mapFor({ ...BASE, curiosity: 1.0 });
    expect(identical(low, high)).toBe(false);
  });
});

describe("siteFamiliarity does not reach the attention map", () => {
  test("0.0 and 1.0 produce identical maps", () => {
    const firstTimer = mapFor({ ...BASE, siteFamiliarity: 0.0 });
    const returning = mapFor({ ...BASE, siteFamiliarity: 1.0 });
    expect(identical(firstTimer, returning)).toBe(true);
  });

  test("every value across the range produces the same map", () => {
    const ref = mapFor({ ...BASE, siteFamiliarity: 0.0 });
    for (const v of [0.1, 0.25, 0.5, 0.75, 0.9, 1.0]) {
      expect(identical(mapFor({ ...BASE, siteFamiliarity: v }), ref)).toBe(true);
    }
  });

  test("omitting the trait entirely matches any explicit value", () => {
    // The old formula defaulted a missing trait to 0.5 via `traits[key] ?? 0.5`,
    // so absent and 0.5 agreed while absent and 0.0 did not. Now all three do.
    const absent = mapFor({ ...BASE });
    expect(identical(absent, mapFor({ ...BASE, siteFamiliarity: 0.0 }))).toBe(true);
    expect(identical(absent, mapFor({ ...BASE, siteFamiliarity: 1.0 }))).toBe(true);
  });

  test("the neutral case is unchanged — 0.7 is the old formula at familiarity 0.5", () => {
    // Chosen so a persona with a neutral or absent value sees no behaviour
    // change at all from this fix.
    const atHalf = mapFor({ ...BASE, siteFamiliarity: 0.5 });
    expect(identical(atHalf, mapFor({ ...BASE }))).toBe(true);
  });
});

describe("the attention layer's source carries no familiarity term", () => {
  test("attention-transport.ts does not read siteFamiliarity as a trait", async () => {
    // A source-level assertion, because the behavioural tests above would keep
    // passing if someone reintroduced the coupling behind a different element
    // type than the five sampled here.
    //
    // Comments are stripped first. Without that this matched the comment
    // DOCUMENTING the removal — which quotes the old formula verbatim — so the
    // test failed on the very change that fixed the bug. A source grep that
    // cannot tell code from prose about the code is worse than no grep.
    const raw = await Bun.file(
      new URL("../src/visual/attention-transport.ts", import.meta.url),
    ).text();
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
      .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments, sparing `://` in URLs
    expect(code).not.toContain('t("siteFamiliarity")');
  });

  test("the comment-stripper actually strips — otherwise the test above is vacuous", () => {
    const stripped = `/* t("siteFamiliarity") */\nconst a = 1; // t("siteFamiliarity")`
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).not.toContain("siteFamiliarity");
    // And it must NOT strip real code.
    const kept = `navigation: 0.4 + t("siteFamiliarity")`
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(kept).toContain('t("siteFamiliarity")');
  });
});
