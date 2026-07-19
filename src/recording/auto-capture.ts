/**
 * CBrowser - Cognitive Browser Automation
 * Copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com
 * Learn more at https://cbrowser.ai - MIT License
 */

/**
 * Auto-capture: wrap an existing run (a test suite, a cognitive journey) in a
 * screen capture without the caller making separate start/stop calls.
 *
 * The governing rule is that capture is a passenger. A run that would have
 * passed still passes if the recorder cannot start, cannot encode, or dies
 * mid-way — every entry point here swallows its own failures and reports them
 * as data. Losing a test result because the GIF encoder was missing would be a
 * worse bug than having no GIF.
 *
 * @since v18.70.0
 */

import { join } from "node:path";
import type { Page } from "playwright";

import { getPaths } from "../config.js";
import { VideoCaptureSession, type CaptureFormat } from "./engine.js";

/** Options a run can pass through to the recorder. */
export interface AutoCaptureOptions {
  /** Target frames per second (default: 10). */
  fps?: number;
  /** Output formats (default: ["gif"]). */
  format?: CaptureFormat[];
  /** Capture name / slug. Defaults to a name derived from the run. */
  name?: string;
  /** Output directory. Defaults to a slug directory under the videos dir. */
  outDir?: string;
  /** Hard cap on retained frames. */
  maxFrames?: number;
  /** JPEG quality for captured frames. */
  quality?: number;
  /**
   * How long to wait for the capture to stop and encode before giving up
   * (default {@link DEFAULT_STOP_TIMEOUT_MS}).
   *
   * A wrapped run must never be able to hang its host. If the recorder wedges —
   * a page that stops responding to CDP, an encoder that never returns — the
   * run reports a loud capture error and completes on time.
   */
  stopTimeoutMs?: number;
}

/**
 * Default bound on the stop path. Generous enough for a long capture's encode,
 * short enough that a wedged stop is obvious rather than mistaken for slowness.
 */
export const DEFAULT_STOP_TIMEOUT_MS = 30_000;

/** What a wrapped run reports back about its capture. */
export interface AutoCaptureResult {
  slug: string;
  outDir: string;
  manifestPath?: string;
  frames: number;
  actualFps?: number;
  durationMs?: number;
  artifacts?: Record<string, string>;
  /** Populated when capture failed; the run itself is unaffected. */
  error?: string;
}

/**
 * A run's capture option: `true` for defaults, or an options object.
 * `false`/`undefined` means no capture.
 */
export type AutoCaptureSetting = boolean | AutoCaptureOptions | undefined;

/** Normalise the option union into options, or null when capture is off. */
export function resolveCaptureOptions(setting: AutoCaptureSetting): AutoCaptureOptions | null {
  if (!setting) return null;
  return setting === true ? {} : setting;
}

/**
 * Start a capture on an already-launched page.
 *
 * Returns null when capture is disabled or could not start. The engine family
 * is read off the live Playwright context so this works for whichever browser
 * the run launched.
 */
export async function startAutoCapture(
  page: Page,
  setting: AutoCaptureSetting,
  defaultSlug: string,
): Promise<VideoCaptureSession | null> {
  const options = resolveCaptureOptions(setting);
  if (!options) return null;

  try {
    const engineName = page.context().browser()?.browserType().name();
    const engine =
      engineName === "firefox" ? "firefox" : engineName === "webkit" ? "webkit" : "chromium";

    // Screen captures live under videosDir. recordingsDir is the ACTION-recording
    // feature's home and is registered as a .json directory — writing frame
    // directories there would collide with it. Never os.tmpdir(): a capture in
    // tmp is one reboot from gone.
    //
    // Session-scoped to match the CLI and MCP layout
    // (~/.cbrowser/videos/<sessionId>/<slug>/) so all three capture surfaces
    // agree on disk, and so two concurrent runs that land on the same slug
    // cannot interleave frames into one directory.
    const paths = getPaths();
    const session = new VideoCaptureSession(page, engine, join(paths.videosDir, paths.sessionId));
    await session.start({
      ...(options.fps !== undefined ? { fps: options.fps } : {}),
      ...(options.format !== undefined ? { format: options.format } : {}),
      ...(options.maxFrames !== undefined ? { maxFrames: options.maxFrames } : {}),
      ...(options.quality !== undefined ? { quality: options.quality } : {}),
      ...(options.outDir !== undefined ? { outDir: options.outDir } : {}),
      slug: options.name ?? defaultSlug,
      // The target is left at the default viewport so the manifest records the
      // geometry the run actually executed at, whatever device or viewport the
      // caller configured.
      target: { kind: "viewport" },
    });
    return session;
  } catch (e) {
    console.warn(`   ⚠️  Capture could not start: ${(e as Error).message}`);
    return null;
  }
}

/** Sentinel for the stop race — a value `stop()` can never resolve to. */
const STOP_TIMED_OUT = Symbol("capture-stop-timeout");

/**
 * Await `session.stop()` under a hard deadline.
 *
 * On timeout the stop promise is abandoned, not cancelled — the engine has no
 * cancellation and may still be mid-encode. It is left with a catch handler
 * attached so a later rejection cannot surface as an unhandled rejection and
 * take down the host process, and the timer is unref'd so a pending deadline
 * never holds the event loop open.
 */
async function stopWithinTimeout(
  session: VideoCaptureSession,
  timeoutMs: number,
): Promise<Awaited<ReturnType<VideoCaptureSession["stop"]>>> {
  const stopping = session.stop();
  // Attached now, so an abandoned rejection is always handled.
  stopping.catch(() => { /* reported via the timeout path below */ });

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return stopping;

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof STOP_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(STOP_TIMED_OUT), timeoutMs);
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([stopping, deadline]);
    if (outcome === STOP_TIMED_OUT) {
      const status = session.status();
      throw new Error(
        `Capture stop timed out after ${timeoutMs}ms (state=${status.state}, ` +
          `frames=${status.frames}, elapsed=${status.elapsedMs}ms, slug=${status.slug}). ` +
          `Frames are still on disk at ${status.outDir}; the manifest and encoded ` +
          `artifacts were not written. The run itself was unaffected.`,
      );
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Stop a capture started by {@link startAutoCapture} and summarise it.
 *
 * Never throws, and never hangs: the stop path is bounded by `stopTimeoutMs`,
 * so a wedged recorder degrades to a loud `error` on the result rather than
 * stalling the run that wrapped it.
 */
export async function finishAutoCapture(
  session: VideoCaptureSession | null,
  stopTimeoutMs: number = DEFAULT_STOP_TIMEOUT_MS,
): Promise<AutoCaptureResult | undefined> {
  if (!session) return undefined;

  try {
    const result = await stopWithinTimeout(session, stopTimeoutMs);
    const status = session.status();
    const encodeErrors = Object.entries(result.encodeErrors ?? {});
    return {
      slug: result.manifest.slug,
      outDir: status.outDir,
      manifestPath: result.manifestPath,
      frames: result.manifest.frames.length,
      actualFps: result.manifest.actual_fps,
      durationMs: result.manifest.duration_ms,
      artifacts: result.manifest.artifacts,
      ...(encodeErrors.length > 0
        ? { error: encodeErrors.map(([fmt, msg]) => `${fmt}: ${msg}`).join("; ") }
        : {}),
    };
  } catch (e) {
    const status = session.status();
    const message = (e as Error).message;
    // Loud: a capture that failed silently would look like a capture that never
    // ran, and the run's own result gives no hint either way.
    console.warn(`   ⚠️  Capture did not complete: ${message}`);
    return {
      slug: status.slug,
      outDir: status.outDir,
      frames: status.frames,
      error: message,
    };
  }
}
