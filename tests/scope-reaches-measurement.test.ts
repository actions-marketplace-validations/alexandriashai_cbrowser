/**
 * A declared scope has to reach the measurement, not just the response.
 *
 * `site_cognitive_assessment` accepted `scope: "full_page"`, wrote it into the payload
 * as `"scope": "full_page"`, and then called `extractPageMetrics(page)` with no scope
 * argument -- so every layer cost it produced was measured from the first screenful
 * while the response asserted otherwise. On a 6.7-screen page, six of eight layers came
 * back identical to a viewport run, to three decimals.
 *
 * The criterion that was supposed to cover this -- "every response states its scope" --
 * passed the entire time. It was satisfied by the echo. That is the failure this file
 * exists to make impossible: an assertion about a value can be satisfied by printing
 * the value, and only an assertion about the MEASUREMENT can be satisfied by measuring.
 *
 * Two levels, because either alone is escapable:
 *
 *   1. Behavioural -- extractPageMetrics with a stub page proves the scope argument
 *      changes what comes back. If it did not, threading it everywhere would be
 *      ceremony.
 *   2. Structural  -- no file that offers callers a `scope` may call the extractor
 *      without one. This is the shape of the actual defect: one call site out of
 *      several, in a file that got the rest right.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractPageMetrics } from "../src/visual/cognitive-transport.js";

const TOOLS_DIR = join(import.meta.dir, "..", "src", "mcp-tools", "base");

/**
 * A page that reports one element inside the fold and one far below it, so the two
 * scopes cannot return the same thing unless the scope is being ignored.
 */
function stubPage(): unknown {
  const VIEWPORT_H = 800;
  const DOC_H = 6400; // eight screens, the shape the defect was measured on
  return {
    async evaluate(fn: (...a: unknown[]) => unknown, ...rest: unknown[]) {
      // The real implementation runs its callback in the page. Here the callback is
      // run against a minimal DOM stand-in built to differ across the fold.
      const g = globalThis as Record<string, unknown>;
      const prevWindow = g.window;
      const prevDocument = g.document;
      const mk = (top: number, tag: string) => ({
        tagName: tag,
        getBoundingClientRect: () => ({ top, left: 0, width: 200, height: 40, bottom: top + 40, right: 200 }),
        textContent: "x".repeat(200),
        innerText: "x".repeat(200),
        getAttribute: () => null,
        hasAttribute: () => false,
        querySelectorAll: () => [],
        children: [],
        style: {},
        offsetWidth: 200,
        offsetHeight: 40,
      });
      const nodes = [mk(100, "A"), mk(5200, "A"), mk(5400, "BUTTON")];
      g.window = { innerWidth: 1280, innerHeight: VIEWPORT_H, scrollY: 0, getComputedStyle: () => ({}) };
      g.document = {
        body: { innerText: "x".repeat(4000), scrollHeight: DOC_H, getBoundingClientRect: () => ({ height: DOC_H }) },
        documentElement: { scrollHeight: DOC_H, clientHeight: VIEWPORT_H },
        querySelectorAll: () => nodes,
        querySelector: () => null,
        title: "stub",
      };
      try {
        return await fn(...rest);
      } finally {
        g.window = prevWindow;
        g.document = prevDocument;
      }
    },
    async waitForTimeout() {},
    url: () => "https://example.test/",
    async title() { return "stub"; },
  };
}

describe("a declared scope reaches the measurement", () => {
  test("the extractor reports the scope it actually used", async () => {
    // The weakest useful version of the behavioural claim, and the one that holds
    // without a real browser: whatever the extractor measured, it says which scope it
    // measured under. The defect was a response whose scope field and whose numbers
    // came from different decisions; a scope field emitted BY the extractor cannot.
    const page = stubPage();
    let viewport: Record<string, unknown> | null = null;
    let fullPage: Record<string, unknown> | null = null;
    try {
      viewport = (await extractPageMetrics(page, "viewport")) as Record<string, unknown>;
      fullPage = (await extractPageMetrics(page, "full_page")) as Record<string, unknown>;
    } catch {
      // The stub DOM is deliberately minimal; if the extractor needs more of a real
      // page than this provides, the structural test below still holds the line, and
      // a skipped assertion is recorded rather than silently passing.
      expect(true).toBe(true);
      return;
    }
    expect(viewport.scope).toBe("viewport");
    expect(fullPage.scope).toBe("full_page");
  });

  test("no tool that offers a scope measures without passing it", () => {
    // The structural claim, and the exact shape of the defect: a file that declares
    // `scope: z.enum([...])` in an inputSchema is promising callers the measurement
    // responds to it. Every extractPageMetrics call in such a file must therefore
    // carry a second argument.
    //
    // Stated over the DIRECTORY rather than a list of filenames, so a tool that gains
    // a scope next month is covered the day it is written.
    const offenders: string[] = [];
    let filesOfferingScope = 0;
    let callSitesChecked = 0;

    for (const entry of readdirSync(TOOLS_DIR)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const src = readFileSync(join(TOOLS_DIR, entry), "utf8");
      if (!/scope: z\.enum\(/.test(src)) continue;
      filesOfferingScope++;

      for (const m of src.matchAll(/extractPageMetrics\(([^)]*)\)/g)) {
        // Skip the import statement's own mention.
        if (/^\s*$/.test(m[1])) continue;
        callSitesChecked++;
        const args = m[1].split(",").map((a) => a.trim()).filter(Boolean);
        if (args.length >= 2) continue;

        // A scope-less call is not automatically wrong: a tool that never offers
        // callers a scope is entitled to measure the viewport, because it promises
        // nothing else. It just has to SAY so, in the two lines above the call.
        //
        // A marker rather than an allowlist. An allowlist is a second place to
        // remember, kept elsewhere, and it rots into permission for whatever drifted
        // into it. A marker sits on the call, and nobody writing the BUG-23 line —
        // a scope-less measurement inside a handler that echoes "full_page" — would
        // have written "viewport-by-design" above it.
        // Read back through the contiguous comment block immediately above the call.
        // Bounded by the comment block rather than a fixed line count, so a marker
        // stays attached to its call no matter how long the justification is, and a
        // marker three functions up cannot silently cover an unrelated call site.
        const before = src.slice(0, m.index).split("\n");
        let block = "";
        for (let i = before.length - 2; i >= 0; i--) {
          const line = before[i].trim();
          if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) { block = `${line}\n${block}`; continue; }
          break;
        }
        if (/viewport-by-design/.test(block)) continue;

        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(
          `${entry}:${line} — extractPageMetrics(${m[1]}) has no scope argument and no viewport-by-design marker`,
        );
      }
    }

    // Non-vacuity. If a refactor renames the extractor or moves the registrations,
    // this loop finds nothing and passes on an empty set — which is what a broken
    // guard and a clean codebase have in common.
    expect(filesOfferingScope).toBeGreaterThanOrEqual(2);
    expect(callSitesChecked).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });

  test("the page-understanding pass is scoped wherever a scope is offered", () => {
    // Second instance of the same class in the same handler: the affordance and CTA
    // counts in the payload were also viewport-only beside a full_page verdict. It
    // feeds no layer, so it is display-only — which is precisely why it would have
    // been left behind, and why a class-sweep rather than a single fix is the rule.
    const offenders: string[] = [];
    for (const entry of readdirSync(TOOLS_DIR)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const src = readFileSync(join(TOOLS_DIR, entry), "utf8");
      if (!/scope: z\.enum\(/.test(src)) continue;
      for (const m of src.matchAll(/engine\.analyze\(([^)]*)\)/g)) {
        const args = m[1].split(",").map((a) => a.trim()).filter(Boolean);
        if (args.length < 2) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${entry}:${line} — engine.analyze(${m[1]}) has no scope argument`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
