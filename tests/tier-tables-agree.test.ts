/**
 * The MCP gate and the CMS billing layer must agree about what is free.
 *
 * They did not. Measured 2026-08-13, the CMS permitted 18 tools that this gate
 * refused, so a free user was told they had the tool and then got "Upgrade
 * Required" from the server. Two of those were agent_ready_audit and hunt_bugs
 * — the tools the public homepage demo runs, which is how it surfaced: the demo
 * was dead and the error blamed the key's tier.
 *
 * Root cause was structural, not a typo: pricing was read off TOOL_CATEGORIES,
 * which groups tools by FUNCTION. A tool could not be priced free unless every
 * functional sibling was, so `agent_ready_audit` inherited "pro" from the
 * category it shares with genuinely-Pro analysis tools.
 *
 * The CMS side has the matching half of this test.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */
import { describe, test, expect } from "bun:test";
import { FREE_TIER_TOOLS, getToolPricingTier, TOOL_CATEGORIES } from "../src/mcp-tools/tool-categories.js";

/** The CMS's list, read from its source so drift is detected rather than assumed. */
async function cmsFreeTools(): Promise<Set<string>> {
  const path = "/home/wyld-web/static/cbrowser-web/cms/lib/credit-config.ts";
  const src = await Bun.file(path).text();
  const block = src.match(/FREE_TIER_TOOLS\s*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
  return new Set([...block.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]));
}

const allTools = new Set(TOOL_CATEGORIES.flatMap((c) => c.tools));

describe("free-tier tools resolve as free", () => {
  test("the 18 that were refused now resolve free", () => {
    // The exact set that disagreed. Named individually so a regression says
    // which capability a free user lost.
    for (const t of [
      "agent_ready_audit", "hunt_bugs", "cognitive_effort", "cognitive_load_estimate",
      "visual_baseline", "visual_regression", "cross_browser_test", "cross_browser_diff",
      "responsive_test", "ab_comparison", "perf_baseline", "perf_regression",
      "list_baselines", "heal_stats", "list_cognitive_personas", "llms_txt_generate",
      "page_understand", "persona_create_from_description",
    ]) {
      expect(getToolPricingTier(t), `${t} must be free`).toBe("free");
    }
  });

  test("every tool in FREE_TIER_TOOLS resolves free", () => {
    for (const t of FREE_TIER_TOOLS) expect(getToolPricingTier(t), t).toBe("free");
  });

  test("name beats category — a free tool in a pro category is still free", () => {
    // The structural bug in one assertion.
    const proCat = TOOL_CATEGORIES.find((c) => c.pricingTier === "pro" && c.tools.some((t) => FREE_TIER_TOOLS.has(t)));
    expect(proCat, "expected at least one free tool inside a pro category").toBeTruthy();
    const tool = proCat!.tools.find((t) => FREE_TIER_TOOLS.has(t))!;
    expect(getToolPricingTier(tool)).toBe("free");
  });
});

describe("genuinely paid tools stay paid", () => {
  test("Pro-only cognitive tools are not free", () => {
    // The guard on the fix: widening free access must not become universal.
    for (const t of ["empathy_audit", "attention_analysis", "cognitive_journey_init", "visual_cognitive_story"]) {
      expect(FREE_TIER_TOOLS.has(t), `${t} must not be free`).toBe(false);
      expect(getToolPricingTier(t)).not.toBe("free");
    }
  });

  test("enterprise marketing tools are untouched", () => {
    for (const t of ["marketing_influence_matrix", "marketing_lever_analysis"]) {
      if (allTools.has(t)) expect(getToolPricingTier(t)).toBe("enterprise");
    }
  });

  test("an unknown tool still defaults to pro", () => {
    expect(getToolPricingTier("a_tool_that_does_not_exist")).toBe("pro");
  });
});

describe("the two tables agree", () => {
  test("no tool the CMS calls free is refused here", () => {
    // The user-visible failure: permitted by billing, denied by the server.
    return cmsFreeTools().then((cms) => {
      const refused = [...cms].filter((t) => allTools.has(t) && getToolPricingTier(t) !== "free");
      expect(refused).toEqual([]);
    });
  });

  test("both lists parsed — this cannot pass by reading nothing", () => {
    return cmsFreeTools().then((cms) => {
      expect(cms.size).toBeGreaterThan(40);
      expect(FREE_TIER_TOOLS.size).toBeGreaterThan(40);
    });
  });
});
