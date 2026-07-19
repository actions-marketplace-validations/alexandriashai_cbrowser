/**
 * Recording encoders — turn a directory of captured frames into an animated
 * GIF, an animated WebP, or a video.
 *
 * Two hard constraints shape this module:
 *
 * 1. Frames arrive from a CDP screencast, so they are JPEGs of *differing*
 *    byte length and occasionally differing pixel dimensions (a viewport
 *    change mid-capture re-sizes the stream). Every frame is therefore
 *    normalised to one locked output size before encoding. Do not "optimise"
 *    this into raw-buffer stacking — sharp's animated encoders need a joined
 *    input, and a stacked raw buffer silently produces a single tall page.
 *
 * 2. Capture is event-driven, so frames are *not* evenly spaced. Per-frame
 *    delays come from the caller (derived from frame timestamps), never from
 *    a constant cadence.
 *
 * @since v18.70.0
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

/** Result of a successful encode. */
export interface EncodeResult {
  /** Absolute path to the encoded artifact. */
  path: string;
  /** Size of the artifact in bytes. */
  bytes: number;
  /** Number of frames encoded. */
  frames: number;
  /** Locked output width in pixels. */
  width: number;
  /** Locked output height in pixels. */
  height: number;
}

export interface EncodeOptions {
  /** Locked output width. Defaults to the first frame's width. */
  width?: number;
  /** Locked output height. Defaults to the first frame's height. */
  height?: number;
  /**
   * Per-frame source crop, parallel to `frames`. Screencast frames are written
   * to disk full-viewport so a capture can be re-cropped later, so region and
   * element captures crop here at encode time rather than at capture time.
   * A crop that falls outside its frame is trimmed to the frame.
   */
  crops?: { x: number; y: number; width: number; height: number }[];
  /** Downscale factor applied to the locked size (0 < scale <= 1). */
  scale?: number;
  /** Loop count for animated formats (0 = infinite, the default). */
  loop?: number;
}

/**
 * Thrown when an encoder's external dependency is missing. Callers surface the
 * message verbatim and exit non-zero — recording itself has already succeeded
 * at this point, so this must never be swallowed into a silent partial result.
 */
export class MissingEncoderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingEncoderError";
  }
}

// =========================================================================
// Frame normalisation
// =========================================================================

/**
 * Resolve the locked output dimensions from the first frame, honouring any
 * caller override and forcing even numbers (video encoders reject odd sizes).
 */
async function lockDimensions(
  firstFrame: string,
  options: EncodeOptions,
  requireEven = false,
): Promise<{ width: number; height: number }> {
  const meta = await sharp(firstFrame).metadata();
  const firstCrop = options.crops?.[0];
  const baseWidth = options.width ?? firstCrop?.width ?? meta.width;
  const baseHeight = options.height ?? firstCrop?.height ?? meta.height;

  if (!baseWidth || !baseHeight) {
    throw new Error(`Cannot determine frame dimensions from ${firstFrame}`);
  }

  const scale = options.scale ?? 1;
  if (scale <= 0 || scale > 1) {
    throw new Error(`Invalid scale ${scale} - must be > 0 and <= 1`);
  }

  const width = Math.max(1, Math.round(baseWidth * scale));
  const height = Math.max(1, Math.round(baseHeight * scale));

  // Only the video path forces even dimensions - yuv420p subsampling requires
  // them. Applying that rounding to GIF/WebP made a 393px-wide iPhone capture
  // emit a 394px artifact, and a one-pixel drift from the declared viewport is
  // exactly what breaks a pixel-exact visual baseline for no real reason.
  if (!requireEven) return { width, height };
  return {
    width: Math.max(2, Math.round(width / 2) * 2),
    height: Math.max(2, Math.round(height / 2) * 2),
  };
}

/**
 * Normalise one frame to the locked size. `fit: "contain"` preserves aspect
 * ratio and letterboxes rather than distorting - a frame that arrived at a
 * different viewport size should look small, not stretched.
 */
async function normaliseFrame(
  framePath: string,
  width: number,
  height: number,
  crop?: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  let pipeline = sharp(framePath);

  if (crop) {
    // The crop is trimmed to the frame it is being applied to: an element that
    // drifts partly off-screen still yields the visible part rather than
    // failing the whole encode on a sharp extract_area error.
    const meta = await pipeline.metadata();
    const frameWidth = meta.width ?? width;
    const frameHeight = meta.height ?? height;
    const left = Math.max(0, Math.min(Math.round(crop.x), frameWidth - 1));
    const top = Math.max(0, Math.min(Math.round(crop.y), frameHeight - 1));
    const extractWidth = Math.max(1, Math.min(Math.round(crop.width), frameWidth - left));
    const extractHeight = Math.max(1, Math.min(Math.round(crop.height), frameHeight - top));
    pipeline = pipeline.extract({ left, top, width: extractWidth, height: extractHeight });
  }

  return pipeline
    .resize(width, height, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .png()
    .toBuffer();
}

/** Validate the frames/delays pairing shared by every animated encoder. */
function assertEncodable(frames: string[], delays: number[], label: string): void {
  if (frames.length === 0) {
    throw new Error(`Cannot encode ${label}: no frames`);
  }
  if (delays.length !== frames.length) {
    throw new Error(
      `Cannot encode ${label}: ${frames.length} frames but ${delays.length} delays - ` +
        `delays must be derived per-frame from capture timestamps`,
    );
  }
  const missing = frames.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    throw new Error(`Cannot encode ${label}: ${missing.length} frame file(s) missing, first: ${missing[0]}`);
  }
}

// =========================================================================
// Animated image encoders (sharp)
// =========================================================================

/**
 * Encode frames into an animated GIF with per-frame delays.
 *
 * A single-frame recording (a static page that emitted no screencast events)
 * encodes to a one-page GIF rather than failing.
 */
export async function encodeGif(
  frames: string[],
  delays: number[],
  outPath: string,
  options: EncodeOptions = {},
): Promise<EncodeResult> {
  assertEncodable(frames, delays, "GIF");
  const { width, height } = await lockDimensions(frames[0], options);
  const normalised = await Promise.all(frames.map((f, i) => normaliseFrame(f, width, height, options.crops?.[i])));

  await sharp(normalised, { join: { animated: true } })
    .gif({ delay: delays.map((d) => Math.max(10, Math.round(d))), loop: options.loop ?? 0 })
    .toFile(outPath);

  return { path: outPath, bytes: statSync(outPath).size, frames: frames.length, width, height };
}

/** Encode frames into an animated WebP with per-frame delays. */
export async function encodeWebp(
  frames: string[],
  delays: number[],
  outPath: string,
  options: EncodeOptions = {},
): Promise<EncodeResult> {
  assertEncodable(frames, delays, "WebP");
  const { width, height } = await lockDimensions(frames[0], options);
  const normalised = await Promise.all(frames.map((f, i) => normaliseFrame(f, width, height, options.crops?.[i])));

  await sharp(normalised, { join: { animated: true } })
    .webp({ delay: delays.map((d) => Math.max(10, Math.round(d))), loop: options.loop ?? 0 })
    .toFile(outPath);

  return { path: outPath, bytes: statSync(outPath).size, frames: frames.length, width, height };
}

// =========================================================================
// ffmpeg resolution
// =========================================================================

/**
 * Locate Playwright's bundled ffmpeg. A bare `ffmpeg` is never invoked: the
 * PATH binary is not guaranteed to exist on deploy targets, and silently
 * picking up an arbitrary system build makes output non-reproducible.
 *
 * Probe order: $PLAYWRIGHT_BROWSERS_PATH, then the per-user cache directories.
 */
export function resolveFfmpegPath(): string | null {
  const override = process.env.CBROWSER_FFMPEG_PATH;
  if (override && existsSync(override)) return override;

  const roots: string[] = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  roots.push(join(homedir(), ".cache", "ms-playwright"));

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.startsWith("ffmpeg-")).sort().reverse()) {
      for (const bin of ["ffmpeg-linux", "ffmpeg-mac", "ffmpeg-win64.exe"]) {
        const candidate = join(root, entry, bin);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** Run ffmpeg and collect stdout+stderr. */
function runFfmpeg(bin: string, args: string[], stdin?: Buffer): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    proc.stdout.on("data", (d: Buffer) => { output += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { output += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? -1, output }));

    if (stdin) {
      proc.stdin.on("error", () => { /* ffmpeg may exit before the write drains */ });
      proc.stdin.end(stdin);
    } else {
      proc.stdin.end();
    }
  });
}

/** Cached capability probe of a resolved ffmpeg binary. */
const capabilityCache = new Map<string, { muxers: Set<string>; encoders: Set<string> }>();

async function ffmpegCapabilities(bin: string): Promise<{ muxers: Set<string>; encoders: Set<string> }> {
  const cached = capabilityCache.get(bin);
  if (cached) return cached;

  const parse = (text: string): Set<string> => {
    const names = new Set<string>();
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*[A-Z. ]{2,6}\s+(\S+)/);
      if (match) names.add(match[1]);
    }
    return names;
  };

  const [muxers, encoders] = await Promise.all([
    runFfmpeg(bin, ["-hide_banner", "-muxers"]),
    runFfmpeg(bin, ["-hide_banner", "-encoders"]),
  ]);

  const caps = { muxers: parse(muxers.output), encoders: parse(encoders.output) };
  capabilityCache.set(bin, caps);
  return caps;
}

/**
 * Resample variable-delay frames onto a constant-rate timeline by repeating
 * each frame for as long as it was on screen. Video containers assume a fixed
 * frame rate; repeating is how event-driven capture maps onto one without
 * inventing content that was never displayed.
 */
export function resampleToConstantRate(frames: string[], delays: number[], fps: number): string[] {
  const frameMs = 1000 / fps;
  const timeline: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const repeats = Math.max(1, Math.round((delays[i] ?? frameMs) / frameMs));
    for (let r = 0; r < repeats; r++) timeline.push(frames[i]);
  }
  return timeline;
}

/**
 * Encode frames into a video via an ffmpeg-family binary.
 *
 * `container` selects the muxer/encoder pair. Playwright's bundled ffmpeg is a
 * stripped build that ships only the WebM muxer and the libvpx (VP8) encoder,
 * so "webm" works out of the box and "mp4" requires a fuller ffmpeg.
 */
async function encodeVideo(
  frames: string[],
  delays: number[],
  outPath: string,
  container: "webm" | "mp4",
  options: EncodeOptions & { fps?: number } = {},
): Promise<EncodeResult> {
  assertEncodable(frames, delays, container.toUpperCase());

  const bin = resolveFfmpegPath();
  if (!bin) {
    throw new MissingEncoderError(
      `Cannot encode ${container.toUpperCase()}: no ffmpeg binary found. ` +
        `Looked for Playwright's bundled ffmpeg under $PLAYWRIGHT_BROWSERS_PATH and ` +
        `${join(homedir(), ".cache", "ms-playwright")}/ffmpeg-*/. ` +
        `Install it with 'npx playwright install ffmpeg', or re-run with --format gif,webp.`,
    );
  }

  const caps = await ffmpegCapabilities(bin);
  const wanted = container === "webm"
    ? { muxer: "webm", encoders: ["libvpx", "libvpx-vp9"] }
    : { muxer: "mp4", encoders: ["libx264", "libopenh264", "h264_videotoolbox", "mpeg4"] };

  const encoder = wanted.encoders.find((e) => caps.encoders.has(e));
  if (!caps.muxers.has(wanted.muxer) || !encoder) {
    const missing = [
      !caps.muxers.has(wanted.muxer) ? `muxer '${wanted.muxer}'` : null,
      !encoder ? `video encoder (need one of: ${wanted.encoders.join(", ")})` : null,
    ].filter(Boolean).join(" and ");
    throw new MissingEncoderError(
      `Cannot encode ${container.toUpperCase()}: ${bin} is missing ${missing}. ` +
        `Playwright's bundled ffmpeg is a stripped build (WebM/VP8 only). ` +
        `Install a full ffmpeg and set CBROWSER_FFMPEG_PATH, or re-run with --format ${container === "mp4" ? "webm" : "gif"}.`,
    );
  }

  const { width, height } = await lockDimensions(frames[0], options, true);
  const fps = options.fps ?? 10;
  const timeline = resampleToConstantRate(frames, delays, fps);
  const cropTimeline = options.crops
    ? resampleToConstantRate(options.crops.map((_, i) => String(i)), delays, fps)
        .map((i) => options.crops![Number(i)])
    : undefined;

  // Frames are normalised to identical JPEG dimensions and concatenated into
  // one mjpeg stream; the stripped build has only the image2pipe demuxer, and
  // it needs the decoder named explicitly when reading from a pipe.
  const jpegs = await Promise.all(
    timeline.map(async (f, i) =>
      sharp(await normaliseFrame(f, width, height, cropTimeline?.[i]))
        .jpeg({ quality: 90 })
        .toBuffer(),
    ),
  );

  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(fps), "-i", "pipe:0",
    "-c:v", encoder,
    "-pix_fmt", "yuv420p",
    "-an",
    outPath,
  ];

  const { code, output } = await runFfmpeg(bin, args, Buffer.concat(jpegs));
  if (code !== 0 || !existsSync(outPath)) {
    throw new Error(`ffmpeg failed encoding ${container} (exit ${code}): ${output.trim() || "no output"}`);
  }

  return { path: outPath, bytes: statSync(outPath).size, frames: timeline.length, width, height };
}

/** Encode frames into a WebM/VP8 video. Works with Playwright's bundled ffmpeg. */
export async function encodeWebm(
  frames: string[],
  delays: number[],
  outPath: string,
  options: EncodeOptions & { fps?: number } = {},
): Promise<EncodeResult> {
  return encodeVideo(frames, delays, outPath, "webm", options);
}

/**
 * Encode frames into an MP4.
 *
 * Requires an ffmpeg with the mp4 muxer and an H.264-family encoder. Playwright's
 * bundled binary has neither, so this throws {@link MissingEncoderError} unless a
 * fuller ffmpeg is installed.
 */
export async function encodeMp4(
  frames: string[],
  delays: number[],
  outPath: string,
  options: EncodeOptions & { fps?: number } = {},
): Promise<EncodeResult> {
  return encodeVideo(frames, delays, outPath, "mp4", options);
}
