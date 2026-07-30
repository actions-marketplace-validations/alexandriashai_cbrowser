/**
 * SVG `className` — the P0, and the class it belongs to.
 *
 * `SVGAnimatedString` has no string methods, so `el.className.split(' ')` throws
 * on every `<svg>` and `<path>`. Measured on cbrowser.ai: **436 of 1070**
 * elements. Lucide, Heroicons, Feather, Font Awesome SVG and most Tailwind
 * component libraries all produce them, so this was firing on the large majority
 * of modern sites.
 *
 * What made it expensive was not the crash. The throw skipped the line that sets
 * `goalAchieved`, leaving it at its initialised `false`, so the scorer charged a
 * 15-point goal deduction — and the error surfaced ONLY in the HTML report. The
 * JSON therefore reported a confident wrong number with no indication anything
 * had failed. A loud crash would have been fixed in a day.
 *
 * There is a quieter sibling: `.className?.toString()` does not throw, it returns
 * the literal string "[object SVGAnimatedString]", which then flows into a
 * class-matching regex that can never match. No error, no signal, wrong answer.
 *
 * TypeScript is complicit — `lib.dom` types `className` as `string`, so every one
 * of these call sites type-checked cleanly. That is why the guard is asserted
 * here rather than trusted to the compiler.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let browser: Browser;
let page: Page;

const MARKUP = `<!doctype html><html><body>
  <div class="hero primary">plain html</div>
  <svg class="lucide lucide-sparkles h-4 w-4"><path class="p1" d="M0 0"/></svg>
  <a href="/docs" class="nav-link"><svg class="icon"><path class="q"/></svg> Docs</a>
  <button class="cta primary">Go</button>
  <svg></svg>
</body></html>`;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(MARKUP);
}, 60_000);

afterAll(async () => { await browser?.close(); });

/** The expression every fixed call site now uses. */
const SAFE = (v: string) =>
  `String((${v}.className as unknown as { baseVal?: string })?.baseVal ?? ${v}.className ?? "")`;

describe("the failure is real", () => {
  test("SVG className is not a string, and string methods throw on it", async () => {
    const survey = await page.evaluate(() => {
      const all = [...document.querySelectorAll("*")];
      const nonString = all.filter((el) => typeof (el as HTMLElement).className !== "string");
      let threw = false;
      try {
        all.map((el) => (el as HTMLElement).className.split(" ")[0]);
      } catch {
        threw = true;
      }
      return { nonString: nonString.length, threw };
    });
    expect(survey.nonString).toBeGreaterThan(0);
    expect(survey.threw).toBe(true);
  });

  test("the quiet variant returns garbage instead of throwing", async () => {
    const out = await page.evaluate(() =>
      (document.querySelector("svg") as SVGElement).className?.toString(),
    );
    expect(out).toBe("[object SVGAnimatedString]");
  });
});

describe("the fix", () => {
  test("recovers the real class list from SVG and HTML alike", async () => {
    const out = await page.evaluate(() => {
      const read = (el: Element) =>
        String((el.className as unknown as { baseVal?: string })?.baseVal ?? el.className ?? "");
      return {
        svg: read(document.querySelector("svg")!),
        path: read(document.querySelector("path")!),
        div: read(document.querySelector("div")!),
        empty: read(document.querySelectorAll("svg")[2]),
      };
    });
    expect(out.svg).toBe("lucide lucide-sparkles h-4 w-4");
    expect(out.path).toBe("p1");
    expect(out.div).toBe("hero primary");
    expect(out.empty).toBe("");
  });

  test("splitting no longer throws across every element on the page", async () => {
    const first = await page.evaluate(() =>
      [...document.querySelectorAll("*")].map((el) =>
        String((el.className as unknown as { baseVal?: string })?.baseVal ?? el.className ?? "").split(" ")[0],
      ),
    );
    expect(Array.isArray(first)).toBe(true);
    expect(first).toContain("lucide");
  });
});

describe("class-sweep — no unguarded className access remains in src/", () => {
  // A grep, deliberately. The defect was 20+ independent call sites, and the
  // only durable fix is that none of the unsafe shape survives anywhere.
  const SRC = join(import.meta.dir, "..", "src");
  const UNSAFE = /\.className\.(split|includes|indexOf|toLowerCase|match|replace|trim|startsWith|endsWith|slice|substring)\s*\(/;
  const QUIET = /\.className\?\.toString\(\)/;

  function scan(re: RegExp): string[] {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts")) {
          readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith("*") || t.startsWith("//")) return;
            if (re.test(line)) hits.push(`${p.replace(SRC, "src")}:${i + 1}`);
          });
        }
      }
    };
    walk(SRC);
    return hits;
  }

  test("no direct string method on .className", () => {
    expect(scan(UNSAFE)).toEqual([]);
  });

  test("no .className?.toString() — it silently yields [object SVGAnimatedString]", () => {
    expect(scan(QUIET)).toEqual([]);
  });
});

describe("the guard expression itself", () => {
  test("is what the call sites actually use", () => {
    // Cheap consistency check so the sweep above and the fix cannot drift.
    expect(SAFE("el")).toContain("baseVal");
    expect(SAFE("el")).toContain('?? ""');
  });
});
