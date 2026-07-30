/**
 * journey_heatmap_gif Encoder Regression Guard (ISC-38)
 *
 * WHAT THIS COVERS
 *   The GIF encoding stage of `journey_heatmap_gif` — resize to 640x400, raw
 *   extract, vertical RGBA stack, sharp .gif({delay, loop}) — on a pinned,
 *   deterministic set of synthetic frames. Two independent guards:
 *     1. EQUIVALENCE: the extracted `encodeJourneyHeatmapGif()` is asserted
 *        byte-identical to a literal reproduction of the original inline
 *        pipeline (copied from the pre-extraction handler and kept here on
 *        purpose). This is what proves the extraction changed nothing.
 *     2. PIN: a SHA-256 of the encoder output, plus GIF page count, dimensions
 *        and per-frame delay, so any future change to the encoder — sharp
 *        upgrade included — fails loudly instead of silently reshaping output.
 *
 * WHAT THIS DOES NOT COVER — stated plainly rather than implied:
 *   - The live journey: browser launch, navigation, persona decisions, and the
 *     Anthropic API calls that drive them. Those are non-deterministic and
 *     network-bound; no byte-compare is possible over them.
 *   - Heatmap rendering (how attention data becomes frame pixels). The frames
 *     here are synthetic, not real heatmaps.
 *   - Upload/writeFileSync to the public heatmaps directory, and the returned
 *     URL shape.
 *   So: "byte-identical" is proven for the ENCODER on fixed input, not for the
 *   tool end-to-end. A regression in heatmap rendering would not be caught here.
 */

import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  encodeJourneyHeatmapGif,
  HEATMAP_GIF_FRAME_WIDTH,
  HEATMAP_GIF_FRAME_HEIGHT,
} from "../src/mcp-tools/base/gif-tools.js";

const FRAME_DELAY = 2000;
const FRAME_COUNT = 4;

/**
 * The frames and the canonical encode are computed once and shared. The encoder
 * is deterministic — proven by the byte-stability test below, which does its
 * own independent encode — so reusing the buffer costs nothing in rigour and
 * keeps this file from re-encoding a 640x1600 GIF nine times.
 */
let framesOnce: Promise<Buffer[]> | undefined;
const sharedFrames = () => (framesOnce ??= pinnedFrames());

let gifOnce: Promise<Buffer> | undefined;
const sharedGif = async () => (gifOnce ??= encodeJourneyHeatmapGif(await sharedFrames(), FRAME_DELAY));

/**
 * Deterministic RGBA frames. Values are a fixed function of position and frame
 * index — no randomness, no timestamps — so the encoder output is stable across
 * machines and runs.
 */
async function pinnedFrames(): Promise<Buffer[]> {
  const width = 320;
  const height = 200;
  const frames: Buffer[] = [];

  for (let f = 0; f < FRAME_COUNT; f++) {
    const raw = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        raw[i] = (x * 3 + f * 40) % 256;
        raw[i + 1] = (y * 5 + f * 20) % 256;
        raw[i + 2] = ((x + y) * 2 + f * 60) % 256;
        raw[i + 3] = 255;
      }
    }
    frames.push(await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer());
  }
  return frames;
}

/**
 * The ORIGINAL inline pipeline, copied verbatim from the handler before the
 * extraction. Do not "clean this up" — its whole job is to be the historical
 * reference the extracted function is compared against.
 */
async function originalInlinePipeline(frames: Buffer[], frameDelay: number): Promise<Buffer> {
  const delays = frames.map(() => frameDelay);
  const frameHeight = 400;
  const frameWidth = 640;

  const compositeFrames = await Promise.all(
    frames.map(f => sharp(f).resize(frameWidth, frameHeight).raw().toBuffer())
  );

  const totalHeight = frameHeight * frames.length;
  const stackedBuffer = Buffer.alloc(frameWidth * totalHeight * 4);
  for (let i = 0; i < compositeFrames.length; i++) {
    compositeFrames[i].copy(stackedBuffer, i * frameWidth * frameHeight * 4);
  }

  return sharp(stackedBuffer, {
    raw: { width: frameWidth, height: totalHeight, channels: 4 },
  })
    .gif({
      delay: delays,
      loop: 0,
    })
    .toBuffer();
}

describe("journey_heatmap_gif encoder regression (ISC-38)", () => {
  test("extraction is byte-identical to the original inline pipeline", async () => {
    const frames = await sharedFrames();
    const extracted = await sharedGif();
    const original = await originalInlinePipeline(frames, FRAME_DELAY);

    expect(extracted.length).toBe(original.length);
    expect(extracted.equals(original)).toBe(true);
  }, 60000);

  test("encoder output is byte-stable across repeated runs", async () => {
    const frames = await sharedFrames();
    const a = await sharedGif();
    // b is a fresh, independent encode — this is what licenses the sharing above.
    const b = await encodeJourneyHeatmapGif(frames, FRAME_DELAY);
    expect(a.equals(b)).toBe(true);
  }, 60000);

  test("pinned encoder inputs and output shape", async () => {
    const gif = await sharedGif();

    // Encoder inputs — a change to any of these changes every GIF the tool emits.
    expect(HEATMAP_GIF_FRAME_WIDTH).toBe(640);
    expect(HEATMAP_GIF_FRAME_HEIGHT).toBe(400);

    const meta = await sharp(gif, { animated: true }).metadata();
    expect(meta.format).toBe("gif");
    expect(meta.width).toBe(640);
    // Frames are stacked into one tall image: 4 x 400px.
    expect(meta.height).toBe(FRAME_COUNT * 400);
    expect(meta.loop).toBe(0);
  }, 30000);

  test("KNOWN DEFECT, pinned not fixed: the GIF is single-page, not animated", async () => {
    // The handler stacks frames vertically into one raw buffer but never tells
    // sharp the page height, so libvips encodes ONE 640x1600 frame rather than
    // 4 animated pages — the per-frame `delay` array collapses to a single
    // entry. `journey_heatmap_gif` therefore returns a tall contact-sheet-like
    // still, not an animation.
    //
    // ISC-38 requires this encoder to be byte-identical before and after the
    // capture work, so the defect is PINNED here, not repaired. Fixing it
    // (passing `pageHeight` on the input) is a deliberate follow-up that will
    // change these bytes and must re-pin the SHA below.
    const gif = await sharedGif();
    const meta = await sharp(gif, { animated: true }).metadata();

    expect(meta.pages).toBe(1);
    expect(meta.pageHeight).toBeUndefined();
    expect(meta.delay).toEqual([FRAME_DELAY]);
  }, 30000);

  test("pinned SHA-256 of the encoded GIF", async () => {
    const gif = await sharedGif();
    const digest = createHash("sha256").update(gif).digest("hex");

    // If this fails, the encoder or the sharp/libvips version changed. That may
    // be legitimate — but it must be a decision, not a surprise. Re-pin only
    // after confirming the visual output is still correct.
    expect(digest).toBe(PINNED_SHA256);
  }, 30000);

  test("frame delay flows through to every page", async () => {
    // Two frames is enough to check delay plumbing, and encodes far faster.
    const frames = (await sharedFrames()).slice(0, 2);
    const gif = await encodeJourneyHeatmapGif(frames, 500);
    const meta = await sharp(gif, { animated: true }).metadata();
    // Single-page today (see the known-defect test above), so one delay entry.
    expect(meta.delay).toEqual([500]);
  }, 30000);
});

/** Pinned 2026-07-19 against sharp 0.34.5. See the SHA-256 test above. */
const PINNED_SHA256 = "6e011a865a6d47e2869e2f9cf0e21bc78793f574996917e230b8e45e3f116a1f";
