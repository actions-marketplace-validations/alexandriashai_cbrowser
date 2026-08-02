/**
 * What the empathy audit's verdict field means, and what `goal` is for.
 *
 * The audit used to return `goalAchieved`, computed as:
 *
 *     goalAchieved = blockingBarriers.length === 0
 *
 * which is a statement about the page, not about anyone completing a task. No
 * traversal is needed to produce it. When a cognitive journey does run, that
 * line executes AFTER it and overwrites the journey's answer, so a journey's
 * SUCCESS never made the field true — only an explicit journey failure could
 * force it false. And the journey only runs when an API key is configured, so
 * on most calls nothing was attempted at all.
 *
 * `goal` was nonetheless a REQUIRED parameter, which implied every audit
 * traversed toward it.
 *
 * Both are now honest: the field is `noBlockingBarriers`, and `goal` is
 * optional. These tests pin the two claims that renaming is supposed to make
 * true, because a rename that leaves the semantics unpinned is just a new label
 * on the same confusion.
 *
 * @since 2026-08-02
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const empathy = readFileSync(join(SRC, "analysis", "accessibility-empathy.ts"), "utf8");
const types = readFileSync(join(SRC, "types.ts"), "utf8");
const auditTools = readFileSync(join(SRC, "mcp-tools", "base", "audit-tools.ts"), "utf8");

describe("the verdict field is named for what it computes", () => {
  test("the assignment that produces it is the barrier count", () => {
    // The one line the whole name rests on.
    expect(empathy).toContain("noBlockingBarriers = blockingBarriers.length === 0;");
  });

  test("nothing in the empathy path assigns a bare goalAchieved variable", () => {
    // `journey.goalAchieved` and `journeyValidation.goalAchieved` are reads of
    // the JOURNEY's own field and stay — that one really does mean achieved.
    // What must not come back is a local variable of that name in this module.
    expect(empathy).not.toMatch(/^\s*(let|const)\s+goalAchieved\b/m);
    expect(empathy).not.toMatch(/^\s*goalAchieved = /m);
  });

  test("a journey's success cannot set the verdict true", () => {
    // The barrier assignment must come AFTER the journey assignment, or the
    // rename would be describing an ordering that no longer holds.
    const fromJourney = empathy.indexOf("noBlockingBarriers = journey.goalAchieved");
    const fromBarriers = empathy.indexOf("noBlockingBarriers = blockingBarriers.length === 0");
    expect(fromJourney).toBeGreaterThan(-1);
    expect(fromBarriers).toBeGreaterThan(fromJourney);
  });

  test("a journey failure can still force it false", () => {
    expect(empathy).toContain("journeyValidation.goalAchieved === false");
    expect(empathy).toMatch(/journeyValidation\.goalAchieved === false\) \{\s*\n\s*noBlockingBarriers = false;/);
  });

  test("the human-readable reports no longer claim a goal was achieved", () => {
    // These strings were "Goal: ✓ Achieved" in both the text and HTML reports,
    // which is the same false claim in the surface a customer actually reads.
    expect(empathy).not.toContain("'Achieved'");
    expect(empathy).not.toContain("✓ Achieved");
    expect(empathy).toContain("Blocking barriers");
  });
});

describe("the rename does not break existing consumers", () => {
  test("the result type carries both names for one release", () => {
    const iface = types.slice(types.indexOf("disabilityType: string;"));
    expect(iface).toContain("noBlockingBarriers: boolean;");
    expect(iface).toContain("goalAchieved: boolean;");
    expect(iface).toContain("@deprecated");
  });

  test("the MCP payload emits both, from the same value", () => {
    expect(auditTools).toContain("noBlockingBarriers: r.noBlockingBarriers,");
    // The alias must be the SAME value, not a second computation that could drift.
    expect(auditTools).toContain("goalAchieved: r.noBlockingBarriers,");
  });

  test("the emitted alias is marked deprecated where it is emitted", () => {
    const idx = auditTools.indexOf("goalAchieved: r.noBlockingBarriers,");
    expect(auditTools.slice(Math.max(0, idx - 300), idx)).toContain("@deprecated");
  });
});

describe("goal is optional and only a journey reads it", () => {
  test("the tool schema marks it optional", () => {
    expect(auditTools).toMatch(/goal: z\.string\(\)\.optional\(\)/);
  });

  test("the options type marks it optional", () => {
    const opts = types.slice(types.indexOf("export interface EmpathyAuditOptions"));
    expect(opts.slice(0, 900)).toMatch(/goal\?: string;/);
  });

  test("no goal means no journey is attempted", () => {
    // Without this guard an absent goal would still enter the journey branch and
    // traverse toward undefined, recording a goal path nobody asked for.
    expect(empathy).toContain("if (goal && isApiKeyConfigured())");
  });

  test("barrier detection runs before the journey branch, so omitting goal cannot change findings", () => {
    // This is the claim the tool description makes to callers. If the journey
    // branch ever moved above barrier detection it would become false.
    const barriers = empathy.indexOf("await detectCognitiveBarriers(ctx);");
    const journey = empathy.indexOf("if (goal && isApiKeyConfigured())");
    expect(barriers).toBeGreaterThan(-1);
    expect(journey).toBeGreaterThan(barriers);
  });

  test("the reports omit the goal line entirely when there is no goal", () => {
    // Rather than printing `Goal: "undefined"`.
    expect(empathy).toContain('${result.goal ? `Goal: "${result.goal}"');
    expect(empathy).toContain('${result.goal ? `<p><strong>Goal:</strong>');
  });
});

describe("real journeys keep the honest name", () => {
  test("CognitiveJourneyResult still has goalAchieved", () => {
    const idx = types.indexOf("export interface CognitiveJourneyResult");
    expect(idx).toBeGreaterThan(-1);
    expect(types.slice(idx, idx + 400)).toContain("goalAchieved: boolean;");
  });
});
