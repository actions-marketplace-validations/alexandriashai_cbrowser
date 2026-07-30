/**
 * Attention overlay for captured frames.
 *
 * Renders the model's predicted-attention map over each captured frame so a
 * recording can be watched with the attention structure visible, then handed to
 * the normal encoders as an ordinary frame sequence.
 *
 * WHY THIS USES THE DOM. Capture runs against a LIVE page, so the DOM is right
 * there — and `analyzeAttention` blends 35% bottom-up colour contrast with 65%
 * DOM semantics (element type x persona priority x goal relevance). Overlaying
 * the bottom-up half alone would paint the one component that has been
 * benchmarked and LOST: on 495 web pages against real human fixations it scored
 * AUC 0.585 versus a plain centre-bias baseline's 0.658. Passing DOM elements
 * makes this the actual production attention model rather than the weakest
 * quarter of it. Falls back to visual-only when no DOM is supplied, and says so
 * in the result.
 *
 * WHAT IT DOES AND DOES NOT ESTABLISH. With DOM this is the product's attention
 * prediction — legitimately what cbrowser computes and sells. It is not a
 * *validated* gaze prediction: the semantic layer carrying most of the blend has
 * never been tested against human eye movements in either direction, which is
 * what the primary collection study is being built to settle. So "predicted
 * attention" is accurate; "where users look" asserts an accuracy nobody has
 * measured yet. (2026-07-30)
 *
 * Cost: one attention pass per frame, roughly 0.5-1s each at typical viewport
 * sizes. A 5s capture at 10fps is ~50 frames, so budget 30-60s. That is why
 * this is opt-in and never the default.
 */

import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import { analyzeAttention, type DOMAttentionElement } from "../visual/attention-transport.js";

export interface AttentionOverlayOptions {
  /** 0-1 opacity of the heat layer. Default 0.55 — readable without hiding the page. */
  opacity?: number;
  /**
   * Cells below this fraction of the frame's peak stay fully transparent, so the
   * overlay marks hot regions rather than tinting everything. Default 0.35.
   */
  floor?: number;
  /** Analysis cell size in px. Default 16, matching the shipped attention model. */
  cellSize?: number;
  /** Persona whose priorities weight the semantic layer. Default "first-timer". */
  persona?: string;
  /**
   * DOM elements as the attention model consumes them. Supply these and the
   * overlay reflects the full 35/65 blend; omit them and it degrades to
   * bottom-up contrast only.
   */
  domElements?: DOMAttentionElement[];
  /** Goal string, which weights goal-relevance in the semantic layer. */
  goal?: string;
}

export interface OverlayResult {
  frames: string[];
  dir: string;
  /** Frames that could not be overlaid and fell back to the original. */
  failed: number;
  /** True when DOM elements were supplied, i.e. the full model ran. */
  usedDom: boolean;
  /** The quantity that was painted, for callers that label the artifact. */
  quantity: "predicted-attention" | "visual-contrast-only";
}

/**
 * Map a normalised 0-1 value to an RGBA pixel.
 *
 * Blue -> cyan -> green -> yellow -> red, the convention every saliency paper
 * uses, so the output reads correctly to anyone who has seen a fixation map.
 * Alpha ramps with heat, which keeps cold regions showing the actual page
 * instead of a uniform blue wash.
 */
function heatColour(v: number, opacity: number, floor: number): [number, number, number, number] {
  if (v <= floor) return [0, 0, 0, 0];
  const t = (v - floor) / (1 - floor || 1);

  let r: number, g: number, b: number;
  if (t < 0.25) { const u = t / 0.25; r = 0; g = Math.round(255 * u); b = 255; }
  else if (t < 0.5) { const u = (t - 0.25) / 0.25; r = 0; g = 255; b = Math.round(255 * (1 - u)); }
  else if (t < 0.75) { const u = (t - 0.5) / 0.25; r = Math.round(255 * u); g = 255; b = 0; }
  else { const u = (t - 0.75) / 0.25; r = 255; g = Math.round(255 * (1 - u)); b = 0; }

  return [r, g, b, Math.round(255 * opacity * Math.min(1, 0.35 + t))];
}

/**
 * Render one frame's attention map as a full-size RGBA buffer.
 *
 * The grid is computed at cell resolution, so it is upsampled here by
 * nearest-cell lookup against the ORIGINAL frame dimensions — resampling the
 * grid to the frame rather than the frame to the grid is what keeps the overlay
 * aligned with what the viewer actually sees.
 */
async function renderHeatLayer(
  framePath: string,
  frameWidth: number,
  frameHeight: number,
  opts: Required<Omit<AttentionOverlayOptions, "domElements" | "goal">> &
    Pick<AttentionOverlayOptions, "domElements" | "goal">,
): Promise<Buffer | null> {
  const analysis = await analyzeAttention(
    framePath,
    opts.persona,
    opts.cellSize,
    undefined,
    opts.domElements,
    opts.goal,
  );
  const map = analysis.saliencyMap;
  if (!map) return null;

  const { cells, rows, cols } = map;
  let peak = 0;
  for (const c of cells) if (c > peak) peak = c;
  const norm = peak > 0 ? peak : 1;

  const out = Buffer.alloc(frameWidth * frameHeight * 4);
  for (let y = 0; y < frameHeight; y++) {
    const row = Math.min(rows - 1, Math.floor((y / frameHeight) * rows));
    for (let x = 0; x < frameWidth; x++) {
      const col = Math.min(cols - 1, Math.floor((x / frameWidth) * cols));
      const [r, g, b, a] = heatColour(cells[row * cols + col] / norm, opts.opacity, opts.floor);
      const i = (y * frameWidth + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    }
  }
  return out;
}

/**
 * Overlay predicted attention onto every frame, writing a parallel set beside
 * the originals.
 *
 * A frame that fails falls back to the ORIGINAL frame rather than being
 * dropped: a recording with one un-overlaid frame is still usable, while a
 * missing frame corrupts the timing of every frame after it.
 */
export async function overlayAttentionOnFrames(
  framePaths: string[],
  outDir: string,
  options: AttentionOverlayOptions = {},
): Promise<OverlayResult> {
  const opts = {
    opacity: options.opacity ?? 0.55,
    floor: options.floor ?? 0.35,
    cellSize: options.cellSize ?? 16,
    persona: options.persona ?? "first-timer",
    domElements: options.domElements,
    goal: options.goal,
  };

  const sharpModule: any = await import("sharp");
  const sharp = sharpModule.default ?? sharpModule;

  const dir = join(outDir, "frames-attention");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const frames: string[] = [];
  let failed = 0;

  for (const framePath of framePaths) {
    const target = join(dir, basename(framePath));
    try {
      const meta = await sharp(framePath).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (!width || !height) throw new Error("frame has no dimensions");

      const heat = await renderHeatLayer(framePath, width, height, opts);
      if (!heat) throw new Error("no attention map produced");

      await sharp(framePath)
        .composite([{ input: heat, raw: { width, height, channels: 4 }, blend: "over" }])
        .toFile(target);

      frames.push(target);
    } catch {
      failed++;
      frames.push(framePath);
    }
  }

  const usedDom = (opts.domElements?.length ?? 0) > 0;
  return {
    frames,
    dir,
    failed,
    usedDom,
    quantity: usedDom ? "predicted-attention" : "visual-contrast-only",
  };
}
