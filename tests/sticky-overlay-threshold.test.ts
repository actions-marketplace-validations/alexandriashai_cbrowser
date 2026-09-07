/**
 * `stickyOverlays` must count sticky/fixed elements, not the subset big enough
 * to complain about.
 *
 * Measured on cbrowser.ai at 1280x800: a sticky `<header>` 57px tall and three
 * fixed control buttons at 44, 44 and 40px. The detector filtered to
 * `height > 40` and then flagged `height > 60`, so every element fell into the
 * 40-60 gap and was discarded TWICE. The audit reported `stickyOverlays: 0` on a
 * page with a sticky header and three floating buttons — while `empathy_audit`
 * independently located a touch-target barrier at {136, 740, 40, 40}, which is
 * the theme button the first filter had already thrown away for being exactly
 * 40px against a `> 40` boundary.
 *
 * The fixture below reproduces that exact geometry, because the bug lived
 * entirely in the boundary values and a fixture with round numbers would miss it.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { detectStickyOverlays } from "../src/analysis/agent-ready-audit.js";
import type { AgentReadyIssue } from "../src/types.js";

/** The cbrowser.ai geometry, to the pixel. */
const FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>sticky fixture</title><style>
  body { margin: 0; height: 4000px; font-family: sans-serif; }
  header { position: sticky; top: 0; height: 57px; width: 100%; background: #eee; z-index: 50; }
  .a11y  { position: fixed; left: 20px;  bottom: 20px; width: 44px; height: 44px; z-index: 50; background: #36f; }
  .aloud { position: fixed; left: 72px;  bottom: 20px; width: 44px; height: 44px; z-index: 50; background: #fa0; }
  .theme { position: fixed; left: 136px; bottom: 20px; width: 40px; height: 40px; z-index: 50; background: #ccc; }
  .sliver{ position: fixed; left: 0; top: 0; width: 1px; height: 1px; }
  .hidden{ position: fixed; left: 0; top: 0; width: 80px; height: 80px; visibility: hidden; }
  .behind{ position: fixed; left: 0; top: 200px; width: 300px; height: 300px; z-index: -1; }
</style></head><body>
  <header>site header</header>
  <main><p>content</p></main>
  <button class="a11y"  aria-label="Accessibility settings">A</button>
  <button class="aloud" aria-label="Read page aloud">R</button>
  <button class="theme" aria-label="System theme">T</button>
  <div class="sliver"></div><div class="hidden"></div><div class="behind"></div>
</body></html>`;

let browser: Browser;
let page: Page;

/**
 * Runs the SHIPPED detector.
 *
 * The first version of this file reimplemented the detector's DOM query inline
 * "because it is module-private". That tests a copy: revert the fix and the
 * copy still passes, which is the same mistake as measuring a component against
 * your own test markup instead of the CSS that ships. The function is exported
 * now, and this calls it.
 */
async function runDetector(p: Page) {
  const issues: AgentReadyIssue[] = [];
  const summary = { stickyOverlays: 0 } as unknown as Parameters<typeof detectStickyOverlays>[0]["summary"];
  await detectStickyOverlays({ page: p, issues, summary });
  return { count: summary.stickyOverlays, issues };
}

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(FIXTURE);
});

afterAll(async () => { await browser?.close(); });

describe("sticky detection counts what is on the page", () => {
  test("all four real sticky/fixed elements are counted", async () => {
    // The assertion that fails on the old thresholds: it reported 0.
    const { count } = await runDetector(page);
    expect(count).toBe(4);
  });

  test("1px slivers, hidden elements and negative z-index are excluded", async () => {
    // 4 and not 7: the three decoys must not inflate the count either.
    const { count } = await runDetector(page);
    expect(count).toBe(4);
  });
});

describe("obstruction is judged on coverage, not height alone", () => {
  test("only the full-width header is flagged as an issue", async () => {
    const { issues } = await runDetector(page);
    expect(issues.length).toBe(1);
    expect(issues[0].element).toContain("header");
    expect(issues[0].description).toContain("spans the viewport width");
  });

  test("the 44px and 40px corner buttons are counted but not flagged", async () => {
    // They occlude a corner. Counting them is a fact; calling each a stability
    // issue would be noise.
    const { count, issues } = await runDetector(page);
    expect(count).toBe(4);
    expect(issues.length).toBe(1);
    expect(count).not.toBe(issues.length); // the whole bug, in one line
  });

  test("the scroll-margin remedy quotes the real header height", async () => {
    const { issues } = await runDetector(page);
    expect(issues[0].codeExample).toContain("scroll-margin-top: 77px");
  });
});

describe("the old thresholds are gone from the source", () => {
  test("no `height > 40` filter and no `height > 60` flag remain", async () => {
    const raw = await Bun.file(
      new URL("../src/analysis/agent-ready-audit.ts", import.meta.url),
    ).text();
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toContain("el.height > 40");
    expect(code).not.toContain("sticky.height > 60");
    expect(code).toContain("summary.stickyOverlays = stickyElements.length");
  });
});
