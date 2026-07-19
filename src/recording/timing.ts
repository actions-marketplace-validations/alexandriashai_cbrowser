/**
 * CBrowser - Cognitive Browser Automation
 * Copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com
 * Learn more at https://cbrowser.ai - MIT License
 */

/**
 * Pure timing helpers shared by the recording encoders.
 *
 * Capture is never perfectly cadenced — the browser drops screencast frames
 * under load — so playback timing is derived from the recorded timestamps
 * rather than from a constant `1000 / fps` cadence. These helpers own that
 * derivation and the clamping rules the GIF/WebP containers impose.
 */

import type { Rect, Viewport } from "./types.js";

/**
 * Minimum per-frame delay. GIF and WebP treat sub-20ms delays inconsistently
 * (many decoders silently substitute 100ms), so delays are floored here.
 */
export const MIN_DELAY_MS = 20;

/**
 * Maximum per-frame delay.
 *
 Sharp validates each delay against 0..65535 and rejects the whole encode
 * otherwise: "Expected integer or an array of integers between 0 and 65535 for
 * delay". A capture left running while the page goes quiet produces exactly
 * that: the last frame's delay stretches to cover the silent tail, and one
 * out-of-range value destroys the artifact.
 *
 * Note this is sharp's API limit, not the format's. GIF stores delay as a
 * uint16 of CENTIseconds, so a single frame can legally be held for up to
 * 655_350ms — ten times what sharp will accept in one value. That gap is what
 * {@link expandForPlayback} exploits: libvips merges identical consecutive
 * frames and SUMS their delays, so N legal repeats collapse back into one page
 * holding for their combined duration. Verified end-to-end in
 * tests/recording-encoder-delays.test.ts.
 *
 * Emitting an illegal delay is therefore not a caller error to validate — it is
 * this function's job to make impossible. See {@link expandForPlayback} for
 * holding a frame longer than this ceiling without lying about the timing.
 */
export const MAX_DELAY_MS = 65535;

/** Tolerance for float comparisons on millisecond sums. */
const EPS = 1e-9;

/**
 * Per-frame display delay in milliseconds, derived from consecutive timestamps.
 *
 * Frame `i` is displayed for `tMs[i + 1] - tMs[i]`; the last frame is displayed
 * until `totalDurationMs`. Any lead-in before the first frame (`tMs[0] > 0`) is
 * folded into frame 0's delay, so the delays describe the whole recording.
 *
 * Clamp behaviour, applied in this order:
 *
 *  1. FLOOR at {@link MIN_DELAY_MS}. When the floor inflates the total, the
 *     surplus is reclaimed from the frames that have headroom above it,
 *     proportionally to how much headroom each has, so the sum stays exactly
 *     `totalDurationMs` and no frame is singled out. If the recording is too
 *     short for every frame to hold the floor
 *     (`frames * MIN_DELAY_MS > totalDurationMs`), the floor wins and the sum is
 *     `frames * MIN_DELAY_MS` — the animation is then longer than the capture,
 *     which is the only way to keep all frames visible.
 *  2. CEILING at {@link MAX_DELAY_MS}, last, so the reclaim cannot push a delay
 *     back over it. A capped delay means the returned timeline is SHORTER than
 *     `totalDurationMs`: a frame held past the ceiling cannot be expressed as a
 *     single delay. That truncation is the safe failure — the alternative is an
 *     encode that dies and takes the whole artifact with it. To keep real-time
 *     playback across a long hold, use {@link expandForPlayback}, which repeats
 *     the held frame instead of truncating it.
 *
 * Resulting guarantee: every returned delay is within
 * `[MIN_DELAY_MS, MAX_DELAY_MS]`, for every input this function accepts.
 *
 * @throws if `tMs` is empty, contains negative or decreasing values, or if
 *         `totalDurationMs` is shorter than the last timestamp.
 */
export function delaysFromTimestamps(
  tMs: number[],
  totalDurationMs: number,
  options: { maxDelayMs?: number } = {},
): number[] {
  if (tMs.length === 0) {
    throw new Error("delaysFromTimestamps: timestamps must not be empty");
  }
  if (!Number.isFinite(totalDurationMs) || totalDurationMs < 0) {
    throw new Error(
      `delaysFromTimestamps: totalDurationMs must be a non-negative finite number, got ${totalDurationMs}`,
    );
  }
  for (let i = 0; i < tMs.length; i++) {
    const t = tMs[i]!;
    if (!Number.isFinite(t) || t < 0) {
      throw new Error(`delaysFromTimestamps: timestamp ${i} is not a non-negative finite number`);
    }
    if (i > 0 && t < tMs[i - 1]!) {
      throw new Error(
        `delaysFromTimestamps: timestamps must be non-decreasing (index ${i}: ${tMs[i - 1]} -> ${t})`,
      );
    }
  }
  const last = tMs[tMs.length - 1]!;
  if (totalDurationMs + EPS < last) {
    throw new Error(
      `delaysFromTimestamps: totalDurationMs (${totalDurationMs}) is before the last timestamp (${last})`,
    );
  }

  const n = tMs.length;
  const delays = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const end = i === n - 1 ? totalDurationMs : tMs[i + 1]!;
    delays[i] = end - tMs[i]!;
  }
  // Fold the lead-in so the delays cover [0, totalDurationMs].
  delays[0] = delays[0]! + tMs[0]!;

  let total = 0;
  let headroom = 0;
  for (let i = 0; i < n; i++) {
    if (delays[i]! < MIN_DELAY_MS) delays[i] = MIN_DELAY_MS;
    total += delays[i]!;
    headroom += delays[i]! - MIN_DELAY_MS;
  }

  const maxDelayMs = options.maxDelayMs ?? MAX_DELAY_MS;
  if (maxDelayMs < MIN_DELAY_MS) {
    throw new Error(
      `delaysFromTimestamps: maxDelayMs (${maxDelayMs}) is below MIN_DELAY_MS (${MIN_DELAY_MS})`,
    );
  }

  let surplus = total - totalDurationMs;
  if (surplus <= EPS || headroom <= 0) return applyCeiling(delays, maxDelayMs);

  // Proportional reclaim: cannot push any frame below the floor because each
  // frame gives up at most its own share of the available headroom.
  const take = Math.min(surplus, headroom);
  for (let i = 0; i < n; i++) {
    const room = delays[i]! - MIN_DELAY_MS;
    if (room <= 0) continue;
    delays[i] = delays[i]! - (room / headroom) * take;
    if (delays[i]! < MIN_DELAY_MS) delays[i] = MIN_DELAY_MS;
  }

  // Second pass absorbs float drift from the proportional split.
  let achieved = 0;
  for (let i = 0; i < n; i++) achieved += delays[i]!;
  surplus = achieved - totalDurationMs;
  for (let i = 0; i < n && surplus > EPS; i++) {
    const room = delays[i]! - MIN_DELAY_MS;
    if (room <= 0) continue;
    const shave = Math.min(room, surplus);
    delays[i] = delays[i]! - shave;
    surplus -= shave;
  }

  return applyCeiling(delays, maxDelayMs);
}

/** Cap in place. Applied last so nothing can push a delay back over the limit. */
function applyCeiling(delays: number[], maxDelayMs: number): number[] {
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]! > maxDelayMs) delays[i] = maxDelayMs;
  }
  return delays;
}

/**
 * Pair items (frame paths, buffers) with legal delays, repeating any item held
 * longer than the ceiling instead of truncating its delay.
 *
 * `delaysFromTimestamps` must cap a long hold, which shortens playback. This
 * keeps real time: a frame held for 166_768ms becomes three copies of that same
 * frame at ~55_589ms each. The result pairs 1:1 with its items, which is what
 * the encoders require (`delays.length === frames.length`), and the delays sum
 * to the same total as the uncapped timeline.
 *
 * Splitting evenly rather than emitting `[65535, 65535, 35698]` keeps the
 * repeats visually indistinguishable in a scrubber and avoids a stray short
 * frame at the end of a hold.
 *
 * @param items One entry per frame, in capture order.
 * @throws if `items` and `tMs` differ in length, or on any input
 *         `delaysFromTimestamps` rejects.
 */
export function expandForPlayback<T>(
  items: T[],
  tMs: number[],
  totalDurationMs: number,
  options: { maxDelayMs?: number } = {},
): { items: T[]; delays: number[] } {
  if (items.length !== tMs.length) {
    throw new Error(
      `expandForPlayback: ${items.length} items but ${tMs.length} timestamps - they must pair 1:1`,
    );
  }
  const maxDelayMs = options.maxDelayMs ?? MAX_DELAY_MS;

  // Uncapped, so the true duration of a long hold survives to be split.
  const trueDelays = delaysFromTimestamps(tMs, totalDurationMs, {
    maxDelayMs: Number.POSITIVE_INFINITY,
  });

  const outItems: T[] = [];
  const outDelays: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const delay = trueDelays[i]!;
    if (delay <= maxDelayMs) {
      outItems.push(items[i]!);
      outDelays.push(delay);
      continue;
    }
    const repeats = Math.ceil(delay / maxDelayMs);
    const each = delay / repeats;
    for (let r = 0; r < repeats; r++) {
      outItems.push(items[i]!);
      outDelays.push(each);
    }
  }

  return { items: outItems, delays: outDelays };
}

/**
 * Intervals where capture stalled: a delta larger than
 * `gapFactor * (1000 / targetFps)`.
 *
 * @throws if `targetFps` or `gapFactor` are not positive.
 */
export function findFrameGaps(
  tMs: number[],
  targetFps: number,
  gapFactor = 3,
): { after_index: number; gap_ms: number }[] {
  if (!Number.isFinite(targetFps) || targetFps <= 0) {
    throw new Error(`findFrameGaps: targetFps must be positive, got ${targetFps}`);
  }
  if (!Number.isFinite(gapFactor) || gapFactor <= 0) {
    throw new Error(`findFrameGaps: gapFactor must be positive, got ${gapFactor}`);
  }

  const threshold = gapFactor * (1000 / targetFps);
  const gaps: { after_index: number; gap_ms: number }[] = [];
  for (let i = 0; i + 1 < tMs.length; i++) {
    const delta = tMs[i + 1]! - tMs[i]!;
    if (delta > threshold) gaps.push({ after_index: i, gap_ms: delta });
  }
  return gaps;
}

/**
 * Clamp a capture rect into the viewport.
 *
 * Origin is clamped to the viewport first, then the extent is trimmed to what
 * remains. `clamped` is true whenever any component changed, which the manifest
 * surfaces as `region_clamped`.
 *
 * @throws if the input rect or the viewport has zero/negative area, or if the
 *         rect lies entirely outside the viewport (nothing left to capture).
 */
export function clampRect(rect: Rect, viewport: Pick<Viewport, "width" | "height">): {
  rect: Rect;
  clamped: boolean;
} {
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) {
    throw new Error("clampRect: viewport dimensions must be finite");
  }
  if (viewport.width <= 0 || viewport.height <= 0) {
    throw new Error(
      `clampRect: viewport must have positive area, got ${viewport.width}x${viewport.height}`,
    );
  }
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    throw new Error("clampRect: rect components must be finite");
  }
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error(`clampRect: rect must have positive area, got ${rect.width}x${rect.height}`);
  }

  const x = Math.min(Math.max(rect.x, 0), viewport.width);
  const y = Math.min(Math.max(rect.y, 0), viewport.height);
  // Trim the far edge back inside the viewport, then re-measure from the
  // clamped origin so the width can never go negative.
  const right = Math.min(rect.x + rect.width, viewport.width);
  const bottom = Math.min(rect.y + rect.height, viewport.height);
  const width = Math.max(right - x, 0);
  const height = Math.max(bottom - y, 0);

  if (width <= 0 || height <= 0) {
    throw new Error(
      `clampRect: rect ${rect.width}x${rect.height} at (${rect.x}, ${rect.y}) lies outside the ` +
        `${viewport.width}x${viewport.height} viewport`,
    );
  }

  const clamped =
    x !== rect.x || y !== rect.y || width !== rect.width || height !== rect.height;

  return { rect: { x, y, width, height }, clamped };
}
