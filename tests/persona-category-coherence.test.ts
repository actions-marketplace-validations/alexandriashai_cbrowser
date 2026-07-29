/**
 * Persona category vocabulary coherence.
 *
 * Three lists of categories were maintained by hand and had drifted:
 * CATEGORY_QUESTION offered "agent" but not "emotional", while the
 * persona_questionnaire_build / persona_category_guidance z.enums accepted
 * "emotional" but not "agent". Each side lacked exactly what the other had, so
 * choosing "AI Agent" from the question the tool itself offered was rejected by
 * the tool it told you to call next — a dead end reachable only by following the
 * instructions.
 *
 * Widening the enum then exposed two more gaps that had been hidden by the
 * narrower vocabulary: a safeguards lookup table covering five of six
 * categories, and — worse — no value preset for "agent", so an AI-agent persona
 * silently received GENERAL HUMAN motivational values. A confidently-wrong
 * research-cited profile of the wrong kind of entity is worse than a rejection.
 *
 * The invariant, and the reason this is a test rather than a fixed list: every
 * category a caller can CHOOSE must resolve to its OWN definition. Adding a
 * seventh category is fine; adding one that only half the system knows about is
 * what fails here.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect } from "bun:test";
import {
  PERSONA_CATEGORIES,
  CATEGORY_QUESTION,
  CATEGORY_VALUE_PRESETS,
  getCategoryValuePreset,
  type PersonaCategory,
} from "../src/persona-questionnaire.js";

const offered = CATEGORY_QUESTION.options.map((o) => o.category);

describe("one vocabulary, not three", () => {
  test("every canonical category is offered by the question", () => {
    const missing = PERSONA_CATEGORIES.filter((c) => !offered.includes(c));
    expect(missing).toEqual([]);
  });

  test("every offered category is canonical", () => {
    const stray = offered.filter((c) => !PERSONA_CATEGORIES.includes(c));
    expect(stray).toEqual([]);
  });

  test("no category is offered twice", () => {
    expect(new Set(offered).size).toBe(offered.length);
  });
});

describe("no category dead-ends", () => {
  test("every canonical category resolves to its OWN value preset", () => {
    // The failure this catches is silent: getCategoryValuePreset falls back to
    // "general" for anything unlisted, so a missing preset does not error — it
    // hands back human baseline values under the requested category's name.
    for (const category of PERSONA_CATEGORIES) {
      const preset = getCategoryValuePreset(category as PersonaCategory);
      expect({ category, resolvedTo: preset?.category }).toEqual({
        category,
        resolvedTo: category,
      });
    }
  });

  test("every preset carries guidance and a research basis", () => {
    for (const preset of CATEGORY_VALUE_PRESETS) {
      expect({ c: preset.category, hasGuidance: preset.guidance.length > 0 }).toEqual({
        c: preset.category,
        hasGuidance: true,
      });
      expect({ c: preset.category, cited: preset.researchBasis.length > 0 }).toEqual({
        c: preset.category,
        cited: true,
      });
    }
  });

  test("presets are unique per category", () => {
    const cats = CATEGORY_VALUE_PRESETS.map((p) => p.category);
    expect(new Set(cats).size).toBe(cats.length);
  });
});

describe("the agent category does not borrow human motivation", () => {
  test("every motivational dimension is neutral", () => {
    // Schwartz values and SDT needs are defined over human motivation. Assigning
    // an agent a security drive or a belonging need is a category error, and it
    // is exactly what the "general" fallback produced before this preset existed.
    const agent = getCategoryValuePreset("agent");
    expect(agent?.category).toBe("agent");
    const motivational = [
      "stimulation", "security", "conformity",
      "autonomyNeed", "competenceNeed", "relatednessNeed",
    ] as const;
    for (const key of motivational) {
      const value = (agent?.defaultValues as Record<string, unknown>)[key];
      expect({ key, value }).toEqual({ key, value: 0.5 });
    }
  });

  test("it differentiates on traits, not values", () => {
    expect(getCategoryValuePreset("agent")?.valueStrategy).toBe("trait_based");
  });
});
