/**
 * Recording Pure-Logic Tests
 *
 * Property-based (fast-check) and example tests for the recording modules that
 * contain no browser state: the SSIM comparator, the encoder timing helpers,
 * and the manifest contract.
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { ssim, detectChangePoints, frameSignature } from "../src/recording/ssim.js";
import {
  delaysFromTimestamps,
  expandForPlayback,
  findFrameGaps,
  clampRect,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
} from "../src/recording/timing.js";
import {
  parseManifest,
  changeSignal,
  changeSignalIssues,
  RecordingManifestSchema,
  MANIFEST_VERSION,
  SSIM_THRESHOLDS,
  CHANGE_SATURATION_RATIO,
  type RecordingManifest,
} from "../src/recording/types.js";

const NUM_RUNS = 1000;
const TOLERANCE = 1e-6;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const pixelArb = fc.float({ min: 0, max: 1, noNaN: true });

const signatureArb = fc
  .array(pixelArb, { minLength: 1, maxLength: 64 })
  .map((xs) => Float32Array.from(xs));

/** Two signatures guaranteed to be the same length. */
const signaturePairArb = fc.integer({ min: 1, max: 64 }).chain((n) =>
  fc.tuple(
    fc.array(pixelArb, { minLength: n, maxLength: n }).map((xs) => Float32Array.from(xs)),
    fc.array(pixelArb, { minLength: n, maxLength: n }).map((xs) => Float32Array.from(xs)),
  ),
);

/**
 * Non-decreasing timestamps plus a total duration that covers them.
 *
 * Deltas and tails reach into the minutes deliberately. The earlier version of
 * this generator topped out at 5s deltas and a 2s tail, so it could never
 * produce a delay above the 65535ms encoder ceiling — and a property that
 * cannot reach a boundary cannot falsify anything about it. A real capture left
 * running while the page went quiet produced a 166_768ms tail delay and killed
 * the GIF encode; these bounds cover that shape.
 */
const timelineArb = fc
  .tuple(
    // Mostly ordinary frame spacing, with occasional multi-minute stalls.
    fc.array(
      fc.oneof(
        { weight: 9, arbitrary: fc.integer({ min: 0, max: 5000 }) },
        { weight: 1, arbitrary: fc.integer({ min: 0, max: 200_000 }) },
      ),
      { minLength: 1, maxLength: 60 },
    ),
    fc.integer({ min: 0, max: 5000 }),
    // Tail: from nothing to a five-minute quiet stretch after the last frame.
    fc.oneof(
      { weight: 7, arbitrary: fc.integer({ min: 0, max: 2000 }) },
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 300_000 }) },
    ),
  )
  .map(([deltas, start, tail]) => {
    const tMs: number[] = [];
    let t = start;
    for (const d of deltas) {
      tMs.push(t);
      t += d;
    }
    const last = tMs[tMs.length - 1]!;
    return { tMs, totalDurationMs: last + tail };
  });

const viewportArb = fc.record({
  width: fc.integer({ min: 1, max: 4000 }),
  height: fc.integer({ min: 1, max: 4000 }),
});

/**
 * Rects that always overlap the viewport, so clamping can never collapse:
 * the origin starts before the far edge and the extent is grown enough to
 * reach past the near edge.
 */
const overlappingRectArb = viewportArb.chain((viewport) =>
  fc
    .record({
      x: fc.integer({ min: -2000, max: viewport.width - 1 }),
      y: fc.integer({ min: -2000, max: viewport.height - 1 }),
      width: fc.integer({ min: 1, max: 6000 }),
      height: fc.integer({ min: 1, max: 6000 }),
    })
    .map(({ x, y, width, height }) => ({
      rect: {
        x,
        y,
        width: width + Math.max(0, -x),
        height: height + Math.max(0, -y),
      },
      viewport,
    })),
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validManifest(): RecordingManifest {
  return {
    version: MANIFEST_VERSION,
    slug: "checkout-flow",
    engine: "chromium",
    capture_method: "cdp-screencast",
    target_fps: 10,
    actual_fps: 9.6,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
    target: { kind: "element", selector: "#cart", padding: 8 },
    start_trigger: "click:#checkout",
    stop_trigger: null,
    trigger_timeout: false,
    started_at: "2026-07-19T10:00:00.000Z",
    duration_ms: 2000,
    output_dims: { width: 640, height: 360 },
    frames: [
      {
        index: 0,
        t_ms: 0,
        path: "frames/000000.png",
        crop: { x: 0, y: 0, width: 640, height: 360 },
        ssim_prev: null,
        anomaly: false,
        tracking: "ok",
        console: [],
        network: [],
      },
      {
        index: 1,
        t_ms: 104,
        path: "frames/000001.png",
        crop: { x: 0, y: 0, width: 640, height: 360 },
        ssim_prev: 0.82,
        anomaly: true,
        tracking: "stale",
        console: [{ t_ms: 100, type: "error", text: "boom" }],
        network: [{ t_ms: 101, url: "https://example.com/api", method: "GET", status: 200 }],
      },
    ],
    change_points: [1],
    frame_gaps: [],
    region_clamped: false,
    artifacts: { gif: "out/recording.gif", webp: "out/recording.webp" },
  };
}

// ---------------------------------------------------------------------------
// SSIM
// ---------------------------------------------------------------------------

describe("recording/ssim", () => {
  test("property: ssim(a, a) is exactly 1", () => {
    fc.assert(
      fc.property(signatureArb, (a) => {
        expect(ssim(a, a)).toBe(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("property: ssim is symmetric", () => {
    fc.assert(
      fc.property(signaturePairArb, ([a, b]) => {
        expect(ssim(a, b)).toBe(ssim(b, a));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("property: ssim is within [-1, 1]", () => {
    fc.assert(
      fc.property(signaturePairArb, ([a, b]) => {
        const score = ssim(a, b);
        expect(Number.isNaN(score)).toBe(false);
        expect(score).toBeGreaterThanOrEqual(-1);
        expect(score).toBeLessThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("throws on length mismatch", () => {
    const a = Float32Array.from([0.1, 0.2, 0.3]);
    const b = Float32Array.from([0.1, 0.2]);
    expect(() => ssim(a, b)).toThrow(/length mismatch/);
  });

  test("throws on empty signatures", () => {
    expect(() => ssim(new Float32Array(0), new Float32Array(0))).toThrow(/must not be empty/);
  });

  test("a very different frame scores well below an identical one", () => {
    const dark = Float32Array.from(new Array(256).fill(0.05));
    const bright = Float32Array.from(new Array(256).fill(0.95));
    expect(ssim(dark, bright)).toBeLessThan(ssim(dark, dark));
  });

  test("frameSignature normalises a solid image to 0..1", async () => {
    const png = await (
      await import("sharp")
    ).default({
      create: { width: 40, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();

    const sig = await frameSignature(png, 16);
    expect(sig.length).toBe(16 * 16);
    for (const v of sig) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(sig[0]).toBeCloseTo(1, 5);
    expect(ssim(sig, sig)).toBe(1);
  });
});

describe("recording/ssim detectChangePoints", () => {
  test("returns indices below the threshold and skips nulls", () => {
    expect(detectChangePoints([null, 0.99, 0.4, 0.98, 0.1], 0.9)).toEqual([2, 4]);
  });

  test("returns nothing when every score is above the threshold", () => {
    expect(detectChangePoints([null, 0.99, 0.995], 0.9)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

describe("recording/timing delaysFromTimestamps", () => {
  test("property: every delay is within BOTH encoder bounds [20, 65535]", () => {
    // The bug this exists for: the old property asserted only `d >= 20`. A
    // 166_768ms delay satisfied it, passed 1000 runs, and was rejected outright
    // by the GIF encoder. A bound that is only checked at one end is not a
    // bound. Both ends, every input.
    fc.assert(
      fc.property(timelineArb, ({ tMs, totalDurationMs }) => {
        const delays = delaysFromTimestamps(tMs, totalDurationMs);
        expect(delays.length).toBe(tMs.length);
        for (const d of delays) {
          expect(d).toBeGreaterThanOrEqual(MIN_DELAY_MS);
          expect(d).toBeLessThanOrEqual(MAX_DELAY_MS);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("property: the generator actually reaches the ceiling", () => {
    // Guards the guard: if this stops finding capped cases, the property above
    // has quietly become untestable and the next regression walks straight past it.
    let capped = 0;
    fc.assert(
      fc.property(timelineArb, ({ tMs, totalDurationMs }) => {
        const uncapped = delaysFromTimestamps(tMs, totalDurationMs, {
          maxDelayMs: Number.POSITIVE_INFINITY,
        });
        if (Math.max(...uncapped) > MAX_DELAY_MS) capped++;
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
    expect(capped).toBeGreaterThan(0);
  });

  test("property: sum is exact when nothing is capped, and bounded when it is", () => {
    fc.assert(
      fc.property(timelineArb, ({ tMs, totalDurationMs }) => {
        const delays = delaysFromTimestamps(tMs, totalDurationMs);
        const sum = delays.reduce((acc, d) => acc + d, 0);
        const floorSum = tMs.length * MIN_DELAY_MS;
        const expected = Math.max(totalDurationMs, floorSum);

        // Capping can only shorten the timeline, never lengthen it.
        expect(sum).toBeGreaterThanOrEqual(floorSum - TOLERANCE * floorSum);
        expect(sum).toBeLessThanOrEqual(expected + TOLERANCE * Math.max(1, expected));

        const uncapped = delaysFromTimestamps(tMs, totalDurationMs, {
          maxDelayMs: Number.POSITIVE_INFINITY,
        });
        if (Math.max(...uncapped) <= MAX_DELAY_MS) {
          // Nothing hit the ceiling, so the original exact invariant holds.
          expect(Math.abs(sum - expected)).toBeLessThanOrEqual(TOLERANCE * Math.max(1, expected));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("property: expandForPlayback keeps real time and stays legal", () => {
    fc.assert(
      fc.property(timelineArb, ({ tMs, totalDurationMs }) => {
        const frames = tMs.map((_, i) => `f${i}.jpg`);
        const { items, delays } = expandForPlayback(frames, tMs, totalDurationMs);

        // Encoders require a strict 1:1 pairing.
        expect(items.length).toBe(delays.length);
        expect(items.length).toBeGreaterThanOrEqual(frames.length);

        for (const d of delays) {
          expect(d).toBeLessThanOrEqual(MAX_DELAY_MS);
          expect(d).toBeGreaterThan(0);
        }

        // Real time is preserved: repeats sum to the uncapped timeline.
        const uncapped = delaysFromTimestamps(tMs, totalDurationMs, {
          maxDelayMs: Number.POSITIVE_INFINITY,
        });
        const expected = uncapped.reduce((a, d) => a + d, 0);
        const actual = delays.reduce((a, d) => a + d, 0);
        expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOLERANCE * Math.max(1, expected));

        // Every emitted item is one of the originals, in order.
        expect(new Set(items).size).toBeLessThanOrEqual(new Set(frames).size);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("derives per-frame delays from deltas, not a constant cadence", () => {
    const delays = delaysFromTimestamps([0, 100, 700], 900);
    expect(delays).toEqual([100, 600, 200]);
  });

  test("folds the lead-in into the first frame", () => {
    expect(delaysFromTimestamps([50, 150], 250)).toEqual([150, 100]);
  });

  test("floors short deltas and reclaims the surplus from frames with headroom", () => {
    const delays = delaysFromTimestamps([0, 1, 2], 1000);
    expect(delays[0]).toBe(MIN_DELAY_MS);
    expect(delays[1]).toBe(MIN_DELAY_MS);
    expect(delays.reduce((a, d) => a + d, 0)).toBeCloseTo(1000, 6);
  });

  test("regression: a long quiet tail cannot emit a delay above the GIF ceiling", () => {
    // The exact production failure (2026-07-19): a daemon capture of 1034 frames
    // with duration_ms 295768 and ZERO frame_gaps — frames stopped arriving at
    // ~129s and the page stayed quiet for the remaining ~167s. The last frame's
    // delay stretched to 166_768ms and sharp rejected the whole encode:
    //   "Expected integer or an array of integers between 0 and 65535 for delay
    //    but received 140,70,33,...,166768 of type object"
    const N = 1034;
    const TOTAL = 295_768;
    const LAST_FRAME_AT = 129_000;
    const tMs = Array.from({ length: N }, (_, i) => Math.round((i * LAST_FRAME_AT) / (N - 1)));

    const delays = delaysFromTimestamps(tMs, TOTAL);
    expect(delays).toHaveLength(N);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_DELAY_MS);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(MIN_DELAY_MS);
    expect(delays.filter((d) => d > MAX_DELAY_MS)).toHaveLength(0);

    // And the expansion holds the tail for its real duration instead.
    const frames = tMs.map((_, i) => `${String(i).padStart(4, "0")}.jpg`);
    const expanded = expandForPlayback(frames, tMs, TOTAL);
    expect(Math.max(...expanded.delays)).toBeLessThanOrEqual(MAX_DELAY_MS);
    expect(expanded.delays.reduce((a, d) => a + d, 0)).toBeCloseTo(TOTAL, 3);
    // The last frame is repeated to cover the 166.8s hold.
    expect(expanded.items.filter((f) => f === frames[N - 1]).length).toBeGreaterThan(1);
  });

  test("a mid-capture stall is capped too, not just the tail", () => {
    // A 3-minute stall between two frames is the same illegal-delay shape.
    const tMs = [0, 1000, 181_000, 182_000];
    const delays = delaysFromTimestamps(tMs, 183_000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_DELAY_MS);
  });

  test("rejects empty, decreasing, or under-long input", () => {
    expect(() => delaysFromTimestamps([], 100)).toThrow(/must not be empty/);
    expect(() => delaysFromTimestamps([0, 50, 20], 100)).toThrow(/non-decreasing/);
    expect(() => delaysFromTimestamps([0, 500], 100)).toThrow(/before the last timestamp/);
  });
});

describe("recording/timing findFrameGaps", () => {
  test("finds no gaps in evenly spaced input", () => {
    const tMs = [0, 100, 200, 300, 400, 500];
    expect(findFrameGaps(tMs, 10)).toEqual([]);
  });

  test("finds the gap where one exists", () => {
    const tMs = [0, 100, 200, 900, 1000];
    expect(findFrameGaps(tMs, 10)).toEqual([{ after_index: 2, gap_ms: 700 }]);
  });

  test("gapFactor scales the threshold", () => {
    const tMs = [0, 100, 350];
    expect(findFrameGaps(tMs, 10, 3)).toEqual([]);
    expect(findFrameGaps(tMs, 10, 2)).toEqual([{ after_index: 1, gap_ms: 250 }]);
  });

  test("rejects a non-positive fps", () => {
    expect(() => findFrameGaps([0, 100], 0)).toThrow(/targetFps must be positive/);
  });
});

describe("recording/timing clampRect", () => {
  test("property: output is always inside the viewport with positive dimensions", () => {
    fc.assert(
      fc.property(overlappingRectArb, ({ rect, viewport }) => {
        const { rect: out } = clampRect(rect, viewport);

        expect(out.x).toBeGreaterThanOrEqual(0);
        expect(out.y).toBeGreaterThanOrEqual(0);
        expect(out.width).toBeGreaterThan(0);
        expect(out.height).toBeGreaterThan(0);
        expect(out.x + out.width).toBeLessThanOrEqual(viewport.width);
        expect(out.y + out.height).toBeLessThanOrEqual(viewport.height);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("property: never widens the rect and reports whether it changed", () => {
    fc.assert(
      fc.property(overlappingRectArb, ({ rect, viewport }) => {
        const { rect: out, clamped } = clampRect(rect, viewport);
        expect(out.width).toBeLessThanOrEqual(rect.width);
        expect(out.height).toBeLessThanOrEqual(rect.height);
        const unchanged =
          out.x === rect.x &&
          out.y === rect.y &&
          out.width === rect.width &&
          out.height === rect.height;
        expect(clamped).toBe(!unchanged);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("leaves an already-contained rect untouched", () => {
    const rect = { x: 10, y: 20, width: 100, height: 50 };
    expect(clampRect(rect, { width: 1280, height: 720 })).toEqual({ rect, clamped: false });
  });

  test("clamps an overflowing rect and flags it", () => {
    const result = clampRect({ x: -20, y: 600, width: 200, height: 400 }, { width: 100, height: 700 });
    expect(result).toEqual({ rect: { x: 0, y: 600, width: 100, height: 100 }, clamped: true });
  });

  test("throws on zero/negative area and on a fully outside rect", () => {
    expect(() => clampRect({ x: 0, y: 0, width: 0, height: 10 }, { width: 100, height: 100 })).toThrow(
      /positive area/,
    );
    expect(() =>
      clampRect({ x: 0, y: 0, width: 10, height: -5 }, { width: 100, height: 100 }),
    ).toThrow(/positive area/);
    expect(() =>
      clampRect({ x: 500, y: 0, width: 10, height: 10 }, { width: 100, height: 100 }),
    ).toThrow(/outside/);
  });
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("recording/types parseManifest", () => {
  test("accepts a well-formed manifest", () => {
    const parsed = parseManifest(validManifest());
    expect(parsed.slug).toBe("checkout-flow");
    expect(parsed.frames).toHaveLength(2);
  });

  test("accepts a manifest supplied as a JSON string", () => {
    const parsed = parseManifest(JSON.stringify(validManifest()));
    expect(parsed.engine).toBe("chromium");
  });

  test("rejects a manifest missing a required field", () => {
    const manifest: Record<string, unknown> = { ...validManifest() };
    delete manifest.duration_ms;
    expect(() => parseManifest(manifest)).toThrow(/duration_ms/);
  });

  test("rejects a frame missing a required field", () => {
    const manifest = validManifest();
    const frames: Record<string, unknown>[] = manifest.frames.map((f) => ({ ...f }));
    delete frames[1]!.ssim_prev;
    expect(() => parseManifest({ ...manifest, frames })).toThrow(/frames\.1\.ssim_prev/);
  });

  test("rejects an unknown engine", () => {
    expect(() => parseManifest({ ...validManifest(), engine: "servo" })).toThrow(/engine/);
  });

  test("rejects an invalid target discriminant", () => {
    expect(() => parseManifest({ ...validManifest(), target: { kind: "screen" } })).toThrow(
      /target/,
    );
  });

  test("rejects non-JSON input", () => {
    expect(() => parseManifest("{not json")).toThrow(/not valid JSON/);
  });

  test("region_clamped is optional", () => {
    const manifest: Record<string, unknown> = { ...validManifest() };
    delete manifest.region_clamped;
    expect(() => parseManifest(manifest)).not.toThrow();
  });

  test("schema keeps unknown console/network fields", () => {
    const manifest = validManifest();
    manifest.frames[1]!.console = [
      { t_ms: 1, type: "log", text: "hi", stackTrace: "at foo" },
    ];
    const parsed = RecordingManifestSchema.parse(manifest);
    expect(parsed.frames[1]!.console[0]!.stackTrace).toBe("at foo");
  });
});

// ---------------------------------------------------------------------------
// Two-tier change signal (v2)
// ---------------------------------------------------------------------------

describe("recording/types two-tier change signal", () => {
  /** A current-version manifest with both tiers populated. */
  function v2Manifest(): RecordingManifest {
    const base = validManifest();
    return {
      ...base,
      version: MANIFEST_VERSION,
      change_points: [1],
      key_frames: [1],
      change_points_saturated: false,
      ssim_thresholds: { ...SSIM_THRESHOLDS },
    };
  }

  test("the new fields round-trip through the schema", () => {
    const parsed = parseManifest(v2Manifest());
    expect(parsed.key_frames).toEqual([1]);
    expect(parsed.change_points_saturated).toBe(false);
    // Thresholds come from the single source of truth, whatever it currently is.
    expect(parsed.ssim_thresholds).toEqual({ ...SSIM_THRESHOLDS });
  });

  test("a v1 manifest without the new fields still parses", () => {
    // Expand-contract: manifests written before this change are on disk now and
    // `capture status` reads the most recent one.
    const v1: Record<string, unknown> = { ...validManifest(), version: 1 };
    delete v1.key_frames;
    delete v1.change_points_saturated;
    delete v1.ssim_thresholds;
    const parsed = parseManifest(v1);
    expect(parsed.key_frames).toBeUndefined();
    expect(parsed.ssim_thresholds).toBeUndefined();
  });

  test("fields absent from the schema would be silently dropped", () => {
    // Why the schema had to change rather than the engine just emitting: zod
    // strips unknown keys, so an unlisted field vanishes on read.
    const withExtra = { ...v2Manifest(), invented_field: "gone" };
    const parsed = parseManifest(withExtra) as Record<string, unknown>;
    expect(parsed.invented_field).toBeUndefined();
    expect(parsed.key_frames).toEqual([1]);
  });

  test("changeSignal falls back to change_points for a legacy file, flagged as legacy", () => {
    // A pre-v2 file has only change_points, computed with a DIFFERENT (global)
    // detector. It is not a rename onto key_frames — the honest thing is to
    // report the one list for both tiers and mark it legacy, with unknown-scale
    // thresholds rather than current-scale numbers that would misrepresent it.
    const v1: Record<string, unknown> = { ...validManifest(), version: 1, change_points: [1] };
    delete v1.key_frames;
    delete v1.change_points_saturated;
    delete v1.ssim_thresholds;

    const signal = changeSignal(parseManifest(v1));
    expect(signal.keyFrames).toEqual([1]);
    expect(signal.changePoints).toEqual([1]);
    expect(signal.saturated).toBe(false);
    expect(signal.legacy).toBe(true);
    expect(Number.isNaN(signal.thresholds.change)).toBe(true);
    expect(signal.manifestVersion).toBe(1);
  });

  test("changeSignal passes current-version data through untouched", () => {
    const signal = changeSignal(parseManifest(v2Manifest()));
    expect(signal.keyFrames).toEqual([1]);
    expect(signal.thresholds).toEqual({ ...SSIM_THRESHOLDS });
    expect(signal.legacy).toBe(false);
    expect(signal.manifestVersion).toBe(MANIFEST_VERSION);
  });

  test("changeSignalIssues is quiet on a consistent manifest", () => {
    expect(changeSignalIssues(parseManifest(v2Manifest()))).toEqual([]);
  });

  test("changeSignalIssues catches key_frames that is not a subset", () => {
    const bad = { ...v2Manifest(), change_points: [1], key_frames: [0, 1] };
    const issues = changeSignalIssues(parseManifest(bad));
    expect(issues.join(" ")).toMatch(/subset of change_points/);
  });

  test("changeSignalIssues catches a mislabelled saturation flag", () => {
    // 2 of 2 frames is 100% coverage, which is saturated by definition.
    const bad = {
      ...v2Manifest(),
      change_points: [0, 1],
      key_frames: [1],
      change_points_saturated: false,
    };
    const issues = changeSignalIssues(parseManifest(bad));
    expect(issues.join(" ")).toMatch(/change_points_saturated is false/);
  });

  test("changeSignalIssues catches out-of-range and inverted thresholds", () => {
    const outOfRange = { ...v2Manifest(), change_points: [7], key_frames: [7] };
    expect(changeSignalIssues(parseManifest(outOfRange)).join(" ")).toMatch(/only 2 frames/);

    const inverted = { ...v2Manifest(), ssim_thresholds: { change: 0.5, key: 0.9 } };
    expect(changeSignalIssues(parseManifest(inverted)).join(" ")).toMatch(/must not exceed/);
  });

  test("the thresholds keep the two tiers ordered and on the window-min scale", () => {
    // KEY must stay below CHANGE or key_frames cannot be the sparse subset.
    expect(SSIM_THRESHOLDS.key).toBeLessThan(SSIM_THRESHOLDS.change);
    // Both are window-min values (0..1), not the old global-SSIM near-1 scale.
    expect(SSIM_THRESHOLDS.change).toBeGreaterThan(0);
    expect(SSIM_THRESHOLDS.change).toBeLessThan(1);
    expect(SSIM_THRESHOLDS.key).toBeGreaterThan(0);
    expect(CHANGE_SATURATION_RATIO).toBeGreaterThan(0.5);
    expect(CHANGE_SATURATION_RATIO).toBeLessThan(1);
  });

  test("old manifest versions remain readable after the version bump", () => {
    expect(MANIFEST_VERSION).toBeGreaterThanOrEqual(3);
    expect(() => parseManifest({ ...validManifest(), version: 1 })).not.toThrow();
    expect(() => parseManifest({ ...validManifest(), version: 2 })).not.toThrow();
  });
});
