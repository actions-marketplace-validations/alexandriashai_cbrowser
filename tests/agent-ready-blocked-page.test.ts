/**
 * The audit must never grade a page it failed to load.
 *
 * Discovered 2026-08-04 while investigating why cbrowser's agent-readiness
 * grades correlated NEGATIVELY (r = -0.27) with WebVoyager's published per-site
 * agent success rates. The cause was not a miscalibrated score. It was that
 * `espn.com` -- the hardest site in that benchmark for agents, 38.6% success --
 * scored 94/A here off `summary.totalElements === 0`.
 *
 * The scorer deducts from 100 per issue found. A page that never loaded has no
 * issues, so it has no deductions, so it is perfect. Aggressive bot protection
 * therefore produced top grades, and an A was partly a marker of blocking.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, expect, test } from "bun:test";
import { assertPageWasAudited } from "../src/analysis/agent-ready-audit.js";

describe("agent-ready audit refuses to grade a page it did not see", () => {
  test("zero elements throws instead of returning a grade", () => {
    expect(() => assertPageWasAudited(0, "https://espn.com")).toThrow();
  });

  test("the error names the real cause, not a generic failure", () => {
    // A customer reading this must understand their site was not measured, not
    // that it scored badly. Those are different facts and only one is true.
    let msg = "";
    try { assertPageWasAudited(0, "https://espn.com"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("0 interactive elements");
    expect(msg).toContain("https://espn.com");
    expect(msg.toLowerCase()).toContain("bot detection");
    // And it must not imply a score exists.
    expect(msg).not.toMatch(/\bgrade[:=]\s*[A-F]\b/);
  });

  test("a real page passes through untouched", () => {
    expect(() => assertPageWasAudited(1, "https://example.com")).not.toThrow();
    expect(() => assertPageWasAudited(214, "https://github.com")).not.toThrow();
  });

  test("negative counts are treated as absent, not as a real page", () => {
    // Defensive: `.catch(() => 0)` guards the element count today, but a future
    // change returning -1 must not sneak past a `=== 0` check.
    expect(() => assertPageWasAudited(-1, "https://example.com")).toThrow();
  });
});
