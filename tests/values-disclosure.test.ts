import { describe, test, expect } from "bun:test";
import { resolvePersonaValues } from "../src/mcp-tools/base/values-tools.js";

/**
 * Tests for the DISCLOSURE fields, not for the values.
 *
 * These exist because the field built to catch silent placeholders shipped
 * with a silent placeholder of its own: netNudge clamped with
 * `Math.max(epsilon, x)`, which floored every below-midpoint axis to 0 and so
 * reported "nothing targets this" for security and conformity, both of which
 * are genuinely derived. The disclosure was wrong in exactly the way it
 * existed to prevent, and nothing failed, because the disclosure had no tests.
 *
 * A number is checked by other numbers. A disclosure is checked by whether it
 * still tells the truth when the thing it describes changes — so every test
 * here is written to go red on a plausible regression, not to restate the
 * current output. (2026-08-01)
 */

const TRAIT_ROUTE = "alexa-eden";

describe("netNudge disclosure", () => {
  test("the stated transform actually reproduces every stated value", () => {
    // The disclosure claims value = 0.5 + tanh(nudge)/2. If the squash ever
    // changes and the note does not, this goes red -- which is the whole
    // point: a transform stated in prose is a claim, and claims get probed.
    const r = resolvePersonaValues(TRAIT_ROUTE);
    expect(r.netNudge).toBeDefined();
    expect(r.valueTransform).toContain("tanh");
    const all = { ...(r.values ?? {}), ...(r.sdt ?? {}) };
    const checked: string[] = [];
    for (const [axis, nudge] of Object.entries(r.netNudge!)) {
      if (typeof all[axis] !== "number") continue;
      const predicted = Math.round((0.5 + Math.tanh(nudge) / 2) * 1000) / 1000;
      expect({ axis, predicted }).toEqual({ axis, predicted: all[axis] });
      checked.push(axis);
    }
    expect(checked.length).toBe(13);
  });

  test("sign is preserved, so a below-midpoint axis is not reported as untouched", () => {
    // The original bug, pinned. `Math.max(epsilon, x)` made every negative
    // nudge read 0 -- identical to an axis no trait reaches.
    const r = resolvePersonaValues(TRAIT_ROUTE);
    const below = Object.entries(r.values ?? {}).filter(([, v]) => v < 0.5).map(([k]) => k);
    expect(below.length).toBeGreaterThan(0);
    for (const axis of below) {
      expect({ axis, sign: Math.sign(r.netNudge![axis]) }).toEqual({ axis, sign: -1 });
    }
  });

  test("an axis no trait reaches is exactly 0, not merely small", () => {
    const r = resolvePersonaValues(TRAIT_ROUTE);
    for (const axis of r.unpopulatedAxes ?? []) {
      expect({ axis, nudge: r.netNudge![axis] }).toEqual({ axis, nudge: 0 });
    }
  });
});

describe("contamination disclosure", () => {
  test("clean rollups are stated, never encoded as an absent key", () => {
    // Reporting only the contaminated entries makes a reader infer meaning
    // from absence, which is the same defect the field exists to remove.
    const r = resolvePersonaValues(TRAIT_ROUTE);
    const c = r.higherOrderContamination!;
    expect(Object.keys(c).sort()).toEqual(
      ["conservation", "openness", "selfEnhancement", "selfTranscendence"]);
    expect(c.openness).toBe("0 of 2 inputs unpopulated");
    expect(c.selfTranscendence).toContain("universalism");
  });

  test("every Maslow level reports its input count, clean ones included", () => {
    const r = resolvePersonaValues(TRAIT_ROUTE);
    const c = r.maslowContamination!;
    expect(Object.keys(c).sort()).toEqual(
      ["belonging", "esteem", "safety", "self-actualization"]);
    expect(c.safety).toBe("0 of 2 inputs unpopulated");
  });
});

describe("Maslow scoring is not shrunk toward the midpoint", () => {
  test("a contaminated level is scored on its live inputs only", () => {
    // Averaging a live axis against an imputed 0.5 pulls that level halfway to
    // the midpoint while leaving fully-populated levels untouched, so it
    // reorders the ranking rather than only compressing it. If anyone
    // reinstates the imputed average as the score, the basis string picks up a
    // second term and this goes red.
    const r = resolvePersonaValues(TRAIT_ROUTE);
    expect(r.maslowBasis).toBe("(selfDirection 0.703) / 1");
    expect(r.maslowRunnerUp).toBe("esteem 0.698 = (achievement 0.698) / 1");
    expect(r.maslowMargin).toBe(0.005);
  });

  test("the caveat names composition, not only the margin", () => {
    const r = resolvePersonaValues(TRAIT_ROUTE);
    expect(r.maslowCaveat).toContain("excluded rather than imputed");
    expect(r.maslowCaveat).toContain("reorders the ranking");
  });
});

describe("route disclosure", () => {
  test("the trait route is named as itself, not as a generic 'derived'", () => {
    // 'derived' spanned the Big Five route and the cognitive-trait route --
    // the two that differ most in how far they should be trusted.
    const r = resolvePersonaValues(TRAIT_ROUTE);
    expect(r.source).toBe("cognitive_traits");
    expect(r.storedIn).toBe("persona");
  });

  test("an unknown persona resolves to none rather than throwing", () => {
    expect(resolvePersonaValues("no-such-persona-xyz").source).toBe("none");
  });
});

describe("no disclosure field is computed and then dropped", () => {
  /**
   * The recurring defect in this file, caught six times in one day: a field is
   * added to the resolver, the tool payload hand-picks fields by name, and the
   * new one is silently absent. netNudge, maslowContamination, maslowRunnerUp,
   * valueTransform, topScoring and higherOrderWithImputed each shipped that way.
   *
   * Patching the seventh occurrence is not a fix. This asserts the invariant
   * instead: everything the resolver computes for a persona must be reachable
   * somewhere in the JSON the tool actually returns. Adding a resolver field
   * without surfacing it now fails here rather than being noticed by a reader.
   */
  test("every resolver field reaches the persona_values_lookup payload", async () => {
    const { buildValuesPayloadForTest } = await import("../src/mcp-tools/base/values-tools.js");
    const resolved = resolvePersonaValues(TRAIT_ROUTE);
    const json = JSON.stringify(await buildValuesPayloadForTest(TRAIT_ROUTE));

    // Structural fields consumed to BUILD the payload rather than printed in
    // it. Each is deliberate; anything else missing is the bug above.
    const consumedInternally = new Set(["values", "sdt", "hypothesisAxes"]);

    // Resolver name -> payload name, where they differ. Listing them is the
    // point as much as the check is: this is the only place the drift between
    // the two vocabularies is written down, and every entry is a small tax a
    // reader pays when moving between the resolver and the payload.
    const renamedInPayload: Record<string, string> = {
      storedIn: "valuesStoredIn",
      sdtSource: "selfDeterminationSource",
      higherOrder: "higherOrderValues",
      maslowMargin: "marginOverRunnerUp",
      source: "valuesSource",
    };

    const missing = Object.entries(resolved)
      .filter(([k, v]) => !consumedInternally.has(k) && v !== undefined)
      .filter(([k]) => {
        // Surfaced if the resolver name, its payload rename, or the
        // maslow-prefix-stripped form appears as a key in the JSON.
        const bare = k.replace(/^maslow/, "");
        const stripped = bare.charAt(0).toLowerCase() + bare.slice(1);
        const candidates = [k, stripped, renamedInPayload[k]].filter(Boolean) as string[];
        return !candidates.some((c) => json.includes(`"${c}"`));
      })
      .map(([k]) => k);

    expect(missing).toEqual([]);
  });
});
