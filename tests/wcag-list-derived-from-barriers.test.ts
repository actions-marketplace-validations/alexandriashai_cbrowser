/**
 * The published WCAG list is DERIVED from the barriers, not maintained beside them.
 *
 * `ctx.wcagViolations` used to be a Set that each detector appended to by hand,
 * one `.add()` line next to the `barriers.push()` it belonged to. Two hand-kept
 * lists drift, and this pair drifted in the direction that matters most: the
 * barrier declared criteria the adjacent add() did not repeat, so the audit
 * DETECTED a violation, showed it on the barrier, and omitted it from the
 * conformance list.
 *
 * Measured on one fixture page before the fix — every one of these was rendered
 * as a barrier and absent from allWcagViolations:
 *
 *   1.3.1  major     "Form input (text) has no accessible label"
 *   2.5.5  major     "Touch target too small (34x21px)"
 *   2.5.7  critical  "Drag-and-drop element lacks keyboard alternative"
 *   3.3.4  major     "Form with 7 fields lacks progress indicator"
 *
 * 1.3.1 is the one that shows why advisory-ness cannot be a per-criterion rule:
 * it is a genuine Level A violation on an unlabelled input and a mere
 * recommendation on a text-wall. Same criterion, two barriers, opposite answers.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */
import { describe, test, expect } from "bun:test";
import { deriveWcagViolations } from "../src/analysis/accessibility-empathy.js";

const derive = (
  barriers: Array<{ wcagCriteria?: string[]; wcagAdvisoryCriteria?: string[] }>,
  recorded: string[] = [],
  everOnBarrier: string[] = [],
  level: "A" | "AA" | "AAA" = "AAA",
) => deriveWcagViolations(barriers, new Set(recorded), new Set(everOnBarrier), level).sort();

describe("every criterion a barrier declares reaches the list", () => {
  test("the unlabelled-input barrier contributes all three, not two", () => {
    // Shipped as wcagCriteria ["1.3.1","3.3.2","4.1.2"] with only 3.3.2 and
    // 4.1.2 added by hand. 1.3.1 is Level A.
    expect(derive([{ wcagCriteria: ["1.3.1", "3.3.2", "4.1.2"] }]))
      .toEqual(["1.3.1", "3.3.2", "4.1.2"]);
  });

  test("the drag-drop barrier contributes 2.5.7, not just 2.1.1", () => {
    expect(derive([{ wcagCriteria: ["2.1.1", "2.5.7"] }])).toEqual(["2.1.1", "2.5.7"]);
  });

  test("the hover-only barrier contributes 2.5.1, not just 2.1.1", () => {
    expect(derive([{ wcagCriteria: ["2.1.1", "2.5.1"] }])).toEqual(["2.1.1", "2.5.1"]);
  });

  test("the touch-target barrier contributes both 2.5.8 and 2.5.5", () => {
    expect(derive([{ wcagCriteria: ["2.5.8", "2.5.5"] }])).toEqual(["2.5.5", "2.5.8"]);
  });

  test("the progress-indicator barrier contributes 3.3.4, which added nothing at all", () => {
    expect(derive([{ wcagCriteria: ["3.3.4"] }])).toEqual(["3.3.4"]);
  });

  test("the general form — no declared criterion is ever dropped", () => {
    const declared = ["1.1.1", "1.3.1", "1.4.3", "2.1.1", "2.5.1", "2.5.7", "3.3.4", "4.1.2"];
    const out = derive(declared.map((c) => ({ wcagCriteria: [c] })));
    expect(out).toEqual([...declared].sort());
  });
});

describe("advisory criteria are a property of the barrier, not the criterion", () => {
  test("a text-wall's 1.3.1 is advisory and stays out of the violation list", () => {
    expect(derive([{ wcagCriteria: ["1.3.1"], wcagAdvisoryCriteria: ["1.3.1"] }])).toEqual([]);
  });

  test("the SAME criterion still counts from a barrier that does violate it", () => {
    // The case a per-criterion allow-list cannot express.
    expect(derive([
      { wcagCriteria: ["1.3.1"], wcagAdvisoryCriteria: ["1.3.1"] },
      { wcagCriteria: ["1.3.1", "3.3.2", "4.1.2"] },
    ])).toEqual(["1.3.1", "3.3.2", "4.1.2"]);
  });

  test("a partially-advisory barrier contributes only its violating criteria", () => {
    expect(derive([{ wcagCriteria: ["2.2.2", "2.3.1"], wcagAdvisoryCriteria: ["2.3.1"] }]))
      .toEqual(["2.2.2"]);
  });
});

describe("criteria no barrier claims", () => {
  test("a page-level finding with no barrier is KEPT", () => {
    // "Mirrors are derived" is not "discard anything the barriers don't know".
    expect(derive([], ["2.2.1"], [])).toEqual(["2.2.1"]);
  });

  test("a criterion orphaned by the viewport filter is DROPPED", () => {
    // Its barriers existed and were filtered away — the reported symptom,
    // 1.1.1 listed with nothing on the page explaining it.
    expect(derive([], ["1.1.1"], ["1.1.1"])).toEqual([]);
  });

  test("the two cases are told apart in one pass", () => {
    expect(derive([], ["1.1.1", "2.2.1"], ["1.1.1"])).toEqual(["2.2.1"]);
  });
});

describe("conformance level still filters", () => {
  test("an AAA criterion is excluded from an AA audit", () => {
    // 1.4.6 is AAA. Deriving must not smuggle it past the level filter.
    expect(derive([{ wcagCriteria: ["1.4.3", "1.4.6"] }], [], [], "AA")).toEqual(["1.4.3"]);
  });

  test("the same audit at AAA keeps both", () => {
    expect(derive([{ wcagCriteria: ["1.4.3", "1.4.6"] }], [], [], "AAA"))
      .toEqual(["1.4.3", "1.4.6"]);
  });

  test("an unknown criterion is kept rather than silently dropped", () => {
    expect(derive([{ wcagCriteria: ["9.9.9"] }], [], [], "A")).toEqual(["9.9.9"]);
  });
});

describe("shape", () => {
  test("duplicates across barriers collapse", () => {
    expect(derive([{ wcagCriteria: ["2.1.1"] }, { wcagCriteria: ["2.1.1"] }])).toEqual(["2.1.1"]);
  });

  test("barriers with no criteria are not an error", () => {
    expect(derive([{ wcagCriteria: [] }, {}])).toEqual([]);
  });
});
