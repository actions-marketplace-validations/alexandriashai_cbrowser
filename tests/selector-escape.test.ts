/**
 * Selector escaping — generated selectors must actually resolve.
 *
 * Every selector-building path interpolated raw attribute values into selector
 * strings. Verified against a real Chromium before the fix:
 *
 *   #:r0:        -> DOMException       (React 18 useId emits this exact shape)
 *   #2fa-code    -> DOMException       (leading digit invalid in CSS)
 *   #a.b         -> NO MATCH, no throw (read as element#a with class b)
 *   [aria-label="He said "hi""] -> DOMException
 *
 * The silent one is the reason this test exists rather than a try/catch: a
 * selector that throws gets noticed, a selector that matches nothing gets
 * reported as "element not found" and the selector looks fine in the report.
 *
 * The escaper is pure JS because it also has to run in Node, where CSS.escape
 * does not exist. That makes agreement with the native implementation something
 * to prove rather than assume — hence the first test.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import {
  escapeCssIdent,
  escapeAttrValue,
  idSelector,
  attrSelector,
} from "../src/selector-escape.js";

/** Ids and labels real frameworks emit, plus the pathological ones. */
const HOSTILE_IDS = [
  ":r0:",        // React 18 useId
  ":r1a:",       // React 18 useId, later counter
  "2fa-code",    // leading digit
  "a.b",         // dot — the silent failure
  "a b",         // space
  "a#b",         // hash
  "--custom",
  "0",
  "-",
  "élan",
  "ok_id-1",     // already valid; must survive unchanged
];

const HOSTILE_LABELS = [
  'He said "hi"',
  "back\\slash",
  "plain label",
  'quote" and \\slash',
];

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  const buttons = HOSTILE_IDS.map(
    (id, i) => `<button id="${id.replace(/"/g, "&quot;")}">id-${i}</button>`
  ).join("\n");
  const labelled = HOSTILE_LABELS.map(
    (l, i) =>
      `<button aria-label="${l.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">label-${i}</button>`
  ).join("\n");
  await page.setContent(`<!doctype html><html><body>${buttons}\n${labelled}</body></html>`);
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe("selector escaping", () => {
  test("the pure-JS escaper agrees with the browser's native CSS.escape", async () => {
    const native = await page.evaluate(
      (cases: string[]) => cases.map((c) => CSS.escape(c)),
      HOSTILE_IDS
    );
    expect(HOSTILE_IDS.map(escapeCssIdent)).toEqual(native);
  });

  test("every hostile id yields a selector that resolves to its element", async () => {
    for (const id of HOSTILE_IDS) {
      const selector = idSelector(id);
      const matched = await page.evaluate(
        ({ sel, want }: { sel: string; want: string }) => {
          try {
            const el = document.querySelector(sel);
            return el ? (el as HTMLElement).id === want : "NO_MATCH";
          } catch (e) {
            return `THREW:${(e as Error).constructor.name}`;
          }
        },
        { sel: selector, want: id }
      );
      expect({ id, matched }).toEqual({ id, matched: true });
    }
  });

  test("every hostile aria-label yields a selector that resolves", async () => {
    for (const label of HOSTILE_LABELS) {
      const selector = attrSelector("aria-label", label);
      const matched = await page.evaluate(
        ({ sel, want }: { sel: string; want: string }) => {
          try {
            const el = document.querySelector(sel);
            return el ? el.getAttribute("aria-label") === want : "NO_MATCH";
          } catch (e) {
            return `THREW:${(e as Error).constructor.name}`;
          }
        },
        { sel: selector, want: label }
      );
      expect({ label, matched }).toEqual({ label, matched: true });
    }
  });

  test("the unescaped forms genuinely fail — the reason this exists", async () => {
    const outcomes = await page.evaluate((ids: string[]) =>
      ids.map((id) => {
        try {
          return document.querySelector(`#${id}`) ? "matched" : "NO_MATCH";
        } catch {
          return "THREW";
        }
      })
    , [":r0:", "2fa-code", "a.b"]);
    expect(outcomes).toEqual(["THREW", "THREW", "NO_MATCH"]);
  });

  test("valid identifiers pass through untouched", () => {
    expect(escapeCssIdent("ok_id-1")).toBe("ok_id-1");
    expect(escapeAttrValue("plain label")).toBe("plain label");
  });

  test("attribute values close their quotes correctly", () => {
    expect(attrSelector("data-testid", 'a"b')).toBe('[data-testid="a\\"b"]');
  });
});
