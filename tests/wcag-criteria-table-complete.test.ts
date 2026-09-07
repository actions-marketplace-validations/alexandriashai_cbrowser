/**
 * Every criterion the detectors emit must resolve in WCAG_CRITERIA.
 *
 * An absent entry does not fail loudly — `WCAG_CRITERIA[v]` is `undefined`, the
 * level filter reads `!criteria ||` and keeps the criterion, so it passes at
 * EVERY conformance level. A Level A audit therefore reported AA criteria as
 * Level A findings, and nothing anywhere said the level had not been checked.
 *
 * Five were missing when this was measured: 1.4.2, 1.4.12, 2.5.1, 2.5.7, 3.3.4.
 *
 * Keeping the criterion rather than dropping it is the right default — silently
 * discarding a detected violation is the worse failure — so this test is what
 * makes the fallback a safety net instead of a place things quietly live.
 *
 * Levels here were verified against the W3C WCAG 2.2 spec and Understanding
 * documents. The first source consulted returned Level A for 2.5.7, 2.5.8 and
 * 2.5.5; it was discarded because 2.5.8 was held back as a control and its
 * answer contradicted the table. Cross-check any future addition the same way.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */
import { describe, test, expect } from "bun:test";

const SRC = new URL("../src/analysis/accessibility-empathy.ts", import.meta.url);

async function source(): Promise<string> {
  return await Bun.file(SRC).text();
}

/** Criteria the file actually emits, from barrier arrays and detector adds. */
function emitted(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/wcagCriteria(?:\.push\(|:\s*\[)([^\]\)]*)/g)) {
    for (const c of m[1].matchAll(/"(\d+\.\d+\.\d+)"/g)) out.add(c[1]);
  }
  for (const m of src.matchAll(/wcagViolations\.add\("(\d+\.\d+\.\d+)"\)/g)) out.add(m[1]);
  return out;
}

/** Criteria the level table can resolve. */
function tabled(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/"(\d+\.\d+\.\d+)":\s*\{\s*level:\s*"(A{1,3})"/g)) out.set(m[1], m[2]);
  return out;
}

describe("the criteria table covers everything the detectors emit", () => {
  test("no emitted criterion is missing a level", async () => {
    const src = await source();
    const missing = [...emitted(src)].filter((c) => !tabled(src).has(c)).sort();
    expect(missing).toEqual([]);
  });

  test("the scrapers actually find something — the test cannot pass by finding nothing", async () => {
    // Without this, a regex that stops matching turns this file into two
    // vacuous assertions that pass forever.
    const src = await source();
    expect(emitted(src).size).toBeGreaterThan(15);
    expect(tabled(src).size).toBeGreaterThan(25);
  });

  test("the five that were missing are present with their verified levels", async () => {
    const t = tabled(await source());
    expect(t.get("1.4.2")).toBe("A");    // Audio Control
    expect(t.get("1.4.12")).toBe("AA");  // Text Spacing
    expect(t.get("2.5.1")).toBe("A");    // Pointer Gestures
    expect(t.get("2.5.7")).toBe("AA");   // Dragging Movements
    expect(t.get("3.3.4")).toBe("AA");   // Error Prevention (Legal, Financial, Data)
  });

  test("the control criterion still reads AA", async () => {
    // 2.5.8 Target Size (Minimum). The value that caught a bad source.
    expect(tabled(await source()).get("2.5.8")).toBe("AA");
  });

  test("every level is one of A, AA, AAA", async () => {
    for (const [c, lvl] of tabled(await source())) {
      expect(["A", "AA", "AAA"], `${c} has level ${lvl}`).toContain(lvl);
    }
  });
});
