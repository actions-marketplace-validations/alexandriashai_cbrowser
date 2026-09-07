/**
 * `freezeAnimations` must actually stop the animations, and say so honestly.
 *
 * Two `attention_analysis` runs of the same page and persona disagreed by 0.18%
 * on the CTA basis while the LLM judgement came back byte-identical and the
 * static H1 was identical to five decimals. The elements that moved sat in a
 * promo banner running `promo-shift 8s infinite`; the page carries 122 running
 * animations, 119 infinite. Two screenshots milliseconds apart are not the same
 * image, and the saliency layer reads the image.
 *
 * The half of this that would fail silently is a freeze that does not take. A
 * run labelled `animationState: "frozen"` while animations keep playing produces
 * exactly the variance it was asked to remove, under a label saying it was
 * removed. So `countRunningAnimations` is asserted separately from the freeze,
 * and the tool reports it either way.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { freezeAnimations, countRunningAnimations } from "../src/visual/freeze-animations.js";

/** CSS animation, a Web-Animations instance, and a transition. */
const FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>animated</title><style>
  @keyframes drift { from { opacity: .2 } to { opacity: 1 } }
  .css-anim { animation: drift 4s infinite; width: 100px; height: 40px; background: #36f; }
  .many { animation: drift 8s infinite; width: 20px; height: 20px; background: #999; }
  .trans { transition: opacity 3s; opacity: 1; width: 50px; height: 50px; background: #fa0; }
</style></head><body>
  <div class="css-anim"></div>
  <div class="many"></div><div class="many"></div><div class="many"></div>
  <div class="trans"></div>
  <div id="waapi" style="width:30px;height:30px;background:#0a0"></div>
  <script>
    document.getElementById('waapi').animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(50px)' }],
      { duration: 5000, iterations: Infinity }
    );
  </script>
</body></html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
});

afterAll(async () => { await browser?.close(); });

describe("the fixture actually animates", () => {
  test("animations are running before any freeze", async () => {
    // Without this the freeze assertions below would pass on a static page and
    // prove nothing at all.
    await page.setContent(FIXTURE);
    const running = await countRunningAnimations(page as never);
    expect(running).toBeGreaterThan(0);
  });

  test("the Web-Animations instance is among them", async () => {
    await page.setContent(FIXTURE);
    const kinds = await page.evaluate(() =>
      (document.getAnimations?.() ?? []).map((a) => a.constructor.name));
    // CSS animations and a script-driven one are different objects; a CSS-only
    // freeze would leave the second playing.
    expect(kinds.length).toBeGreaterThanOrEqual(5);
  });
});

describe("freezing stops everything", () => {
  test("no animation is running afterwards", async () => {
    await page.setContent(FIXTURE);
    const before = await countRunningAnimations(page as never);
    const state = await freezeAnimations(page as never);
    const after = await countRunningAnimations(page as never);

    expect(before).toBeGreaterThan(0);
    expect(state).toBe("frozen");
    expect(after).toBe(0);
  });

  test("the Web-Animations instance is paused too, not just the CSS ones", async () => {
    await page.setContent(FIXTURE);
    await freezeAnimations(page as never);
    const playing = await page.evaluate(() =>
      (document.getAnimations?.() ?? []).filter((a) => a.playState === "running").length);
    expect(playing).toBe(0);
  });

  test("two frozen screenshots are byte-identical", async () => {
    // The end the whole flag exists for. On the live fixture these differ.
    await page.setContent(FIXTURE);
    await freezeAnimations(page as never);
    const a = await page.screenshot();
    await new Promise((r) => setTimeout(r, 600));
    const b = await page.screenshot();
    expect(Buffer.compare(a, b)).toBe(0);
  });

  test("two LIVE screenshots of the same page differ", async () => {
    // The control. If this ever passes, the fixture stopped animating and every
    // assertion above became vacuous.
    await page.setContent(FIXTURE);
    const a = await page.screenshot();
    await new Promise((r) => setTimeout(r, 600));
    const b = await page.screenshot();
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});

describe("honest reporting", () => {
  test("countRunningAnimations reports 0 on a static page, not an error", async () => {
    await page.setContent("<!doctype html><html lang=\"en\"><head><title>t</title></head><body><p>static</p></body></html>");
    expect(await countRunningAnimations(page as never)).toBe(0);
  });

  test("freezing an already-static page is not an error", async () => {
    await page.setContent("<!doctype html><html lang=\"en\"><head><title>t</title></head><body><p>static</p></body></html>");
    expect(await freezeAnimations(page as never)).toBe("frozen");
    expect(await countRunningAnimations(page as never)).toBe(0);
  });

  test("the tool reports animationState and warns when a freeze did not take", async () => {
    const src = await Bun.file(
      new URL("../src/mcp-tools/base/visual-testing-tools.ts", import.meta.url),
    ).text();
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).toContain("animationState,");
    expect(code).toContain("animationWarning");
    // And it tells a caller on a LIVE animated page why their runs disagree.
    expect(code).toContain("animationNote");
  });
});
