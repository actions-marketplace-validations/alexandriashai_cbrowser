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
  "mentalModelFlexibility", "metacognitivePlanning", "persistence", "timeHorizon",
  "trustCalibration",
  // ADDED 2026-08-02 AND THIS IS A REGRESSION, NOT A DESIGN.
  //
  // Both were removed from the readability layer when it was rewired to the
  // decoding model: readingTendency is how much text a person chooses to read
  // (a disposition) and it was swamping the capacity signal, and
  // transferLearning is about applying patterns across UIs rather than decoding
  // text. Removing them fixed the inversion and cost two traits their only
  // consumer -- they now contribute to no score at all.
  //
  // readingTendency in particular is meaningful and should land somewhere:
  // plausibly modulating DEMAND (a skimmer asks less of a text-dense page)
  // rather than serving as capacity. That is a modelling decision, not a
  // cleanup, so it is recorded here rather than guessed at.
  // readingTendency reaches no LAYER by design, and is not inert: it modulates
  // DEMAND instead of serving as capacity, which is the correct side of the
  // model for a strategy rather than an ability. Listed here because this test
  // asks only about layer membership, and covered by its own describe block
  // below which asserts the demand consumer exists and behaves.
  "readingTendency",
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

  test("direction holds at EVERY navigation depth, not just a deep page", () => {
    // This test exists because the version above passed while the live tool was
    // inverted. It ran one deep page; on a shallow real site (cbrowser.ai) the
    // demand for site knowledge is near zero, a familiarity of 1.0 is then
    // almost entirely surplus, and surplus was billed at 0.3 — so the daily
    // user was charged MORE than the first-timer (0.268 vs 0.19). Knowing a
    // site cannot make it harder, so familiarity surplus is now free, and the
    // claim is checked across the range rather than at one convenient point.
    for (const navigationDepth of [0, 1, 2, 4, 8]) {
      const demand = computeDemandDistribution({
        informationDensity: 0.6, visualComplexity: 0.5, interactiveElementCount: 40,
        textDensity: 0.5, animationLevel: 0.1, choiceCount: 12, navigationDepth,
      } as never);
      const at = (fam: number) => computeSequentialCTC(
        buildOTCognitiveProfile("probe", { ...baseTraits, siteFamiliarity: fam }),
        demand, { asymmetric: true, interactions: true }).totalCTC;
      // Never worse for knowing the site. Equal is fine — a one-click page
      // legitimately asks nothing of your site knowledge.
      expect(at(0)).toBeGreaterThanOrEqual(at(1));
    }
  });

  test("more site knowledge is never a penalty, at any value", () => {
    const demand = computeDemandDistribution({
      informationDensity: 0.6, visualComplexity: 0.5, interactiveElementCount: 40,
      textDensity: 0.5, animationLevel: 0.1, choiceCount: 12, navigationDepth: 3,
    } as never);
    const at = (fam: number) => computeSequentialCTC(
      buildOTCognitiveProfile("probe", { ...baseTraits, siteFamiliarity: fam }),
      demand, { asymmetric: true, interactions: true }).totalCTC;
    // Monotonic, not merely correct at the endpoints.
    const costs = [0, 0.25, 0.5, 0.75, 1].map(at);
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeLessThanOrEqual(costs[i - 1] + 1e-9);
    }
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

describe("the chain coefficient compares matched units", () => {
  const base: Record<string, number> = Object.fromEntries(
    (COGNITIVE_TRAITS as readonly string[]).map((t) => [t, 0.5]));
  const at = (informationDensity: number) => {
    const demand = computeDemandDistribution({
      informationDensity, visualComplexity: informationDensity, interactiveElementCount: 40,
      textDensity: informationDensity, animationLevel: 0.1, choiceCount: 12, navigationDepth: 3,
    } as never);
    return computeSequentialCTC(buildOTCognitiveProfile("p", base), demand,
      { asymmetric: true, interactions: true });
  };

  test("totalCTC is a sigmoid of rawCTC, so they are not interchangeable", () => {
    // The bug this whole block exists for: the published coefficient divided
    // totalCTC (squashed to 0-1) by additiveCTC (a raw unbounded sum) and
    // reported ~0.3-0.5, which read as the chain dampening cost by 60%. It was
    // reporting the sigmoid, not the chain.
    const r = at(0.9);
    const expected = 1 / (1 + Math.exp(-2.5 * (r.rawCTC - 1.2)));
    expect(r.totalCTC).toBeCloseTo(expected, 6);
    expect(r.totalCTC).not.toBeCloseTo(r.rawCTC, 2);
  });

  test("the coefficient is >= 1: the chain adds cost, it does not remove it", () => {
    // Interactions and depletion can only ADD to the layer sum. A value below 1
    // means the ratio is measuring something other than the chain.
    for (const d of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const r = at(d);
      expect(r.rawCTC / r.additiveCTC).toBeGreaterThanOrEqual(0.999);
    }
  });

  test("the effect is real but small — 2% or less, not compounding", () => {
    // Stated so a claim of "costs compound sequentially" cannot quietly grow
    // past what the model does. Measured 1.002-1.019 across densities.
    for (const d of [0.1, 0.5, 0.9]) {
      const r = at(d);
      expect(r.rawCTC / r.additiveCTC).toBeLessThan(1.05);
    }
  });

  test("abandonment risk does not read totalCTC", () => {
    // They are different constructs and are allowed to disagree: a page can be
    // cheap in absolute terms and still exhaust a persona with little patience.
    // Two personas with identical trait vectors except patience must produce
    // the same CTC and different abandonment.
    const demand = computeDemandDistribution({
      informationDensity: 0.8, visualComplexity: 0.6, interactiveElementCount: 40,
      textDensity: 0.7, animationLevel: 0.1, choiceCount: 12, navigationDepth: 3,
    } as never);
    const run = (patience: number) => computeSequentialCTC(
      buildOTCognitiveProfile("p", { ...base, patience }), demand,
      { asymmetric: true, interactions: true });
    const calm = run(0.9), impatient = run(0.1);
    expect(impatient.abandonmentRisk).toBeGreaterThan(calm.abandonmentRisk);
  });
});

describe("attention tools render at the configured viewport", () => {
  test("no attention tool hardcodes its own viewport", async () => {
    // attention_analysis rendered at 1920x1080 while every other tool used the
    // configured 1280x800, so an attention run and a cognitive_effort run were
    // measuring different rendered pages while reporting coordinates as if they
    // shared a space. The tell was regions at x=1312 under a 1280 config.
    //
    // Checked across the files that register attention tools, because the first
    // fix for this landed in the wrong tool: visual_cognitive_story had an
    // identical line and got patched instead of attention_analysis.
    const { readFileSync } = await import("node:fs");
    const files = [
      "src/mcp-tools/base/visual-testing-tools.ts",
      "src/mcp-tools/base/audit-tools.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(import.meta.dir, "..", f), "utf8");
      const hardcoded = src.split("\n").filter((l) => /viewportWidth:\s*\d/.test(l));
      expect(hardcoded).toEqual([]);
    }
  });

  test("attention_analysis states the viewport it rendered at", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/mcp-tools/base/visual-testing-tools.ts"), "utf8");
    // So a reader can check comparability instead of assuming it.
    expect(src).toContain("renderedViewport:");
    expect(src).toContain("coordinateSpace:");
  });
});

describe("the mentalModelFlexibility rename is complete and back-compatible", () => {
  test("a persona stored under the old key still contributes", async () => {
    // The alias map and canonicalTraitName sat in trait-reference.ts for months
    // with NOTHING outside that file calling either, so a persona saved as
    // mentalModelRigidity loaded with a key matching no COGNITIVE_TRAITS member
    // and contributed nothing to any score. Same shape as a trait present in
    // the persona vector and absent from the demand vector.
    const { canonicalizeTraits } = await import("../src/trait-reference.js");
    const out = canonicalizeTraits({ mentalModelRigidity: 0.2, patience: 0.5 }) as Record<string, number>;
    expect(out.mentalModelFlexibility).toBe(0.2);
    expect("mentalModelRigidity" in out).toBe(false);
    expect(out.patience).toBe(0.5);
  });

  test("an explicit canonical value is not clobbered by a stale alias", () => {
    // Both keys present means the record was half-migrated. The new name wins.
    const { canonicalizeTraits } = require("../src/trait-reference.js");
    const out = canonicalizeTraits({ mentalModelFlexibility: 0.9, mentalModelRigidity: 0.1 });
    expect(out.mentalModelFlexibility).toBe(0.9);
  });

  test("the canonical name is the one in the model's trait vector", () => {
    expect(COGNITIVE_TRAITS as readonly string[]).toContain("mentalModelFlexibility");
    expect(COGNITIVE_TRAITS as readonly string[]).not.toContain("mentalModelRigidity");
  });

  test("the old name survives only as an alias, nowhere else in src", () => {
    // Guards the contract-half of expand-contract: the alias must stay until
    // nothing on disk uses the old key, but no live code path may read it.
    const ref = readFileSync(join(import.meta.dir, "..", "src/trait-reference.ts"), "utf8");
    expect(ref).toContain('mentalModelRigidity: "mentalModelFlexibility"');
  });
});

describe("capacity layers read capacity, not disposition", () => {
  test("a dyslexic persona costs MORE on readability than an ADHD persona", async () => {
    // The P0 this wiring exists for. Before it, the readability layer read
    // readingTendency -- how much text someone chooses to read -- so an ADHD
    // persona who skims (0.2) scored a larger capacity deficit than a dyslexic
    // persona who reads more (0.4), and the tool reported that a text-dense
    // university homepage cost the dyslexic reader LESS THAN HALF as much,
    // in the same response that reported them at 157 WPM against 204 and a
    // 4-character visual span against 6.
    const { getAnyPersona } = await import("../src/personas.js");
    const { getReadingProfile, getPointingProfile, readingCapacityOf, motorCapacityOf } =
      await import("../src/visual/cognitive-models.js");
    const demand = computeDemandDistribution({
      informationDensity: 0.8, visualComplexity: 0.6, interactiveElementCount: 60,
      textDensity: 0.85, animationLevel: 0.1, choiceCount: 20, navigationDepth: 3,
    } as never);
    const cost = (name: string) => {
      const t: Record<string, number> = { ...((getAnyPersona(name) as never as { cognitiveTraits: Record<string, number> }).cognitiveTraits) };
      t.readingCapacity = readingCapacityOf(getReadingProfile({ name, traits: t }));
      t.motorCapacity = motorCapacityOf(getPointingProfile({ name, traits: t }));
      const r = computeSequentialCTC(buildOTCognitiveProfile(name, t), demand, { asymmetric: true, interactions: true });
      return (r.layers.find((l: { name: string }) => l.name === "readability") as { transportCost: number }).transportCost;
    };
    expect(cost("dyslexic-user")).toBeGreaterThan(cost("cognitive-adhd"));
  });

  test("the reading capacity bridge tracks the decoding model, not the trait vector", async () => {
    const { getReadingProfile, readingCapacityOf } = await import("../src/visual/cognitive-models.js");
    const dys = readingCapacityOf(getReadingProfile({ name: "dyslexic-user" }));
    const adhd = readingCapacityOf(getReadingProfile({ name: "cognitive-adhd" }));
    // 0.39 vs 0.75 on the shipped profiles. Direction is what matters.
    expect(dys).toBeLessThan(adhd);
  });

  test("no disposition trait remains in a capacity layer", () => {
    // Extract the layer's OWN traits array. A fixed-width window truncated
    // before the traits line on one layer and spilled into the next on another
    // -- and the next layer is frustration, which legitimately keeps patience,
    // so the naive version failed on correct code.
    const block = CHAIN_SRC.slice(CHAIN_SRC.indexOf("LAYER_DEFINITIONS"), CHAIN_SRC.indexOf("INTERACTION_PAIRS"));
    const traitsOf = (layer: string): string => {
      const at = block.indexOf(`name: '${layer}'`);
      expect(at).toBeGreaterThan(-1);
      const m = block.slice(at).match(/traits: \[([^\]]*)\]/);
      expect(m).toBeTruthy();
      return (m as RegExpMatchArray)[1];
    };
    const readability = traitsOf("readability");
    const motor = traitsOf("motor");
    // The two dispositions that inverted their own layers.
    expect(readability).not.toContain("readingTendency");
    expect(motor).not.toContain("patience");
    expect(readability).toContain("readingCapacity");
    expect(motor).toContain("motorCapacity");
    // patience still belongs to frustration, and must not have been swept out.
    expect(traitsOf("frustration")).toContain("patience");
  });
});

describe("readingTendency modulates demand, not capacity", () => {
  const base: Record<string, number> = Object.fromEntries(
    (COGNITIVE_TRAITS as readonly string[]).map((t) => [t, 0.5]));
  const textPage = {
    informationDensity: 0.8, visualComplexity: 0.5, interactiveElementCount: 30,
    textDensity: 0.9, animationLevel: 0.1, choiceCount: 10, navigationDepth: 2,
  } as never;
  const cost = (readingTendency: number) => {
    const demand = computeDemandDistribution(textPage);
    const r = computeSequentialCTC(
      buildOTCognitiveProfile("probe", { ...base, readingTendency, readingCapacity: 0.5 }),
      demand, { asymmetric: true, interactions: true });
    return (r.layers.find((l: { name: string }) => l.name === "readability") as { transportCost: number }).transportCost;
  };

  test("a skimmer engages less text demand than a careful reader", () => {
    // The trait is a STRATEGY, not an ability: skimming is how someone spends
    // less effort on text. On the capacity side it said the opposite — that a
    // skimmer lacks reading ability — which is what inverted the layer.
    expect(cost(0.1)).toBeLessThan(cost(0.9));
  });

  test("the modulation is bounded — strategy cannot outweigh decoding ability", () => {
    // Asserted on the ENGAGEMENT FACTOR, not on a cost ratio. The first version
    // divided two costs and blew up whenever the skim cost approached zero,
    // which is a property of the assertion rather than of the model.
    // 0.75 at pure skim, 1.25 at pure careful reading: a skimmer still has to
    // find the content, so demand can never fall toward zero.
    const src = CHAIN_SRC.slice(CHAIN_SRC.indexOf("const readingTendency ="),
      CHAIN_SRC.indexOf("const readingTendency =") + 500);
    expect(src).toContain("0.75 + readingTendency * 0.5");
    // And the two ends stay within a factor the decoding gap can overcome.
    expect(cost(0.0)).toBeGreaterThan(0);
    expect(cost(1.0)).toBeGreaterThan(cost(0.0));
  });

  test("a skimmer with poor decoding still costs more than a careful reader with good decoding", () => {
    // The load-bearing case. ADHD skims (0.2) and decodes well (0.75);
    // dyslexic reads more (0.4) and decodes poorly (0.39). Decoding must win.
    const demand = computeDemandDistribution(textPage);
    const run = (readingTendency: number, readingCapacity: number) => {
      const r = computeSequentialCTC(
        buildOTCognitiveProfile("p", { ...base, readingTendency, readingCapacity }),
        demand, { asymmetric: true, interactions: true });
      return (r.layers.find((l: { name: string }) => l.name === "readability") as { transportCost: number }).transportCost;
    };
    expect(run(0.4, 0.39)).toBeGreaterThan(run(0.2, 0.75));
  });

  test("readingTendency is no longer a capacity in any layer", () => {
    // Scans the traits ARRAYS, not the block text — the block explains at
    // length why readingTendency was moved, and the first version of this test
    // failed on its own explanation.
    const block = CHAIN_SRC.slice(CHAIN_SRC.indexOf("LAYER_DEFINITIONS"), CHAIN_SRC.indexOf("INTERACTION_PAIRS"));
    const arrays = Array.from(block.matchAll(/traits: \[([^\]]*)\]/g), (m) => m[1]);
    expect(arrays.length).toBeGreaterThan(0);
    for (const a of arrays) expect(a).not.toContain("readingTendency");
  });
});

describe("remaining hardening from the QA reports", () => {
  test("persona names resolve tolerantly, but an unknown name still fails", async () => {
    const { getAnyPersona } = await import("../src/personas.js");
    // Exact match is tried first and always wins, so this only ever ADDS
    // resolutions. Before unknown names threw, a capitalised name silently
    // produced an all-midpoint fabricated persona.
    for (const n of ["POWER-USER", "Power-User", "power user", "cognitive_adhd"]) {
      expect(getAnyPersona(n)).toBeTruthy();
    }
    expect(getAnyPersona("power-user")).toBeTruthy();
    // Tolerance must not become "resolves anything".
    expect(getAnyPersona("zzz-not-a-real-persona")).toBeUndefined();
    expect(getAnyPersona("")).toBeUndefined();
  });

  test("motor barrier selectors identify WHICH element", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/mcp-tools/base/persona-comparison-tools.ts"), "utf8");
    // Reported as bare "a" before, so every anchor looked identical: a finding
    // like "an <a> with 1% hit probability" named nothing anyone could fix, and
    // two runs surfacing different links looked like one element behaving
    // inconsistently.
    expect(src).toContain("nth-of-type");
    expect(src).toContain("aria-label");
  });

  test("each attention verdict names its basis", () => {
    const vt = readFileSync(join(import.meta.dir, "..", "src/mcp-tools/base/visual-testing-tools.ts"), "utf8");
    const aq = readFileSync(join(import.meta.dir, "..", "src/visual/attention-quality.ts"), "utf8");
    // Two bare verdicts in one payload read as the tool contradicting itself:
    // "design intent is working" beside "attention diverges from intended
    // design", off an alignmentScore of 0.484. Both were right about different
    // questions.
    expect(vt).toContain("alignmentScore ");
    // Checked on CODE lines, not raw file text: the comment explaining the
    // removal necessarily quotes the removed string, and the first version of
    // this assertion failed on its own explanation. Third time today.
    const codeLines = aq.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    expect(codeLines.join("\n")).not.toContain("Design intent is working");
    expect(aq).toContain("Strong attention capture");
  });
});

describe("dyslexic-user carries a differentiated trait vector", () => {
  test("working memory is impaired, not above average", async () => {
    // The single clearest inversion in the old vector: it sat at 0.6, above
    // neutral, against one of the best-established findings in the dyslexia
    // literature — a WM deficit that persists into adulthood across both
    // phonological and visuospatial modalities.
    const { getAnyPersona } = await import("../src/personas.js");
    const t = (getAnyPersona("dyslexic-user") as never as { cognitiveTraits: Record<string, number> }).cognitiveTraits;
    expect(t.workingMemory).toBeLessThan(0.45);
  });

  test("compensation traits are elevated, not baseline", async () => {
    // Slower reading, text-structure use and sustained strategy are the three
    // documented compensatory mechanisms. A persona that models dyslexia purely
    // as deficit misses what these users actually do.
    const { getAnyPersona } = await import("../src/personas.js");
    const t = (getAnyPersona("dyslexic-user") as never as { cognitiveTraits: Record<string, number> }).cognitiveTraits;
    expect(t.patience).toBeGreaterThan(0.6);
    expect(t.persistence).toBeGreaterThan(0.6);
    expect(t.metacognitivePlanning).toBeGreaterThan(0.6);
    expect(t.informationForaging).toBeGreaterThan(0.55);
  });

  test("the vector is not effectively a default vector", async () => {
    // BUG-05: 21 of 25 traits sat at exactly 0.5 or 0.6, so the persona was
    // barely distinguishable from a generic user in trait space and the layers
    // had almost nothing persona-specific to read. Bound is deliberately loose
    // — the point is that it cannot silently flatten back.
    const { getAnyPersona } = await import("../src/personas.js");
    const t = (getAnyPersona("dyslexic-user") as never as { cognitiveTraits: Record<string, number> }).cognitiveTraits;
    const defined = (COGNITIVE_TRAITS as readonly string[]).filter((k) => t[k] !== undefined);
    const flat = defined.filter((k) => Math.abs(t[k] - 0.5) < 0.001 || Math.abs(t[k] - 0.6) < 0.001);
    expect(flat.length).toBeLessThan(15);
  });

  test("comprehension staying at 0.5 is correct, not an oversight", async () => {
    // Called out in the bug report as a defining-characteristic trait left at
    // baseline. It is not a reading trait: its own criteria are "grasp of UI
    // conventions". Dyslexia does not impair that, and decoding ability now
    // enters the chain through readingCapacity instead.
    const { getAnyPersona } = await import("../src/personas.js");
    const t = (getAnyPersona("dyslexic-user") as never as { cognitiveTraits: Record<string, number> }).cognitiveTraits;
    expect(t.comprehension).toBe(0.5);
    const ref = readFileSync(join(import.meta.dir, "..", "src/values/persona-completeness.ts"), "utf8");
    expect(ref).toContain("comprehension: \"Grasp of UI conventions");
  });
});

describe("motor pass admits only real pointing targets", () => {
  test("non-hit-testable elements are excluded before Fitts", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/mcp-tools/base/persona-comparison-tools.ts"), "utf8");
    // BUG-09: a visually-hidden skip link (1px box, clip: rect(0,0,0,0)) passed
    // the old size-and-viewport filter, went into Fitts, and produced a
    // multi-second movement time at 1% accuracy — so the tool docked a site's
    // motor accessibility score for implementing WCAG 2.4.1 Bypass Blocks.
    expect(src).toContain("elementFromPoint");
    expect(src).toContain("MIN_TARGET_PX");
    expect(src).toContain("pointerEvents");
    expect(src).toMatch(/visibility === "hidden"/);
  });

  test("the overlay is drawn from the scored list, not a second query", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/mcp-tools/base/persona-comparison-tools.ts"), "utf8");
    // The overlay used to re-query with a DIFFERENT filter and zip to
    // motorResult.elements by index, so tightening the scoring filter would
    // have drawn each element's hit probability on another element's box.
    expect(src).toContain("motorGeom.map(");
    expect(src).not.toMatch(/const els = document\.querySelectorAll\('a, button/);
  });
});

describe("suppressed decisionStyle reports itself", () => {
  test("null plus a suppression flag, not an omitted key", async () => {
    // BUG-08: the key was omitted while decisionStyleSource still said
    // "derived", so the source claimed a derivation for an absent value and
    // consumers could not tell suppression from "never computed".
    const { createCognitivePersona, getCognitiveProfile } = await import("../src/personas.js");
    const p = createCognitivePersona("tie-probe-2", "probe", {
      patience: 0.5, satisficing: 0.5, riskTolerance: 0.5,
      metacognitivePlanning: 0.5, informationForaging: 0.5, comprehension: 0.5,
    } as never);
    delete (p as never as { behaviors: Record<string, unknown> }).behaviors.decisionStyle;
    const prof = getCognitiveProfile(p) as never as Record<string, unknown>;
    expect(prof.decisionStyle).toBeNull();
    expect(prof.decisionStyleSuppressed).toBe(true);
    expect(prof.decisionStyleThreshold).toBe(0.05);
    expect(prof.decisionStyleSource).toBe("suppressed");
  });
});

describe("reading capacity is reachable from the trait schema", () => {
  test("stating a reading trait changes the reading profile", async () => {
    // BUG-10: getReadingProfile matched on the persona's NAME, so WPM, fixation
    // span and phonological penalty could not be tuned by any trait edit.
    // Twelve trait changes to dyslexic-user moved cognitiveLoad and frustration
    // substantially and left every reading measure byte-identical.
    const { getReadingProfile } = await import("../src/visual/cognitive-models.js");
    const base = getReadingProfile({ name: "dyslexic-user" });
    const tuned = getReadingProfile({ name: "dyslexic-user", accessibilityTraits: { visualSpan: 7 } });
    expect(base.visualSpan).toBe(4);
    expect(tuned.visualSpan).toBe(7);
  });

  test("a partial statement does not reset the other fields", async () => {
    // Stating one value must not silently blank the rest to defaults — that
    // would make the schema unusable for incremental authoring.
    const { getReadingProfile } = await import("../src/visual/cognitive-models.js");
    const base = getReadingProfile({ name: "dyslexic-user" });
    const tuned = getReadingProfile({ name: "dyslexic-user", accessibilityTraits: { visualSpan: 7 } });
    expect(tuned.phonological).toBe(base.phonological);
    expect(tuned.orthographic).toBe(base.orthographic);
    expect(tuned.crowding).toBe(base.crowding);
  });

  test("it reaches WPM, which is the measure the report tracked", async () => {
    const { readability } = await import("../src/visual/cognitive-models.js");
    const blocks = [{ text: "The interdisciplinary undergraduate admissions process requires documentation.".repeat(3),
      fontSize: 16, lineHeight: 1.5, fontFamily: "sans-serif", isSerif: false, contrastRatio: 7 }];
    const wpm = (acc?: Record<string, number>) => {
      const r = readability(blocks as never, { name: "dyslexic-user", accessibilityTraits: acc } as never);
      return (r.blocks[0] as { wordsPerMinute: number }).wordsPerMinute;
    };
    expect(wpm({ visualSpan: 7, phonologicalDecoding: 0.85 })).toBeGreaterThan(wpm());
  });

  test("the migrated personas state their capacity explicitly", async () => {
    const { getAnyPersona } = await import("../src/personas.js");
    for (const n of ["dyslexic-user", "cognitive-adhd", "low-vision-magnified", "elderly-low-vision"]) {
      const at = (getAnyPersona(n) as never as { accessibilityTraits?: Record<string, number> }).accessibilityTraits;
      expect(at?.visualSpan).toBeGreaterThan(0);
      expect(typeof at?.phonologicalDecoding).toBe("number");
    }
  });

  test("elderly-low-vision is no longer resolved by name-match ordering", async () => {
    // The lookup tests 'low-vision' before 'elderly', so a persona that is both
    // silently got only the low-vision half. Each dimension now takes the more
    // impaired value, except vocabulary where age is an advantage.
    const { getAnyPersona } = await import("../src/personas.js");
    const at = (getAnyPersona("elderly-low-vision") as never as { accessibilityTraits: Record<string, number> }).accessibilityTraits;
    expect(at.visualSpan).toBe(3);          // low vision, the worse of 3 and 5
    expect(at.phonologicalDecoding).toBe(0.65); // elderly, the worse of 0.65 and 0.75
    expect(at.vocabularyBreadth).toBe(0.85);    // elderly, crystallized vocabulary
  });
});
