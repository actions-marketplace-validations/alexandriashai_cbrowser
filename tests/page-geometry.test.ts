/**
 * One height measurement, two derivations that cannot disagree.
 *
 * `pageScreens` -- the caption a caller reads -- and `screenCount` -- how many screens
 * the sequential curve is scored over -- were derived independently, from two separate
 * height reads at two different moments. Same class as a capacity bridge wired into one
 * of two tools: one model, two consumers, separately wired.
 *
 * It is a defect whether or not the height is stable, and the instability is not
 * hypothetical: an external client measured 5.8 screens on a session's first navigation
 * and 6.7 on every later one, on the same URL. With two reads the caption could say 6.7
 * while the curve was scored over 6 screens, and NOTHING in the payload would show it,
 * because a 6-screen curve is internally consistent and unmarked. That is the shape of
 * every defect this tool has had.
 *
 * Sharing the function alone would not have fixed it. Two calls at two moments agree on
 * arithmetic and still read a page that moved in between -- the formula converges and
 * the race survives. So the assertions below are about the MEASUREMENT being singular,
 * not about the formula matching.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { measurePageGeometry } from "../src/visual/cognitive-transport.js";

const SRC = join(import.meta.dir, "..", "src");
const transport = readFileSync(join(SRC, "visual", "cognitive-transport.ts"), "utf8");
const effort = readFileSync(join(SRC, "mcp-tools", "base", "persona-comparison-tools.ts"), "utf8");

/** A page whose height we control, so the derivations can be checked against it. */
function pageOfHeight(documentHeight: number, viewportHeight = 800) {
  return {
    async evaluate(fn: () => unknown) {
      const g = globalThis as Record<string, unknown>;
      const prevW = g.window, prevD = g.document;
      g.window = { innerHeight: viewportHeight, innerWidth: 1280 };
      g.document = { documentElement: { scrollHeight: documentHeight } };
      try { return await fn(); } finally { g.window = prevW; g.document = prevD; }
    },
  };
}

describe("page geometry is measured once", () => {
  test("both derivations come from the same numbers", async () => {
    const g = await measurePageGeometry(pageOfHeight(5337) as never);
    expect(g.documentHeight).toBe(5337);
    expect(g.viewportHeight).toBe(800);
    // 5337/800 = 6.67 -> caption 6.7, curve 7 screens. Different roundings of ONE
    // ratio, which is the point: they may differ in form, never in input.
    expect(g.pageScreens).toBe(6.7);
    expect(g.screenCount).toBe(7);
    expect(g.screenCount).toBe(Math.ceil(g.documentHeight / g.viewportHeight));
    expect(g.pageScreens).toBe(Math.round((g.documentHeight / g.viewportHeight) * 10) / 10);
  });

  test("the reported 5.8 and 6.7 are a height difference, not a rounding one", async () => {
    // Pins what a differing observation would MEAN. 5.8 vs 6.7 at the same viewport is
    // ~700px of document, which is a real layout difference and not two roundings of
    // one number -- so if a future sample differs, documentHeight is where to look.
    const a = await measurePageGeometry(pageOfHeight(4640) as never);
    const b = await measurePageGeometry(pageOfHeight(5337) as never);
    expect(a.pageScreens).toBe(5.8);
    expect(b.pageScreens).toBe(6.7);
    // And the curve length moves with it: a 6-screen curve vs a 7-screen curve.
    expect(a.screenCount).toBe(6);
    expect(b.screenCount).toBe(7);
  });

  test("the screen count is capped, and the cap is visible in the count", async () => {
    const tall = await measurePageGeometry(pageOfHeight(800 * 500) as never, 20);
    expect(tall.screenCount).toBe(20);
    // The caption is NOT capped, so the two together say "500 screens, scored 20"
    // rather than silently claiming the whole document was walked.
    expect(tall.pageScreens).toBe(500);
  });

  test("a one-screen page is one screen, not zero", async () => {
    const short = await measurePageGeometry(pageOfHeight(400) as never);
    // documentHeight is floored at the viewport, so a short page is exactly 1.
    expect(short.documentHeight).toBe(800);
    expect(short.screenCount).toBe(1);
    expect(short.pageScreens).toBe(1);
  });

  test("nothing derives the height independently any more", () => {
    // The anti-criterion, and the one that keeps the class closed. A second
    // `scrollHeight` read outside measurePageGeometry re-creates exactly the defect:
    // two consumers of one quantity, separately wired, free to disagree.
    const reads = transport.split("documentElement.scrollHeight").length - 1;
    expect(reads).toBe(1);
    // ...and that one read is inside the shared measurement.
    const fnStart = transport.indexOf("export async function measurePageGeometry");
    const fnEnd = transport.indexOf("\n}", fnStart);
    expect(transport.slice(fnStart, fnEnd)).toContain("documentElement.scrollHeight");
  });

  test("the handler measures once and passes it to both consumers", () => {
    // Sharing the function is not the claim; sharing the MEASUREMENT is. One call to
    // measurePageGeometry, threaded to the aggregate and to the per-screen pass.
    expect(effort.split("measurePageGeometry(page)").length - 1).toBe(1);
    expect(effort).toContain("extractPerScreenMetrics(page, 20, sharedGeometry)");
    expect(effort).toContain("sharedGeometry,\n      );");
  });

  test("the sequential block publishes the inputs its count came from", () => {
    // An invisible variance is indistinguishable from no variance. With only
    // `screensMeasured` in the payload, a 6-screen curve is unmarked; with the inputs
    // published, a differing curve is diagnosable instead of guessable.
    for (const field of ["documentHeight", "viewportHeight", "pageScreens", "screenCount"]) {
      expect(effort).toContain(`${field}: sharedGeometry.${field}`);
    }
  });
});
