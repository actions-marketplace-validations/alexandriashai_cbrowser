/**
 * The three vectors the transport chain runs on must line up.
 *
 * A persona's capacity lives in COGNITIVE_TRAITS. A page's demand lives in
 * DEMAND_DIMENSIONS. Cost is transport between them, attributed to whichever of
 * the six layers claims that dimension in LAYER_DEFINITIONS. A dimension missing
 * from any one of the three is silently inert: it is read, carried, and then
 * contributes nothing, with no error anywhere.
 *
 * That is not theoretical. `siteFamiliarity` was missing from TWO of them
 * (2026-08-02). It was a member of COGNITIVE_TRAITS, so every persona carried a
 * value and the tool accepted a per-run parameter for it — and three runs at
 * familiarity unset, 1 and 0 returned byte-identical results across all six
 * layers, every interaction term, and every derived field, while the response
 * attested `siteFamiliaritySource: "supplied for this run"`. The parameter was
 * never overridden by anything. Nothing ever asked for it.
 *
 * The behavioural test below is the one that would have caught it, and it is
 * the check that was missing when the parameter shipped: not "was the input
 * accepted" but "did the output move".
 *
 * @since 2026-08-02
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COGNITIVE_TRAITS, buildOTCognitiveProfile } from "../src/visual/cognitive-transport.js";
import { DEMAND_DIMENSIONS, computeDemandDistribution, computeSequentialCTC } from "../src/visual/cognitive-transport-chain.js";

const CHAIN_SRC = readFileSync(join(import.meta.dir, "..", "src", "visual", "cognitive-transport-chain.ts"), "utf8");

function traitsUsedByLayers(): Set<string> {
  const block = CHAIN_SRC.slice(CHAIN_SRC.indexOf("LAYER_DEFINITIONS"), CHAIN_SRC.indexOf("INTERACTION_PAIRS"));
  return new Set(Array.from(block.matchAll(/'([a-zA-Z]+)'/g), (m) => m[1]));
}

/**
 * Traits that reach no layer TODAY, recorded so a new one cannot join them
 * unnoticed.
 *
 * This list is a defect, not a design: nine of twenty-six dimensions are read
 * off every persona and contribute nothing to its score, which means two
 * personas differing only in `curiosity` or `trustCalibration` produce the same
 * cognitive transport cost. It is pinned rather than fixed because the six-layer
 * weighting is a calibrated research instrument and re-partitioning it changes
 * every number the tool has ever produced — that is the principal's call, not a
 * side effect of a bug fix.
 */
const KNOWN_UNLAYERED = [
  "attributionStyle", "authoritySensitivity", "curiosity", "interruptRecovery",
  "mentalModelRigidity", "metacognitivePlanning", "persistence", "timeHorizon",
  "trustCalibration",
].sort();

/** Traits with no demand term today. Same status: recorded, not blessed. */
const KNOWN_UNDEMANDED = ["attributionStyle", "authoritySensitivity", "timeHorizon"].sort();

describe("siteFamiliarity actually reaches the chain", () => {
  const baseTraits: Record<string, number> = Object.fromEntries(
    (COGNITIVE_TRAITS as readonly string[]).map((t) => [t, 0.5]),
  );
  // Navigation depth is what makes a page demand site knowledge; a one-click
  // page legitimately demands none, so the probe uses a page with real depth.
  const deepPage = {
    informationDensity: 0.6, visualComplexity: 0.5, interactiveElementCount: 40,
    textDensity: 0.5, animationLevel: 0.1, choiceCount: 12, navigationDepth: 4,
  } as never;

  function run(fam: number): { total: number; cognitiveLoad: number } {
    const demand = computeDemandDistribution(deepPage);
    const profile = buildOTCognitiveProfile("probe", { ...baseTraits, siteFamiliarity: fam });
    const r = computeSequentialCTC(profile, demand, { asymmetric: true, interactions: true });
    const cl = r.layers.find((l: { name: string }) => l.name === "cognitiveLoad");
    return { total: r.totalCTC, cognitiveLoad: (cl as { transportCost: number }).transportCost };
  }

  test("familiarity 0 and 1 produce different totals", () => {
    // The report's regression check, verbatim: run(fam=0) !== run(fam=1).
    const a = run(0), b = run(1);
    expect(a.total).not.toBe(b.total);
  });

  test("a first-time visitor pays MORE, not less", () => {
    // Direction matters as much as difference — a wired-up-backwards parameter
    // also passes "the numbers differ".
    expect(run(0).total).toBeGreaterThan(run(1).total);
    expect(run(0).cognitiveLoad).toBeGreaterThan(run(1).cognitiveLoad);
  });

  test("the page must demand site knowledge for familiarity to matter", () => {
    // A one-click page asks nothing of your site knowledge, so familiarity
    // legitimately does not move the number there. If this ever stops holding,
    // the demand term has become a constant rather than a function of depth.
    const flat = computeDemandDistribution({ ...(deepPage as object), navigationDepth: 0 } as never);
    expect(flat.demands.siteFamiliarity).toBe(0);
  });

  test("it has a demand term and a home layer", () => {
    expect(DEMAND_DIMENSIONS as readonly string[]).toContain("siteFamiliarity");
    expect(traitsUsedByLayers().has("siteFamiliarity")).toBe(true);
  });
});

describe("no dimension goes silently inert", () => {
  test("every trait either reaches a layer or is on the known-unlayered list", () => {
    const used = traitsUsedByLayers();
    const unlayered = (COGNITIVE_TRAITS as readonly string[]).filter((t) => !used.has(t)).sort();
    // A new name here means a trait was added to the persona vector and wired to
    // nothing — read off every persona, contributing to no score.
    expect(unlayered).toEqual(KNOWN_UNLAYERED);
  });

  test("every trait either has a demand term or is on the known-undemanded list", () => {
    const dem = new Set(DEMAND_DIMENSIONS as readonly string[]);
    const undemanded = (COGNITIVE_TRAITS as readonly string[]).filter((t) => !dem.has(t)).sort();
    expect(undemanded).toEqual(KNOWN_UNDEMANDED);
  });

  test("the orphan lists are shrinking-only", () => {
    // Guards the guard: if someone fixes a trait, they must shorten the list,
    // and the test fails loudly rather than passing on a stale allowlist.
    const used = traitsUsedByLayers();
    for (const t of KNOWN_UNLAYERED) {
      expect(used.has(t)).toBe(false);
    }
  });
});

describe("siteFamiliarity is not stored on personas", () => {
  test("it is absent from every builtin definition", () => {
    const personas = readFileSync(join(import.meta.dir, "..", "src", "personas.ts"), "utf8");
    // A persona-SITE pair cannot be a stored disposition: "familiar with which
    // site?" has no answer until a URL is named.
    //
    // Matched as an assigned NUMBER, not the bare identifier: stripStoredFamiliarity
    // destructures the key by name, and a test that forbids the string outright
    // fails on the very guard that enforces it. Comparing a boolean also keeps a
    // failure from dumping the whole file into the output.
    const storedValues = personas.match(/siteFamiliarity:\s*[0-9]/g) ?? [];
    expect(storedValues.length).toBe(0);
  });

  test("the save path strips it, so it cannot come back through a write", () => {
    const personas = readFileSync(join(import.meta.dir, "..", "src", "personas.ts"), "utf8");
    expect(personas).toContain("export function stripStoredFamiliarity");
    expect(personas).toMatch(/writeFileSync\(filepath, JSON\.stringify\(stripStoredFamiliarity\(persona\)/);
  });
});

describe("an unknown persona is refused, not fabricated", () => {
  test("resolving a name that does not exist throws", async () => {
    const { resolvePersonaOrThrow } = await import("../src/personas.js");
    // It used to return createCognitivePersona(name, name, {}) — a complete
    // persona with every trait at 0.5, named after the typo, which then
    // produced a full six-layer breakdown, an abandonment risk and an
    // interpretation sentence quoting the typo as a subject. In range,
    // plausible, and indistinguishable from a measurement.
    expect(() => resolvePersonaOrThrow("zzz-not-a-real-persona")).toThrow(/Unknown persona/);
  });

  test("the refusal says nothing was measured", async () => {
    const { resolvePersonaOrThrow } = await import("../src/personas.js");
    try {
      resolvePersonaOrThrow("zzz-not-a-real-persona");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("Nothing was measured");
    }
  });

  test("a near miss suggests the real name", async () => {
    const { suggestPersonaNames } = await import("../src/personas.js");
    // Case and punctuation are the commonest misses, then typos.
    expect(suggestPersonaNames("POWER-USER")).toContain("power-user");
    expect(suggestPersonaNames("power user")).toContain("power-user");
    expect(suggestPersonaNames("first-timr")).toContain("first-timer");
  });

  test("supplying traits still defines an ad-hoc persona", async () => {
    const { resolvePersonaOrThrow } = await import("../src/personas.js");
    // The one legitimate synthesis: a caller defining a persona outright.
    // Supplying NO traits and no known name is a typo, not a definition.
    const p = resolvePersonaOrThrow("adhoc-probe", { patience: 0.2 }) as { name: string };
    expect(p.name).toBe("adhoc-probe");
  });

  test("no tool still falls back to an all-default persona", () => {
    // Class-sweep guard: the fabrication signature is
    // `createCognitivePersona(x, x, {})` reached on a resolution miss.
    const files = [
      "src/mcp-tools/base/persona-comparison-tools.ts",
      "src/mcp-tools/base/audit-tools.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(import.meta.dir, "..", f), "utf8");
      // Every remaining `|| createCognitivePersona(...)` must be guarded by a
      // resolvePersonaOrThrow on the line above it.
      const unguarded = src.split("\n").filter((line, i, all) =>
        /\|\| createCognitivePersona\(/.test(line) &&
        !/resolvePersonaOrThrow/.test(all.slice(Math.max(0, i - 3), i + 1).join("\n")));
      expect(unguarded).toEqual([]);
    }
  });
});
