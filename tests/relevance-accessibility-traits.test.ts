/**
 * Accessibility traits must reach the LLM relevance judge.
 *
 * The judge received `traits` (the 25 cognitive ones) and not
 * `accessibilityTraits` — a separate vector holding sensory, motor and
 * executive-function values. That is the wrong half to drop for a layer whose
 * entire job is deciding what a person attends to and reads, and this codebase
 * says so itself: `persona-comparison-tools.ts` names
 * `accessibility_traits.attentionSpan` the AUTHORITATIVE source for attention,
 * with `traits.interruptRecovery` only a fallback, and the decoding traits
 * authoritative for reading.
 *
 * Measured on the persona modelling an ADHD user: attentionSpan 0.30,
 * processingSpeed 0.40, fatigueSusceptibility 0.30 — the three values that
 * define her — were exactly the ones the judge never saw. It was told she has
 * high curiosity and comprehension, and not told she cannot hold a line of text.
 */
import { describe, test, expect } from "bun:test";
import { resolvePersonaContext } from "../src/visual/persona-context.js";

describe("resolvePersonaContext surfaces accessibility traits", () => {
  test("a persona that has them gets them", async () => {
    const ctx = await resolvePersonaContext("alexa-eden");
    expect(ctx.accessibilityTraits).toBeDefined();
    expect(Object.keys(ctx.accessibilityTraits!).length).toBeGreaterThan(0);
  });

  test("the executive-function values specifically come through", async () => {
    const a = (await resolvePersonaContext("alexa-eden")).accessibilityTraits!;
    // These are the ADHD signature and the whole reason this matters.
    expect(typeof a.attentionSpan).toBe("number");
    expect(typeof a.processingSpeed).toBe("number");
    expect(typeof a.fatigueSusceptibility).toBe("number");
  });

  test("the cognitive vector is unaffected — this is additive", async () => {
    const ctx = await resolvePersonaContext("alexa-eden");
    expect(Object.keys(ctx.traits ?? {}).length).toBe(25);
    expect(ctx.values).toBeDefined();
    expect(ctx.personaDescription).toBeTruthy();
  });

  test("a persona without them is not given an empty object", async () => {
    // Absent must stay absent, so the prompt omits the section entirely rather
    // than printing an empty heading the model has to interpret.
    const ctx = await resolvePersonaContext("first-timer");
    expect(ctx.accessibilityTraits).toBeUndefined();
  });

  test("an unresolvable persona yields an empty context, never a throw", async () => {
    const ctx = await resolvePersonaContext("no-such-persona-xyz");
    expect(ctx.accessibilityTraits).toBeUndefined();
    expect(ctx.traits).toBeUndefined();
  });
});

describe("the relevance layer consumes them", () => {
  test("the prompt renders a sensory/motor/executive section", async () => {
    const src = await Bun.file(
      new URL("../src/visual/llm-relevance.ts", import.meta.url),
    ).text();
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).toContain("describeAccessibility(ctx.accessibilityTraits)");
    // BOTH prompt sites — the scoring judge and the narrative judge. Fixing one
    // and leaving the other is how these two diverged the first time; the
    // shared resolver exists because of exactly that.
    const hits = code.split("describeAccessibility(ctx.accessibilityTraits)").length - 1;
    expect(hits).toBe(2);
  });

  test("the cache key includes them", async () => {
    // Without this the change is INERT rather than wrong: every persona already
    // cached keeps returning the answer computed before the judge could see
    // these traits. A silent no-op is the worse failure of the two.
    const src = await Bun.file(
      new URL("../src/visual/llm-relevance.ts", import.meta.url),
    ).text();
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const keyFn = code.slice(code.indexOf("function cacheKey"), code.indexOf("function readCache"));
    expect(keyFn).toContain("ctx.accessibilityTraits");
  });

  test("the cache version was bumped, so pre-change entries cannot be served", async () => {
    const src = await Bun.file(
      new URL("../src/visual/llm-relevance.ts", import.meta.url),
    ).text();
    expect(src).toContain('const CACHE_VERSION = "v3"');
  });
});

describe("describeAccessibility keeps unimpaired values visible", () => {
  test("a full-function persona still reports its sensory values", async () => {
    // Absence of impairment is information: it tells the judge NOT to attribute
    // a miss to eyesight, which is a conclusion an LLM reaches readily once it
    // knows a persona is disabled in some other respect. So this renderer is
    // deliberately NOT filtered to "notable" the way describeTraits is.
    const a = (await resolvePersonaContext("alexa-eden")).accessibilityTraits!;
    expect(a.visionLevel).toBe(1);
    expect(a.motorControl).toBe(1);
    expect(a.tremor).toBe(false);
  });
});
