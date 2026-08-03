/**
 * The `motor` layer and `motorAccessibility` answer different questions, and
 * one thing inside the layer was backwards.
 *
 * D-9 asked whether the layer cost is MEANT to track the accessibility score.
 * It is not, and that half is by design:
 *
 *   motor layer cost   aggregate transport between persona capacity (pointing
 *                      AND procedural) and a demand derived from how many
 *                      interactive elements the page has. Never looks at an
 *                      individual control.
 *   motorAccessibility per-element Fitts and hit probability, counting barriers.
 *
 * Two questions, so they move independently and both can be right. Removing one
 * interactive element moves the layer cost from 0.0716 to 0.0696 while the
 * accessibility score moves eleven points, because the layer reads a COUNT and
 * the audit reads ELEMENTS. That is BUG-11's observation, explained.
 *
 * What was NOT by design: `motorCapacity` surplus was billed at 0.3, so being a
 * better pointer than the page required cost more. Measured on a 10-control
 * page, before:
 *
 *   cognitive-adhd           motorCapacity 0.741 (best)    0.0499
 *   motor-impairment-tremor  motorCapacity 0.438 (worst)   0.0262
 *
 * The best pointer paid nearly twice the worst.
 *
 * @since 2026-08-03
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COGNITIVE_TRAITS, buildOTCognitiveProfile } from "../src/visual/cognitive-transport.js";
import { computeDemandDistribution, computeSequentialCTC } from "../src/visual/cognitive-transport-chain.js";

const CHAIN = readFileSync(join(import.meta.dir, "..", "src", "visual", "cognitive-transport-chain.ts"), "utf8");
const page = (interactiveElementCount: number) => computeDemandDistribution({
  informationDensity: 0.4, visualComplexity: 0.3, interactiveElementCount,
  textDensity: 0.4, animationLevel: 0, choiceCount: 5, navigationDepth: 1,
} as never);
const base: Record<string, number> = Object.fromEntries(
  (COGNITIVE_TRAITS as readonly string[]).map((t) => [t, 0.5]));
const motorCost = (traits: Record<string, number>, controls = 10) => {
  const r = computeSequentialCTC(buildOTCognitiveProfile("p", traits), page(controls),
    { asymmetric: true, interactions: true });
  return (r.layers as Array<{ name: string; transportCost: number }>).find((l) => l.name === "motor")!.transportCost;
};

describe("a better pointer never costs more", () => {
  test("motor cost is non-increasing in motorCapacity, at every page density", () => {
    for (const controls of [3, 10, 25, 40, 80]) {
      const costs = [0.3, 0.45, 0.6, 0.75, 0.9].map((mc) => motorCost({ ...base, motorCapacity: mc }, controls));
      for (let i = 1; i < costs.length; i++) {
        expect({ controls, step: i, ordered: costs[i] <= costs[i - 1] + 1e-9 })
          .toEqual({ controls, step: i, ordered: true });
      }
    }
  });

  test("surplus pointing capacity is free, not merely cheap", () => {
    // Above the page's demand the cost must stop moving entirely. Billed at
    // 0.3 it kept rising, which is how the best pointer came to pay most.
    const above = [0.75, 0.85, 0.95, 1.0].map((mc) => motorCost({ ...base, motorCapacity: mc }, 3));
    expect(new Set(above.map((c) => c.toFixed(9))).size).toBe(1);
  });

  test("the dimension is declared surplus-free alongside the others", () => {
    expect(CHAIN).toMatch(/SURPLUS_FREE_DIMENSIONS = new Set\(\[[^\]]*'motorCapacity'/);
  });
});

describe("the layer and the audit are different instruments (D-9)", () => {
  test("the layer reads a COUNT, not elements", () => {
    // BUG-11's observation, as a property. One element in or out barely moves
    // the layer, because the layer never saw the element.
    const t = { ...base, motorCapacity: 0.4 };
    const delta = Math.abs(motorCost(t, 60) - motorCost(t, 59));
    expect(delta).toBeLessThan(0.01);
    // But a large change in element count DOES move it, or the layer would be
    // inert rather than coarse.
    expect(Math.abs(motorCost(t, 100) - motorCost(t, 5))).toBeGreaterThan(0.01);
  });

  test("the layer carries both pointing and procedural capacity, and says so", () => {
    const block = CHAIN.slice(CHAIN.indexOf("name: 'motor'"), CHAIN.indexOf("name: 'frustration'"));
    const traits = block.match(/traits: \[([^\]]*)\]/)![1];
    expect(traits).toContain("motorCapacity");
    expect(traits).toContain("proceduralFluency");
    // And the note states the relationship the report asked about, the way the
    // legibilityQuality note resolved BUG-03 without code.
    expect(block).toContain("NOT THE POINTING MODEL");
    expect(block).toContain("motorAccessibility");
    expect(block).toContain("reads a COUNT and the audit reads ELEMENTS");
  });

  test("the open calibration question is recorded, not silently resolved", () => {
    // Whether the two halves should weigh equally is a decision about a
    // calibrated instrument. Writing a comment is not licence to change it.
    const block = CHAIN.slice(CHAIN.indexOf("name: 'motor'"), CHAIN.indexOf("name: 'frustration'"));
    expect(block).toContain("principal's to answer");
  });
});
