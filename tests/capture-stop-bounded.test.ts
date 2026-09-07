/**
 * A capture stop must be bounded wherever it is called.
 *
 * `stopWithinTimeout` was private, so tests/recording-change-tiers.test.ts
 * called `session.stop()` raw. When that stop wedged on CI the test burned its
 * whole 180000ms ceiling and reported "timed out after 180000ms" — no state, no
 * frame count, no slug. Twice in a row, with identical timings.
 *
 * The suite already asserted a wedged stop must fail fast (recording-autocapture,
 * "a wedged stop fails fast and loudly"). That guarantee just lived one layer up
 * from the caller that needed it. This file pins the bound at the level it is
 * now shared from, so the next caller inherits it instead of rediscovering the
 * 180-second version.
 *
 * Pure: no browser, so it can live in the normal pass rather than the isolated
 * set.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */
import { describe, test, expect } from "bun:test";
import { stopWithinTimeout } from "../src/recording/auto-capture.js";

/** A session whose stop() never settles — the exact CI failure mode. */
const wedged = () => ({
  stop: () => new Promise(() => { /* never resolves */ }),
  status: () => ({
    state: "recording" as const,
    slug: "wedged",
    outDir: "/tmp/wedged",
    frames: 42,
    elapsedMs: 5000,
    captureMethod: "cdp-screencast" as const,
  }),
});

describe("stopWithinTimeout", () => {
  test("a wedged stop throws quickly instead of hanging", async () => {
    const started = Date.now();
    await expect(stopWithinTimeout(wedged() as never, 150)).rejects.toThrow(/timed out after 150ms/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("the error carries the state needed to act on it", async () => {
    // "timed out after 180000ms" alone is what CI reported for two runs and it
    // said nothing about where the capture was stuck.
    const err = await stopWithinTimeout(wedged() as never, 100).catch((e) => e as Error);
    expect(err.message).toMatch(/state=recording/);
    expect(err.message).toMatch(/frames=42/);
    expect(err.message).toContain("/tmp/wedged");
  });

  test("a stop that settles in time is returned untouched", async () => {
    const ok = { stop: async () => ({ manifest: { slug: "fine" } }), status: () => ({}) };
    const out = await stopWithinTimeout(ok as never, 5000);
    expect((out as { manifest: { slug: string } }).manifest.slug).toBe("fine");
  });

  test("a slow-but-finishing stop is not cut off early", async () => {
    const slow = {
      stop: async () => { await new Promise((r) => setTimeout(r, 120)); return { manifest: { slug: "slow" } }; },
      status: () => ({}),
    };
    expect((await stopWithinTimeout(slow as never, 4000) as { manifest: { slug: string } }).manifest.slug)
      .toBe("slow");
  });
});

describe("the change-tiers helper uses the bound", () => {
  test("it does not call session.stop() raw", async () => {
    // The regression this exists to prevent: reverting to a raw stop restores
    // the 180-second silent hang.
    const src = await Bun.file(
      new URL("./recording-change-tiers.test.ts", import.meta.url),
    ).text();
    expect(src).toContain("stopWithinTimeout(session");
    expect(src).not.toMatch(/await session\.stop\(\)/);
  });
});
