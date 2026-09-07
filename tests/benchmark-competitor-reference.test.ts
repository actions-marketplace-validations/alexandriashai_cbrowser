/**
 * `ai_benchmark` must not hold up a reference site that shares the defect.
 *
 * Reproduced on cbrowser.ai, three pages:
 *
 *   /docs/home  "sticky element ... 1280x57px"  ->  "cbrowser.ai/pricing handles this better"
 *               and /pricing's own topIssues[0] is that identical string.
 *
 *   /pricing    "Agents struggle to find elements"  ->  "cbrowser.ai/docs/home handles this better"
 *               and /docs/home scores 80 against /pricing's 83 — advice to copy
 *               a page that is worse.
 *
 * Two causes in three lines. The check read only `weaknesses`, which is
 * `weaknesses.length > 0 ? weaknesses : issueDescriptions` — so a site with a low
 * AXIS score never gets its element-level issues into that list, and a checker
 * reading it concludes the site is clean. And `.find()` returns the first array
 * match, which has nothing to do with being better.
 *
 * This is a competitive-intelligence tool whose output is aimed at customers
 * comparing themselves to rivals, so a wrong reference is the failure most
 * likely to be screenshotted. No reference beats a wrong one.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */
import { describe, test, expect } from "bun:test";
import { pickBetterReference } from "../src/analysis/competitive-benchmark.js";

const STICKY = "sticky element may intercept clicks (z-index: 50, 1280x57px, spans the viewport width)";

type Site = Parameters<typeof pickBetterReference>[0][number];
const site = (siteName: string, score: number, weaknesses: string[], topIssues: string[]) =>
  ({ siteName, score, weaknesses, topIssues }) as unknown as Site;

/** The three real pages, with their real scores and issue lists. */
const PRICING = site("cbrowser.ai/pricing", 83, ["Agents struggle to find elements"], [STICKY, "Element lacks stable selectors (score: 0/10)"]);
const DOCS = site("cbrowser.ai/docs/home", 80, [STICKY], [STICKY]);
const ABOUT = site("cbrowser.ai/about", 92, [], ["Element lacks stable selectors (score: 0/10)"]);
const CLEAN = site("cbrowser.ai/blog", 92, [], []);

describe("a reference must not share the issue", () => {
  test("the reported case — /pricing is not offered for the sticky issue", () => {
    // /pricing carries STICKY in topIssues but not in weaknesses, which is
    // exactly what the old check missed.
    const ref = pickBetterReference([PRICING, DOCS, ABOUT], DOCS, STICKY);
    expect(ref?.siteName).not.toBe("cbrowser.ai/pricing");
  });

  test("topIssues is consulted, not just weaknesses", () => {
    const ref = pickBetterReference([ABOUT], DOCS, "Element lacks stable selectors (score: 0/10)");
    expect(ref).toBeUndefined();
  });

  test("a genuinely clean, higher-scoring site IS offered", () => {
    const ref = pickBetterReference([PRICING, CLEAN], DOCS, STICKY);
    expect(ref?.siteName).toBe("cbrowser.ai/blog");
  });
});

describe("a reference must actually score better", () => {
  test("the second reported case — /docs/home (80) is not offered to /pricing (83)", () => {
    const ref = pickBetterReference([DOCS, ABOUT], PRICING, "Agents struggle to find elements");
    expect(ref?.siteName).not.toBe("cbrowser.ai/docs/home");
  });

  test("an equal score does not qualify — copying a peer is not advice", () => {
    const peer = site("peer", 83, [], []);
    expect(pickBetterReference([peer], PRICING, "anything")).toBeUndefined();
  });

  test("the BEST qualifying site wins, not the first in the array", () => {
    const ok90 = site("ok90", 90, [], []);
    const ok95 = site("ok95", 95, [], []);
    // ok90 comes first in the array; ok95 must still win.
    expect(pickBetterReference([ok90, ok95], DOCS, STICKY)?.siteName).toBe("ok95");
  });
});

describe("no reference beats a wrong one", () => {
  test("nothing qualifying returns undefined rather than degrading", () => {
    expect(pickBetterReference([PRICING, DOCS], DOCS, STICKY)).toBeUndefined();
  });

  test("a site is never offered as a reference to itself", () => {
    expect(pickBetterReference([DOCS], DOCS, STICKY)).toBeUndefined();
  });

  test("an unscored subject gets no reference", () => {
    const unscored = site("failed", 0, [], []);
    (unscored as unknown as { score: number | null }).score = null;
    expect(pickBetterReference([ABOUT, CLEAN], unscored, STICKY)).toBeUndefined();
  });

  test("an unscored candidate is never chosen", () => {
    const failed = site("failed", 0, [], []);
    (failed as unknown as { score: number | null }).score = null;
    expect(pickBetterReference([failed], DOCS, STICKY)).toBeUndefined();
  });

  test("an empty candidate list is not an error", () => {
    expect(pickBetterReference([], DOCS, STICKY)).toBeUndefined();
  });
});

describe("the source no longer contains the broken selection", () => {
  test("the weaknesses-only find() is gone", () => {
    // The behavioural tests above would keep passing if a second, unfixed copy
    // of the old selection survived elsewhere in the file.
    const src = require("node:fs").readFileSync(
      new URL("../src/analysis/competitive-benchmark.ts", import.meta.url), "utf8") as string;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toContain("!r.weaknesses.includes(weakness)");
    expect(code).toContain("pickBetterReference(");
  });
});
