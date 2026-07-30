/**
 * Encoder Delay-Ceiling Tests
 *
 * These run the REAL encoder, not the timing maths, because the bug they guard
 * lived exactly at that boundary: `delaysFromTimestamps` produced a value the
 * pure tests accepted and sharp rejected outright, killing the GIF for a
 * capture whose frames and manifest were otherwise fine.
 *
 * Production failure being guarded (2026-07-19, daemon capture "f12"):
 *   ✗ gif: gif encode failed: Expected integer or an array of integers between
 *     0 and 65535 for delay but received 140,70,33,...,166768 of type object
 */

import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { encodeGif } from "../src/recording/encoders.js";
import {
  delaysFromTimestamps,
  expandForPlayback,
  MAX_DELAY_MS,
} from "../src/recording/timing.js";

const workDir = mkdtempSync(join(tmpdir(), "cbrowser-encoder-delays-"));

/** Six frames over 2.5s, then the page goes quiet for the rest of 5 minutes. */
const FRAME_COUNT = 6;
const TOTAL_MS = 300_000;
const LAST_FRAME_AT = 2_500;
const tMs = Array.from({ length: FRAME_COUNT }, (_, i) =>
  Math.round((i * LAST_FRAME_AT) / (FRAME_COUNT - 1)),
);
let frames: string[] = [];

beforeAll(async () => {
  frames = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const path = join(workDir, `f${i}.jpg`);
    await sharp({
      create: { width: 200, height: 120, channels: 3, background: { r: 20 + i * 35, g: 60, b: 150 } },
    })
      .jpeg()
      .toFile(path);
    frames.push(path);
  }
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("GIF delay ceiling at the encoder boundary", () => {
  test("a long quiet tail encodes instead of failing the whole GIF", async () => {
    const delays = delaysFromTimestamps(tMs, TOTAL_MS);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_DELAY_MS);

    const out = join(workDir, "capped.gif");
    // Before the ceiling was added this threw and produced no artifact at all.
    const result = await encodeGif(frames, delays, out, {});
    expect(statSync(result.path).size).toBeGreaterThan(0);
    expect((await sharp(out, { animated: true }).metadata()).format).toBe("gif");
  }, 60000);

  test("expandForPlayback preserves real playback time; capping alone truncates it", async () => {
    const cappedOut = join(workDir, "capped-timeline.gif");
    await encodeGif(frames, delaysFromTimestamps(tMs, TOTAL_MS), cappedOut, {});
    const capped = await sharp(cappedOut, { animated: true }).metadata();
    const cappedTotal = (capped.delay ?? []).reduce((a, b) => a + b, 0);

    const expanded = expandForPlayback(frames, tMs, TOTAL_MS);
    const expandedOut = join(workDir, "expanded-timeline.gif");
    await encodeGif(expanded.items, expanded.delays, expandedOut, {});
    const meta = await sharp(expandedOut, { animated: true }).metadata();
    const expandedTotal = (meta.delay ?? []).reduce((a, b) => a + b, 0);

    // Capping alone shortens a 5-minute recording to ~68s of playback.
    expect(cappedTotal).toBeLessThan(TOTAL_MS / 2);

    // The expansion holds the last frame for its real duration. libvips merges
    // the identical repeats back into one page and SUMS their delays, which is
    // legal: the GIF field is centiseconds, so 297_500ms fits even though no
    // single value handed to sharp exceeded 65535.
    expect(expandedTotal).toBeCloseTo(TOTAL_MS, -2);
    expect(Math.max(...expanded.delays)).toBeLessThanOrEqual(MAX_DELAY_MS);
  }, 60000);

  test("every delay handed to sharp is inside its accepted range", async () => {
    // Sharp's validation is on the raw values it receives, so this is the exact
    // precondition that failed in production.
    const expanded = expandForPlayback(frames, tMs, TOTAL_MS);
    for (const d of expanded.delays) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(65535);
    }
    for (const d of delaysFromTimestamps(tMs, TOTAL_MS)) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(65535);
    }
  });
});
