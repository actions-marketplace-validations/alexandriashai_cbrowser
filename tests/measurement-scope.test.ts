/**
 * What `cognitive_effort` and `page_understand` measure, and saying so.
 *
 * Both were viewport-scoped and neither declared it. Every CTC number the tool
 * ever produced described the first screenful, and the output called it the
 * page. On ucdenver.edu/academics -- 6436px, 8 screens -- the viewport sees 4
 * laid-out links and 47 words, so the page scored LOWER cognitive load than a
 * shorter homepage. Internally consistent, indefensible as output; the same
 * shape as the skip-link false positive.
 *
 * `empathy_audit` already had a `scope` enum of viewport | full_page. These two
 * now match it, defaulting to viewport so that no published number changes
 * meaning underneath anyone.
 *
 * @since 2026-08-02
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const transport = readFileSync(join(SRC, "visual", "cognitive-transport.ts"), "utf8");
const effort = readFileSync(join(SRC, "mcp-tools", "base", "persona-comparison-tools.ts"), "utf8");
const understanding = readFileSync(join(SRC, "analysis", "page-understanding.ts"), "utf8");
const knowledge = readFileSync(join(SRC, "mcp-tools", "base", "site-knowledge-tools.ts"), "utf8");
const audit = readFileSync(join(SRC, "mcp-tools", "base", "audit-tools.ts"), "utf8");

describe("the scope parameter matches empathy_audit", () => {
  test("cognitive_effort takes the same enum with the same default", () => {
    // Same spelling, same values, same default. Consistency across the three
    // tools matters more than any of them picking the better default.
    const empathyEnum = audit.match(/scope: z\.enum\(\[([^\]]+)\]\)\.optional\(\)\.default\("viewport"\)/)![1];
    expect(empathyEnum).toContain('"viewport"');
    expect(empathyEnum).toContain('"full_page"');
    expect(effort).toMatch(/scope: z\.enum\(\["viewport", "full_page"\]\)\.optional\(\)\.default\("viewport"\)/);
  });

  test("page_understand exposes its third mode rather than hiding it", () => {
    // Its restriction was CONDITIONAL -- full document under 1000 elements,
    // viewport above -- so one call measured two different things depending on
    // page size and said neither. `auto` keeps that for compatibility and is
    // now nameable and reportable.
    expect(knowledge).toMatch(/scope: z\.enum\(\["auto", "viewport", "full_page"\]\)/);
    expect(understanding).toContain('mode === "viewport" ? true');
    expect(understanding).toContain('mode === "full_page" ? false');
    expect(understanding).toContain("totalElementCount > maxElements");
  });

  test("the default is still viewport, so no published number changed", () => {
    expect(transport).toContain('scope: MetricScope = "viewport"');
    expect(effort).toContain('const measureScope = scope ?? "viewport"');
  });
});

describe("full_page actually measures the full page", () => {
  test("the viewport filter is bypassed, not merely widened", () => {
    const fn = transport.slice(transport.indexOf("const inViewport = (el: Element)"));
    const body = fn.slice(0, fn.indexOf("};"));
    expect(body).toContain("if (fullPage) return true;");
    // Zero-size elements stay excluded at BOTH scopes: a display:none link in a
    // mega-menu is not a choice anyone faces. This is why a raw
    // querySelectorAll('a') count does not match what this measures.
    expect(body).toContain("if (rect.width <= 0 || rect.height <= 0) return false;");
  });

  test("density is normalised against the document, not one screen", () => {
    // Counting whole-page text and dividing by a screenful would report a
    // density the page does not have.
    expect(transport).toContain("const viewportArea = vw * (fullPage ? docHeight : vh);");
  });

  test("it scrolls first, so lazy content exists to be counted", () => {
    const head = transport.slice(transport.indexOf("export async function extractPageMetrics"));
    expect(head.slice(0, 2600)).toContain('if (scope === "full_page")');
    expect(head.slice(0, 2600)).toContain("window.scrollTo(0, 0)");
  });

  test("no midpoint was recalibrated while fixing an undeclared assumption", () => {
    // The formulas are unchanged; only what feeds them moved. Inventing new
    // constants here would replace one undeclared assumption with another.
    expect(transport).toContain("logScale(textLength, 5000)");
    expect(transport).toContain("uniqueColors.size * 3 + imageCount * 2 + visibleCount * 0.5,\n      200");
    expect(transport).toContain("logScale(textLength / Math.max(1, viewportArea * 0.001), 3)");
  });
});

describe("the output says which of the two it is", () => {
  test("the verdict names its own scope", () => {
    // "should handle this page comfortably" off the top 800px of a 6436px page
    // is the misleading claim; the sentence now says which it measured.
    expect(effort).toContain('measureScope === "full_page" ? "this page" : "the top of this page"');
  });

  test("a tall page measured at viewport scope says what it missed", () => {
    expect(effort).toContain("so most of it was not measured");
    expect(effort).toContain("pageScreens");
  });

  test("the response carries scope, page height and a note at both scopes", () => {
    expect(effort).toContain("scope: measureScope,");
    expect(effort).toContain("pageScreens: pageMetrics.pageScreens,");
    const note = effort.slice(effort.indexOf("scopeNote: measureScope"));
    expect(note.slice(0, 1600)).toContain("VIEWPORT ONLY");
    expect(note.slice(0, 1600)).toContain("Not comparable with viewport-scoped numbers");
  });

  test("page_understand reports the mode that actually ran", () => {
    expect(understanding).toContain('extractionScope: (limitToViewport ? "viewport" : "full_page")');
    expect(knowledge).toContain("extractionScope: understanding.extractionScope");
    expect(knowledge).toContain("VIEWPORT ONLY");
  });

  test("the tool descriptions state the default, since that is what a model reads", () => {
    expect(effort).toContain("MEASURES THE VIEWPORT BY DEFAULT");
    expect(knowledge).toContain("silently falls back to the viewport above 1000 elements");
  });
});

describe("silent truncation is reported", () => {
  test("the choice-count cap emits the raw number beside it", () => {
    // Unreachable at viewport scope and hit at full_page on the CU Denver
    // homepage. A truncated value that looks like a measurement is the same
    // defect as analyze_page's undocumented 20-link cap.
    expect(transport).toContain("choiceCountRaw: choiceCount,");
    expect(transport).toContain("choiceCountCapped: choiceCount > 100,");
  });
});
