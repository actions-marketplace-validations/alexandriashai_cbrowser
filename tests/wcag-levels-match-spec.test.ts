/**
 * Every level in WCAG_CRITERIA must match the W3C specification.
 *
 * A wrong level is worse than a missing entry, and worse in a specific
 * direction: a criterion mislabelled AAA is filtered out of every default (AA)
 * audit, so a real violation the tool detected is silently dropped from the
 * report. A criterion mislabelled A is merely over-reported at Level A, which
 * is visible.
 *
 * Audited 2026-08-12 against https://www.w3.org/TR/WCAG22/ — all 35 levels
 * matched. This test exists so that stays true, not because it was false.
 *
 * The comparison runs against a committed snapshot (fixtures/wcag22-levels.json)
 * rather than fetching. A test that reaches the network is a test that fails on
 * a plane and passes for the wrong reasons behind a caching proxy; the snapshot
 * is dated and refreshed deliberately.
 *
 * Method note, learned the hard way: the first source consulted for this
 * (the WCAG quickref, 457KB, summarised by a model) reported 2.5.5, 2.5.7 AND
 * 2.5.8 as Level A — all three wrong. It was caught because 2.5.8 was held back
 * as a control against the value already in the table. The snapshot is instead
 * PARSED from the spec's own markup, so no summarisation sits between the
 * specification and this assertion.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */
import { describe, test, expect } from "bun:test";

interface Snapshot {
  _source: string;
  criteria: Record<string, { level: string; title: string }>;
}

const snapshot = async (): Promise<Snapshot> =>
  JSON.parse(await Bun.file(new URL("./fixtures/wcag22-levels.json", import.meta.url)).text());

/** The table as the shipped source declares it. */
async function table(): Promise<Record<string, { level: string; title: string }>> {
  const src = await Bun.file(
    new URL("../src/analysis/accessibility-empathy.ts", import.meta.url),
  ).text();
  const out: Record<string, { level: string; title: string }> = {};
  for (const m of src.matchAll(
    /"(\d+\.\d+\.\d+)":\s*\{\s*level:\s*"(A{1,3})",\s*description:\s*"([^"]*)"\s*\}/g,
  )) {
    out[m[1]] = { level: m[2], title: m[3] };
  }
  return out;
}

describe("the criteria table agrees with the W3C specification", () => {
  test("every level matches", async () => {
    const [spec, tbl] = [await snapshot(), await table()];
    const wrong = Object.entries(tbl)
      .filter(([n, e]) => spec.criteria[n] && spec.criteria[n].level !== e.level)
      .map(([n, e]) => `${n}: table=${e.level} spec=${spec.criteria[n].level}`);
    expect(wrong).toEqual([]);
  });

  test("every title matches", async () => {
    // Titles are not decoration in a compliance report: "Link Purpose" alone is
    // ambiguous between 2.4.4 (In Context, A) and 2.4.9 (Link Only, AAA).
    const [spec, tbl] = [await snapshot(), await table()];
    const wrong = Object.entries(tbl)
      .filter(([n, e]) => spec.criteria[n] && spec.criteria[n].title !== e.title)
      .map(([n, e]) => `${n}: table="${e.title}" spec="${spec.criteria[n].title}"`);
    expect(wrong).toEqual([]);
  });

  test("every criterion in the table exists in the specification", async () => {
    const [spec, tbl] = [await snapshot(), await table()];
    expect(Object.keys(tbl).filter((n) => !spec.criteria[n])).toEqual([]);
  });

  test("both sides parsed — this cannot pass by matching nothing", async () => {
    const [spec, tbl] = [await snapshot(), await table()];
    expect(Object.keys(spec.criteria).length).toBeGreaterThan(80);
    expect(Object.keys(tbl).length).toBeGreaterThan(30);
  });

  test("the AAA entries are right, because that direction drops findings", async () => {
    // A criterion wrongly marked AAA vanishes from every default AA audit.
    const [spec, tbl] = [await snapshot(), await table()];
    for (const [n, e] of Object.entries(tbl)) {
      if (e.level === "AAA") expect(spec.criteria[n]?.level, `${n}`).toBe("AAA");
    }
  });
});
