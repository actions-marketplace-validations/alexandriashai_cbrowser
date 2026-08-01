/**
 * Trait directions on influence patterns must point the way susceptibility
 * actually runs.
 *
 * `direction` is susceptibility-facing, not virtue-facing: "positive" means a
 * higher trait value makes the persona MORE persuadable. That is easy to get
 * backwards, and it was: trustCalibration reads high for someone who trusts
 * readily (impatient-user carries 0.7, commented "clicks through without
 * reading"), but it was coded "negative" on scarcity, authority and liking.
 * The result scored a skeptic as more persuadable than a credulous user on
 * three of Cialdini's patterns, and nothing in the payload contradicted it --
 * the numbers looked perfectly reasonable in isolation.
 *
 * These assert the ordering property rather than any particular score, so they
 * survive re-weighting and re-calibration and only fail if a direction flips.
 */
import { describe, expect, test } from "bun:test";
import { INFLUENCE_PATTERNS, calculatePatternSusceptibility } from "../src/values/value-mappings.js";

const NEUTRAL_VALUES = {
  selfDirection: 0.5, stimulation: 0.5, hedonism: 0.5, achievement: 0.5, power: 0.5,
  security: 0.5, conformity: 0.5, tradition: 0.5, benevolence: 0.5, universalism: 0.5,
};

const pattern = (name: string) => {
  const p = INFLUENCE_PATTERNS.find((x) => x.name === name);
  if (!p) throw new Error(`no influence pattern named ${name}`);
  return p;
};

/** Score a pattern with one trait swept low and high, everything else neutral. */
const sweep = (patternName: string, trait: string): { low: number; high: number } => {
  const p = pattern(patternName);
  const at = (v: number) => calculatePatternSusceptibility(NEUTRAL_VALUES, p, { [trait]: v });
  return { low: at(0.1), high: at(0.9) };
};

describe("influence trait directions", () => {
  test("trusting readily makes a persona MORE persuadable, never less", () => {
    for (const name of ["scarcity", "authority", "liking"]) {
      const p = pattern(name);
      if (!p.relatedTraits?.some((t) => t.trait === "trustCalibration")) continue;
      const { low, high } = sweep(name, "trustCalibration");
      expect(high).toBeGreaterThan(low);
    }
  });

  test("the trait a pattern is named for moves that pattern in the obvious direction", () => {
    // anchoringBias -> anchoring, socialProofSensitivity -> social_proof.
    // These are the cases where an inversion is most visible and least excusable.
    for (const [name, trait] of [["anchoring", "anchoringBias"], ["social_proof", "socialProofSensitivity"]] as const) {
      const p = pattern(name);
      if (!p.relatedTraits?.some((t) => t.trait === trait)) continue;
      const { low, high } = sweep(name, trait);
      expect(high).toBeGreaterThan(low);
    }
  });

  test("every declared direction actually moves its pattern that way", () => {
    const wrong: string[] = [];
    for (const p of INFLUENCE_PATTERNS) {
      for (const { trait, direction } of p.relatedTraits ?? []) {
        const { low, high } = sweep(p.name, trait);
        const movesUp = high > low;
        if ((direction === "positive") !== movesUp) {
          wrong.push(`${p.name}/${trait} declared ${direction} but ${movesUp ? "increases" : "decreases"} susceptibility`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("patterns sharing a value target set are separable by traits", () => {
    // social_proof/default_bias, commitment/decoy_effect and
    // anchoring/loss_aversion each share targetValues, so before traits entered
    // the formula they were forced to identical scores.
    const groups = new Map<string, string[]>();
    for (const p of INFLUENCE_PATTERNS) {
      const key = [...p.targetValues].sort().join("+");
      groups.set(key, [...(groups.get(key) ?? []), p.name]);
    }
    for (const [, names] of groups) {
      if (names.length < 2) continue;
      const traitSets = names.map((n) =>
        (pattern(n).relatedTraits ?? []).map((t) => t.trait).sort().join(","));
      // Identical value targets AND identical trait inputs would be an
      // unbreakable tie by construction.
      expect(new Set(traitSets).size).toBeGreaterThan(1);
    }
  });
});
