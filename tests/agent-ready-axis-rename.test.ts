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

describe("the deprecated aliases still work", () => {
  test("both score keys are emitted, from the same value", () => {
    const c = code(SRC);
    // Same expression on both sides — not two computations that could drift.
    expect(c).toContain("agentPerceivability: Math.round(Math.min(scores.agentPerceivability, scores.accessibility))");
    expect(c).toContain("accessibility: Math.round(Math.min(scores.agentPerceivability, scores.accessibility))");
  });

  test("both summary keys are emitted", () => {
    const c = code(SRC);
    expect(c).toContain("summary.deferredLoadingPatterns = dynamicCount;");
    expect(c).toContain("summary.dynamicContentCount = dynamicCount;");
  });

  test("the old category is still an accepted type member", () => {
    expect(code(TYPES)).toContain('| "accessibility"');
  });

  test("the old category has a scoring bucket, or its deductions become NaN", () => {
    // scores[issue.category] with no bucket is undefined; undefined minus a
    // penalty is NaN; NaN propagates into `overall` and prints as a broken
    // score with nothing indicating why.
    const scoresBlock = code(SRC).slice(
      code(SRC).indexOf("const scores: Record<AgentReadyIssueCategory, number>"),
      code(SRC).indexOf("// Deduct based on issues"),
    );
    expect(scoresBlock).toContain("accessibility: 100");
    expect(scoresBlock).toContain("agentPerceivability: 100");
  });

  test("the old category still carries its weight", () => {
    expect(code(SRC)).toContain("accessibility: 0.20");
  });
});

describe("the renderers followed the rename", () => {
  test("the issue counter matches BOTH categories", () => {
    // Renaming the emitted category without widening this filter would silently
    // zero the line — the exact failure shape being fixed elsewhere in this file.
    const c = code(SRC);
    expect(c).toContain("i.category === 'agentPerceivability' || i.category === 'accessibility'");
  });

  test("no customer-facing surface still reads plain 'Accessibility'", () => {
    const c = code(SRC);
    expect(c).not.toContain('<div class="label">Accessibility</div>');
    expect(c).toContain("Agent perceivability");
  });

  test("the HTML card explains what the axis is not", () => {
    expect(code(SRC)).toContain("not WCAG conformance");
  });

  test("a badge style exists for both category names", () => {
    const c = code(SRC);
    expect(c).toContain(".badge-agentPerceivability");
    expect(c).toContain(".badge-accessibility");
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

  test("both keys always report the identical number", async () => {
    const { calculateAgentReadyScore } = await import("../src/analysis/agent-ready-audit.js");
    for (const cat of ["agentPerceivability", "accessibility"]) {
      const s = calculateAgentReadyScore([issue(cat, "high")]);
      expect(s.accessibility).toBe(s.agentPerceivability);
    }
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
