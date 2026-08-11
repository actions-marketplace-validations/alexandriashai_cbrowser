/**
 * `accessibility` -> `agentPerceivability`, `dynamicContentCount` ->
 * `deferredLoadingPatterns`, both expand-contract.
 *
 * Neither rename is cosmetic; both fixed a number whose name promised something
 * it did not measure.
 *
 *   accessibility: 100        on a page where empathy_audit found two WCAG
 *                             violations. The axis scores machine-perceivability
 *                             (ARIA present, elements carry text). Both numbers
 *                             were right; the pairing was not communicable.
 *
 *   dynamicContentCount: 0    on a page running 122 CSS animations, 119 of them
 *                             infinite. It counts deferred LOADING (lazy images,
 *                             infinite scroll, load-more), not motion. Zero was
 *                             correct and read as "nothing moves", which is how
 *                             a reader concluded two tools contradicted each
 *                             other when neither was wrong.
 *
 * Both old keys are still emitted with identical values and removed at the next
 * major. The alias tests below matter more than the rename tests: a rename that
 * quietly breaks consumers is worse than the naming problem it fixes.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { calculateAgentReadyScore } from "../src/analysis/agent-ready-audit.js";

const SRC = readFileSync(
  fileURLToPath(new URL("../src/analysis/agent-ready-audit.ts", import.meta.url)),
  "utf8",
);
const TYPES = readFileSync(
  fileURLToPath(new URL("../src/types.ts", import.meta.url)),
  "utf8",
);
const code = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the new names are canonical", () => {
  test("the score axis is agentPerceivability", () => {
    expect(code(TYPES)).toContain("agentPerceivability: number;");
    expect(code(SRC)).toContain("agentPerceivability: Math.round(");
  });

  test("the summary field is deferredLoadingPatterns", () => {
    expect(code(TYPES)).toContain("deferredLoadingPatterns?: number;");
    expect(code(SRC)).toContain("summary.deferredLoadingPatterns = dynamicCount;");
  });

  test("emitted issues carry the new category", () => {
    expect(code(SRC)).toContain('category: "agentPerceivability"');
    expect(code(SRC)).not.toContain('category: "accessibility"');
  });

  test("the weight table is keyed on the new name", () => {
    expect(code(SRC)).toContain("agentPerceivability: 0.20");
  });
});

describe("the deprecated aliases are GONE", () => {
  // Shipped as expand-contract: both keys emitted from 2026-08-05, the old ones
  // removed here. This block was the mirror of itself a week ago — it asserted
  // both keys were present. Inverted rather than deleted, so a re-added alias
  // fails loudly instead of drifting back in unnoticed.
  test("the score block carries only agentPerceivability", () => {
    const c = code(SRC);
    expect(c).toContain("agentPerceivability: Math.round(scores.agentPerceivability)");
    expect(c).not.toContain("accessibility: Math.round(");
    expect(code(TYPES)).not.toContain("  accessibility: number;");
  });

  test("the summary carries only deferredLoadingPatterns", () => {
    const c = code(SRC);
    expect(c).toContain("summary.deferredLoadingPatterns = dynamicCount;");
    expect(c).not.toContain("summary.dynamicContentCount");
    expect(code(TYPES)).not.toContain("dynamicContentCount?: number;");
  });

  test("the category union no longer offers the old name", () => {
    const t = code(TYPES);
    const union = t.slice(t.indexOf("export type AgentReadyIssueCategory"),
                          t.indexOf("export type AgentReadyIssueSeverity"));
    expect(union).not.toContain('"accessibility"');
    expect(union).toContain('"agentPerceivability"');
  });

  test("the comparison carries only bestAgentPerceivability", () => {
    expect(code(TYPES)).not.toContain("bestAccessibility: string;");
  });
});

describe("an old category arriving at RUNTIME still scores", () => {
  // The union no longer allows it, but types do not survive a JSON boundary —
  // an older client can still POST `category: "accessibility"`. Mapped rather
  // than dropped, because an unrecognised category would index nothing,
  // `undefined - penalty` is NaN, and NaN propagates into `overall` as a broken
  // number with nothing saying why. This is the half of the alias that had to
  // survive its removal.
  const issue = (category: string, severity = "medium") => ({
    category, severity, element: "x", description: "d",
    detectionMethod: "t", recommendation: "r",
  }) as unknown as Parameters<typeof calculateAgentReadyScore>[0][number];

  test("a legacy \"accessibility\" issue still deducts from the axis", async () => {
    const { calculateAgentReadyScore } = await import("../src/analysis/agent-ready-audit.js");
    const s = calculateAgentReadyScore([issue("accessibility")]);
    expect(s.agentPerceivability).toBeLessThan(100);
  });

  test("it deducts the SAME amount as the new name", async () => {
    const { calculateAgentReadyScore } = await import("../src/analysis/agent-ready-audit.js");
    const legacy = calculateAgentReadyScore([issue("accessibility", "high")]);
    const modern = calculateAgentReadyScore([issue("agentPerceivability", "high")]);
    expect(legacy.agentPerceivability).toBe(modern.agentPerceivability);
    expect(legacy.overall).toBe(modern.overall);
  });

  test("no score is NaN — the failure mode a missing bucket produces", async () => {
    const { calculateAgentReadyScore } = await import("../src/analysis/agent-ready-audit.js");
    const s = calculateAgentReadyScore([issue("accessibility"), issue("agentPerceivability")]);
    for (const v of Object.values(s)) {
      expect(Number.isNaN(v as number)).toBe(false);
    }
  });

  test("a wholly unknown category scores nothing rather than NaN", async () => {
    const { calculateAgentReadyScore } = await import("../src/analysis/agent-ready-audit.js");
    const s = calculateAgentReadyScore([issue("not-a-category")]);
    expect(Number.isNaN(s.overall)).toBe(false);
    expect(s.overall).toBe(100);
  });
});

describe("the renderers followed the rename", () => {
  test("the issue counter matches the single surviving category", () => {
    const c = code(SRC);
    expect(c).toContain("i.category === 'agentPerceivability'");
    expect(c).not.toContain("|| i.category === 'accessibility'");
  });

  test("no customer-facing surface still reads plain 'Accessibility'", () => {
    const c = code(SRC);
    expect(c).not.toContain('<div class="label">Accessibility</div>');
    expect(c).toContain("Agent perceivability");
  });

  test("the HTML card explains what the axis is not", () => {
    expect(code(SRC)).toContain("not WCAG conformance");
  });

  test("a badge style exists for the surviving category", () => {
    expect(code(SRC)).toContain(".badge-agentPerceivability");
  });
});

describe("scoring behaviour, not just source text", () => {
  const issue = (category: string, severity = "medium") => ({
    category, severity, element: "x", description: "d",
    detectionMethod: "t", recommendation: "r",
  }) as unknown as Parameters<typeof calculateAgentReadyScore>[0][number];

  test("an issue in the NEW category deducts from the axis", async () => {
    const { calculateAgentReadyScore } = await import("../src/analysis/agent-ready-audit.js");
    const s = calculateAgentReadyScore([issue("agentPerceivability")]);
    expect(s.agentPerceivability).toBeLessThan(100);
  });

  test("an issue in the DEPRECATED category still deducts", async () => {
    // A consumer or older code path constructing `category: "accessibility"`
    // must not score as a clean page.
    const { calculateAgentReadyScore } = await import("../src/analysis/agent-ready-audit.js");
    const s = calculateAgentReadyScore([issue("accessibility")]);
    expect(s.agentPerceivability).toBeLessThan(100);
  });

  test("the removed key is genuinely absent from the emitted object", async () => {
    // Not just absent from the type — absent from the runtime object, which is
    // what a consumer actually receives across the JSON boundary.
    const { calculateAgentReadyScore } = await import("../src/analysis/agent-ready-audit.js");
    const s = calculateAgentReadyScore([issue("agentPerceivability", "high")]);
    expect(Object.keys(s)).not.toContain("accessibility");
    expect(Object.keys(s)).toContain("agentPerceivability");
  });

  test("no score is NaN — a missing bucket propagates silently otherwise", async () => {
    const { calculateAgentReadyScore } = await import("../src/analysis/agent-ready-audit.js");
    const s = calculateAgentReadyScore([issue("accessibility"), issue("agentPerceivability")]);
    for (const [k, v] of Object.entries(s)) {
      expect(Number.isNaN(v as number)).toBe(false);
      expect(typeof v).toBe("number");
      void k;
    }
  });
});
