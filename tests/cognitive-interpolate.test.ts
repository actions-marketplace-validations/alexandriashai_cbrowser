/**
 * Geodesic interpolation must reproduce its own endpoints.
 *
 * `cognitive_interpolate` at position 1.0 returned elderly-low-vision with every
 * trait multiplied by 1/0.9 — attributionStyle 0.9 came back as 1.0, patience
 * 0.70 as 0.7778. At position 0 the factor was 1/0.95. Both are the persona's
 * own largest trait, which is the tell.
 *
 * The cause is a lost quantity, not bad math. `traitsToDistribution` divides
 * every trait by their SUM to get a probability measure; `distributionToTraits`
 * divided by the MAX to get back. Those are different numbers, and the simplex
 * has already discarded the one you need — a distribution cannot be mapped to
 * trait scale at all unless the total mass travels with it.
 *
 * The endpoint identity is the right test precisely because it cannot be
 * satisfied by accident: any rescaling, however plausible, breaks it.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  buildOTCognitiveProfile,
  cognitiveGeodesic,
  cognitiveBarycenter,
  traitsToDistribution,
  distributionToTraits,
  COGNITIVE_TRAITS,
} from "../src/visual/cognitive-transport.js";
import {
  BUILTIN_PERSONAS,
  ACCESSIBILITY_PERSONAS,
  EMOTIONAL_PERSONAS,
  getCognitiveProfile,
} from "../src/personas.js";
import type { Persona, AccessibilityPersona } from "../src/types.js";

const ALL: Record<string, unknown> = {
  ...BUILTIN_PERSONAS,
  ...ACCESSIBILITY_PERSONAS,
  ...EMOTIONAL_PERSONAS,
};

const traitsOf = (name: string) =>
  getCognitiveProfile(ALL[name] as Persona | AccessibilityPersona)
    .traits as unknown as Record<string, number>;

const profileOf = (name: string) => buildOTCognitiveProfile(name, traitsOf(name));

/** Largest absolute difference across the shared trait keys. */
function maxDeviation(a: Record<string, number>, b: Record<string, number>): number {
  let worst = 0;
  for (const t of COGNITIVE_TRAITS) {
    if (typeof a[t] !== "number" || typeof b[t] !== "number") continue;
    worst = Math.max(worst, Math.abs(a[t] - b[t]));
  }
  return worst;
}

describe("endpoint identity", () => {
  test("position 0 reproduces A and position 1 reproduces B, exactly", () => {
    const A = "power-user";
    const B = "elderly-low-vision";
    const geodesic = cognitiveGeodesic(profileOf(A), profileOf(B), 10);

    expect(maxDeviation(geodesic[0].traits, traitsOf(A))).toBeLessThan(1e-9);
    expect(maxDeviation(geodesic[geodesic.length - 1].traits, traitsOf(B))).toBeLessThan(1e-9);
  });

  test("the specific values from the bug report come back correct", () => {
    const geodesic = cognitiveGeodesic(
      profileOf("power-user"),
      profileOf("elderly-low-vision"),
      10,
    );
    const atB = geodesic[geodesic.length - 1].traits;
    // The bug was a NORMALISATION error: every endpoint trait came back 1/0.9
    // too big (0.7 read as 0.7778, 0.9 as 1.0). So the claim is that the
    // endpoint equals the persona, whatever the persona currently is.
    //
    // It used to assert five literals copied from elderly-low-vision, which
    // made a test about interpolation arithmetic fail whenever a persona was
    // legitimately re-tuned -- as it did when the trait vectors were reconciled
    // with their own documentation and patience moved 0.7 to 0.9. Pinning
    // another module's data is how a test starts reporting on the wrong thing.
    const live = traitsOf("elderly-low-vision");
    for (const t of ["patience", "riskTolerance", "comprehension", "workingMemory", "attributionStyle"]) {
      expect(atB[t]).toBeCloseTo(live[t], 6);
      // And specifically not inflated by the 1/0.9 factor the bug applied.
      expect(atB[t]).not.toBeCloseTo(live[t] / 0.9, 6);
    }
  });

  test("PROPERTY: endpoint identity holds for every pair of built-in personas", () => {
    const names = Object.keys(ALL);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: names.length - 1 }),
        fc.integer({ min: 0, max: names.length - 1 }),
        (i, j) => {
          const A = names[i], B = names[j];
          const g = cognitiveGeodesic(profileOf(A), profileOf(B), 4);
          // Exact, EXCEPT where the true trait is under the 0.01 simplex floor —
          // optimal transport needs a measure with no zero atoms, so a trait of
          // exactly 0 (first-timer's siteFamiliarity, the only one) comes back
          // as 0.01. Deviation is allowed there and nowhere else, so a genuine
          // regression on any other trait still fails this.
          for (const [point, name] of [[g[0], A], [g[g.length - 1], B]] as const) {
            const want = traitsOf(name);
            for (const trait of COGNITIVE_TRAITS) {
              const got = point.traits[trait];
              if (typeof got !== "number" || typeof want[trait] !== "number") continue;
              const delta = Math.abs(got - want[trait]);
              if (delta < 1e-9) continue;
              expect({ name, trait, belowFloor: want[trait] < 0.01, delta: delta <= 0.01 + 1e-9 })
                .toEqual({ name, trait, belowFloor: true, delta: true });
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  test("no interpolated trait escapes the 0-1 scale", () => {
    // attributionStyle used to land on exactly 1.0 by being divided by itself.
    const g = cognitiveGeodesic(profileOf("power-user"), profileOf("cognitive-adhd"), 10);
    for (const point of g) {
      for (const t of COGNITIVE_TRAITS) {
        const v = point.traits[t];
        if (typeof v !== "number") continue;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("distributionToTraits is the inverse of traitsToDistribution", () => {
  test("round-trip with the scale reproduces the input", () => {
    const traits = traitsOf("dyslexic-user");
    const profile = buildOTCognitiveProfile("dyslexic-user", traits);
    const back = distributionToTraits(profile.distribution, profile.traitScale);
    expect(maxDeviation(back, traits)).toBeLessThan(1e-9);
  });

  test("without the scale it returns shape only — documented, not silently used", () => {
    const traits = traitsOf("dyslexic-user");
    const profile = buildOTCognitiveProfile("dyslexic-user", traits);
    const shape = distributionToTraits(profile.distribution);
    // Largest trait normalises to 1 — the old behaviour, kept for callers that
    // genuinely want relative shape.
    expect(Math.max(...COGNITIVE_TRAITS.map((t) => shape[t]))).toBeCloseTo(1, 6);
  });

  test("PROPERTY: scale round-trip holds for arbitrary trait vectors", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.01, max: 1, noNaN: true }), {
          minLength: COGNITIVE_TRAITS.length,
          maxLength: COGNITIVE_TRAITS.length,
        }),
        (values) => {
          const traits: Record<string, number> = {};
          COGNITIVE_TRAITS.forEach((t, i) => (traits[t] = values[i]));
          const p = buildOTCognitiveProfile("synthetic", traits);
          const back = distributionToTraits(p.distribution, p.traitScale);
          expect(maxDeviation(back, traits)).toBeLessThan(1e-9);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("traitsToDistribution still yields a probability measure", () => {
    const d = traitsToDistribution(traitsOf("first-timer"));
    expect(Array.from(d).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
});

describe("barycenter lands on the trait scale too", () => {
  test("the barycenter of one persona is that persona", () => {
    const p = profileOf("cognitive-adhd");
    const bary = cognitiveBarycenter([p]);
    expect(maxDeviation(bary.traits, traitsOf("cognitive-adhd"))).toBeLessThan(1e-9);
  });

  test("a two-persona barycenter stays within the traits it averages", () => {
    const a = traitsOf("power-user");
    const b = traitsOf("elderly-low-vision");
    const bary = cognitiveBarycenter([profileOf("power-user"), profileOf("elderly-low-vision")]);
    for (const t of COGNITIVE_TRAITS) {
      if (typeof a[t] !== "number" || typeof b[t] !== "number") continue;
      // Entropic regularisation means the barycenter cannot land exactly on a
      // point mass, so a trait where BOTH personas hold the same value has a
      // zero-width interval the result provably cannot sit inside. Measured
      // 4.58e-4 outside on fearOfMissingOut once the two personas' values
      // converged to 0.2 apiece. That is Sinkhorn smoothing, not drift, so the
      // tolerance is named and small rather than the interval being widened.
      const SINKHORN_SLACK = 1e-3;
      const lo = Math.min(a[t], b[t]) - SINKHORN_SLACK;
      const hi = Math.max(a[t], b[t]) + SINKHORN_SLACK;
      expect({ t, inside: bary.traits[t] >= lo && bary.traits[t] <= hi }).toEqual({ t, inside: true });
    }
  });
});
