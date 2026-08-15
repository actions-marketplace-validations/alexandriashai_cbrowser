/**
 * A timeout must hold even when the thing being polled never answers.
 *
 * `waitForCondition` drove every capture trigger through:
 *
 *   while (Date.now() < deadline) {
 *     if (await holds().catch(() => false)) return true;
 *     await new Promise((r) => setTimeout(r, intervalMs));
 *   }
 *
 * The deadline is checked only BETWEEN iterations, and `holds` queries the page
 * over CDP. One probe that never settles therefore skips every remaining
 * deadline check, and the timeout it advertises can never fire.
 *
 * Measured 2026-08-14: recording-engine run alongside recording-change-tiers
 * hung five tests at exactly 60000.94ms — one of them named "a start trigger
 * that never fires reports the timeout instead of hanging". Alone, each file
 * passed (45 and 12), because an uncontended probe always returns. That is why
 * it read as flakiness for weeks and survived twelve refuted hypotheses: the
 * defect needs a slow page to become visible, and the shared browser only gets
 * slow when another capture-heavy file is in the same process.
 *
 * These tests take no browser: a never-settling probe is one line to write and
 * nearly impossible to stage reliably through a real page.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */
import { describe, test, expect } from "bun:test";
import { pollUntil } from "../src/recording/engine.js";

const never = () => new Promise<boolean>(() => { /* never settles */ });

describe("the bound holds regardless of the probe", () => {
  test("a probe that NEVER settles still times out", async () => {
    // The regression. Before the fix this hung until the test ceiling.
    const started = Date.now();
    const got = await pollUntil(never, 300, 50);
    const elapsed = Date.now() - started;
    expect(got).toBe(false);
    expect(elapsed, `returned after ${elapsed}ms`).toBeLessThan(3000);
  });

  test("a probe slower than the whole timeout does not extend it", async () => {
    const slow = () => new Promise<boolean>((r) => setTimeout(() => r(true), 5000));
    const started = Date.now();
    expect(await pollUntil(slow, 250, 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("one hung probe does not poison a later true", async () => {
    // First call hangs, second would answer true — but the first must not
    // consume the entire budget silently.
    let n = 0;
    const flaky = () => (++n === 1 ? never() : Promise.resolve(true));
    const started = Date.now();
    const got = await pollUntil(flaky, 1500, 30);
    expect(got).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("normal behaviour is unchanged", () => {
  test("an immediately-true probe returns true fast", async () => {
    const started = Date.now();
    expect(await pollUntil(async () => true, 5000, 50)).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("a probe that becomes true partway is caught", async () => {
    const at = Date.now() + 200;
    expect(await pollUntil(async () => Date.now() >= at, 5000, 25)).toBe(true);
  });

  test("an always-false probe returns false at the deadline", async () => {
    const started = Date.now();
    expect(await pollUntil(async () => false, 300, 40)).toBe(false);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2000);
  });

  test("a throwing probe counts as false rather than escaping", async () => {
    expect(await pollUntil(async () => { throw new Error("boom"); }, 200, 40)).toBe(false);
  });

  test("a zero timeout returns immediately without probing", async () => {
    let calls = 0;
    expect(await pollUntil(async () => { calls++; return true; }, 0, 10)).toBe(false);
    expect(calls).toBe(0);
  });
});
