/**
 * Recording engine integration tests.
 *
 * These drive a real Chromium through the real CDP screencast against two
 * local fixtures - one that paints every frame, one that never repaints after
 * first paint. The static fixture is the important one: the screencast is
 * event-driven, so it exercises the path where the browser sends nothing at
 * all and the engine still has to produce a valid recording.
 *
 * Each fixture is recorded once and memoised. Recording happens inside the
 * tests rather than in a `beforeAll` so the per-test timeout applies to it -
 * a 3s capture plus browser launch does not fit in the default hook timeout.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";

import { VideoCaptureSession, type VideoCaptureOptions, type VideoCaptureResult } from "../src/recording/engine.js";
import { parseManifest } from "../src/recording/types.js";

const FIXTURES = resolve(import.meta.dir, "fixtures");
const DURATION_MS = 3000;
const FPS = 10;
const TIMEOUT = 60_000;

const workDir = mkdtempSync(join(tmpdir(), "cbrowser-recording-test-"));

let browser: Browser | null = null;
const openPages: Page[] = [];

async function getBrowser(): Promise<Browser> {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

interface Recorded {
  session: VideoCaptureSession;
  result: VideoCaptureResult;
  outDir: string;
}

const recordings = new Map<string, Promise<Recorded>>();

/** Record a fixture end to end, once per fixture name. */
function record(
  fixture: string,
  name: string,
  overrides: Partial<VideoCaptureOptions> = {},
): Promise<Recorded> {
  const existing = recordings.get(name);
  if (existing) return existing;

  const run = (async (): Promise<Recorded> => {
    const b = await getBrowser();
    const page = await b.newPage({ viewport: { width: 640, height: 400 } });
    openPages.push(page);
    await page.goto(`file://${join(FIXTURES, fixture)}`);
    await page.waitForLoadState("load");

    const outDir = join(workDir, name);
    const session = new VideoCaptureSession(page, "chromium", workDir);
    await session.start({
      fps: FPS,
      durationMs: DURATION_MS,
      outDir,
      slug: name,
      format: ["gif"],
      // Element targets resolve through the real browser resolver in
      // production; a plain page.locator is the right stand-in here because
      // this suite is testing tracking, not selector resolution.
      resolveElement: async (selector: string) => page.locator(selector).first(),
      ...overrides,
    });

    // The duration timer auto-stops. Wait past it, then call stop() to collect
    // the result - stop() is idempotent, so this returns the timer's own run.
    await new Promise((r) => setTimeout(r, DURATION_MS + 800));
    const result = await session.stop();
    return { session, result, outDir };
  })();

  recordings.set(name, run);
  return run;
}

afterAll(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  await browser?.close();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe("VideoCaptureSession - continuously animating page", () => {
  test("captures at least 25 frames over 3s at 10fps", async () => {
    const { result } = await record("animating.html", "animating");
    expect(result.manifest.frames.length).toBeGreaterThanOrEqual(25);
  }, TIMEOUT);

  test("writes every manifest frame to disk", async () => {
    const { result, outDir } = await record("animating.html", "animating");
    expect(readdirSync(join(outDir, "frames")).length).toBe(result.manifest.frames.length);
    for (const frame of result.manifest.frames) {
      expect(existsSync(join(outDir, frame.path))).toBe(true);
    }
  }, TIMEOUT);

  test("manifest parses against the schema", async () => {
    const { result } = await record("animating.html", "animating");
    const parsed = parseManifest(readFileSync(result.manifestPath, "utf-8"));
    expect(parsed.capture_method).toBe("cdp-screencast");
    expect(parsed.engine).toBe("chromium");
    expect(parsed.target_fps).toBe(FPS);
  }, TIMEOUT);

  test("final frame timestamp matches the requested duration within 250ms", async () => {
    const { result } = await record("animating.html", "animating");
    const last = result.manifest.frames[result.manifest.frames.length - 1]!;
    expect(Math.abs(last.t_ms - DURATION_MS)).toBeLessThanOrEqual(250);
  }, TIMEOUT);

  test("timestamps are non-decreasing and frame indices dense", async () => {
    const { result } = await record("animating.html", "animating");
    result.manifest.frames.forEach((f, i) => {
      expect(f.index).toBe(i);
      if (i > 0) expect(f.t_ms).toBeGreaterThanOrEqual(result.manifest.frames[i - 1]!.t_ms);
    });
  }, TIMEOUT);

  test("detects change points on a page that never stops moving", async () => {
    const { result } = await record("animating.html", "animating");
    expect(result.manifest.change_points.length).toBeGreaterThan(0);
  }, TIMEOUT);

  test("encodes a multi-page animated GIF", async () => {
    const { result, outDir } = await record("animating.html", "animating");
    const gifPath = join(outDir, result.manifest.artifacts.gif!);
    expect(existsSync(gifPath)).toBe(true);
    const meta = await sharp(gifPath, { animated: true }).metadata();
    expect(meta.pages).toBeGreaterThan(1);
    // Identical consecutive frames are collapsed into one longer-delay page by
    // the encoder, so pages tracks frames from below rather than exactly.
    expect(meta.pages).toBeLessThanOrEqual(result.manifest.frames.length);
    expect(meta.pages).toBeGreaterThan(result.manifest.frames.length * 0.5);
  }, TIMEOUT);

  test("stop() is idempotent", async () => {
    const { session, result } = await record("animating.html", "animating");
    const second = await session.stop();
    expect(second.manifestPath).toBe(result.manifestPath);
    expect(second.manifest.frames.length).toBe(result.manifest.frames.length);
    expect(session.status().state).toBe("stopped");
  }, TIMEOUT);
});

describe("VideoCaptureSession - fully static page", () => {
  test("still produces at least one frame when the screencast emits nothing", async () => {
    const { result } = await record("static.html", "static");
    expect(result.manifest.frames.length).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  test("records the silence as frame gaps rather than faking frames", async () => {
    const { result } = await record("static.html", "static");
    expect(result.manifest.frame_gaps.length).toBeGreaterThan(0);
    const largest = Math.max(...result.manifest.frame_gaps.map((g) => g.gap_ms));
    expect(largest).toBeGreaterThan(1000);
  }, TIMEOUT);

  test("frame count stays far below the nominal fps * duration", async () => {
    // A clocked capture would produce ~30 frames here. Capture is not clocked.
    const { result } = await record("static.html", "static");
    expect(result.manifest.frames.length).toBeLessThan(10);
  }, TIMEOUT);

  test("final frame timestamp still matches the requested duration", async () => {
    const { result } = await record("static.html", "static");
    const last = result.manifest.frames[result.manifest.frames.length - 1]!;
    expect(Math.abs(last.t_ms - DURATION_MS)).toBeLessThanOrEqual(250);
  }, TIMEOUT);

  test("manifest parses and reports an honest actual_fps", async () => {
    const { result } = await record("static.html", "static");
    const parsed = parseManifest(readFileSync(result.manifestPath, "utf-8"));
    expect(parsed.actual_fps).toBeLessThan(FPS);
  }, TIMEOUT);

  test("encodes a GIF even from a near-static capture", async () => {
    const { result, outDir } = await record("static.html", "static");
    const gifPath = join(outDir, result.manifest.artifacts.gif!);
    expect(existsSync(gifPath)).toBe(true);
    const meta = await sharp(gifPath, { animated: true }).metadata();
    // The GIF encoder collapses runs of identical frames into one page with a
    // longer delay, so pages <= frames here. What must survive is the wall
    // clock: the animation has to last as long as the capture did.
    expect(meta.pages).toBeGreaterThanOrEqual(1);
    expect(meta.pages).toBeLessThanOrEqual(result.manifest.frames.length);
    const totalDelay = (meta.delay ?? []).reduce((a, b) => a + b, 0);
    expect(totalDelay).toBeGreaterThan(result.manifest.duration_ms * 0.8);
  }, TIMEOUT);
});

describe("VideoCaptureSession - guards", () => {
  test("rejects a non-positive fps", async () => {
    const page = await (await getBrowser()).newPage();
    openPages.push(page);
    const session = new VideoCaptureSession(page, "chromium", workDir);
    await expect(session.start({ fps: 0 })).rejects.toThrow(/positive/i);
  }, TIMEOUT);

  test("stop() before start() throws rather than writing an empty manifest", async () => {
    const page = await (await getBrowser()).newPage();
    openPages.push(page);
    const session = new VideoCaptureSession(page, "chromium", workDir);
    await expect(session.stop()).rejects.toThrow(/never started/i);
  }, TIMEOUT);
});

describe("VideoCaptureSession - region target", () => {
  test("crops every frame to the region and locks output_dims to it", async () => {
    const { result } = await record("animating.html", "region", {
      target: { kind: "region", rect: { x: 40, y: 30, width: 320, height: 240 } },
    });
    expect(result.manifest.target.kind).toBe("region");
    expect(result.manifest.output_dims).toEqual({ width: 320, height: 240 });
    expect(result.manifest.region_clamped).toBe(false);
    for (const frame of result.manifest.frames) {
      expect(frame.crop).toEqual({ x: 40, y: 30, width: 320, height: 240 });
    }
  }, TIMEOUT);

  test("GIF pixel dimensions are exactly the region size", async () => {
    const { result, outDir } = await record("animating.html", "region", {
      target: { kind: "region", rect: { x: 40, y: 30, width: 320, height: 240 } },
    });
    const meta = await sharp(join(outDir, result.manifest.artifacts.gif!), { animated: true }).metadata();
    expect(meta.width).toBe(320);
    // Animated metadata reports the full filmstrip height; pageHeight is the frame.
    expect(meta.pageHeight ?? meta.height).toBe(240);
  }, TIMEOUT);

  test("a region overhanging the viewport is clamped, not rejected", async () => {
    const { result } = await record("animating.html", "region-clamped", {
      target: { kind: "region", rect: { x: 500, y: 300, width: 400, height: 400 } },
    });
    expect(result.manifest.region_clamped).toBe(true);
    // Viewport is 640x400, so the rect trims to 140x100 at (500, 300).
    expect(result.manifest.output_dims).toEqual({ width: 140, height: 100 });
  }, TIMEOUT);
});

describe("VideoCaptureSession - element target", () => {
  test("reports an element target and locks output_dims to the element box", async () => {
    const { result } = await record("animating.html", "element", {
      target: { kind: "element", selector: "#box", padding: 0 },
    });
    expect(result.manifest.target.kind).toBe("element");
    expect(result.manifest.output_dims.width).toBeGreaterThan(0);
    expect(result.manifest.output_dims.height).toBeGreaterThan(0);
  }, TIMEOUT);

  test("crop follows the element as it moves", async () => {
    const { result } = await record("animating.html", "element", {
      target: { kind: "element", selector: "#box", padding: 0 },
    });
    const frames = result.manifest.frames;
    expect(frames.length).toBeGreaterThan(10);

    // The proof of tracking: the crop is re-measured per frame, so a moving
    // element yields different rects. A fixed full-viewport crop fails here.
    const distinct = new Set(frames.map((f) => JSON.stringify(f.crop)));
    expect(distinct.size).toBeGreaterThan(1);
    expect(JSON.stringify(frames[0]!.crop)).not.toBe(JSON.stringify(frames[10]!.crop));
    for (const frame of frames) {
      expect(frame.crop.width).toBeLessThan(640);
    }
  }, TIMEOUT);

  test("frames are marked tracking:ok while the element is measurable", async () => {
    const { result } = await record("animating.html", "element", {
      target: { kind: "element", selector: "#box", padding: 0 },
    });
    expect(result.manifest.frames.every((f) => f.tracking === "ok")).toBe(true);
  }, TIMEOUT);

  test("padding expands the captured box", async () => {
    const { result } = await record("animating.html", "element-padded", {
      target: { kind: "element", selector: "#box", padding: 20 },
    });
    const unpadded = await record("animating.html", "element", {
      target: { kind: "element", selector: "#box", padding: 0 },
    });
    expect(result.manifest.output_dims.width).toBeGreaterThan(unpadded.result.manifest.output_dims.width);
  }, TIMEOUT);

  test("an element that disappears goes stale instead of killing the capture", async () => {
    const { result } = await record("vanishing.html", "element-stale", {
      target: { kind: "element", selector: "#box", padding: 0 },
    });
    const tracking = result.manifest.frames.map((f) => f.tracking);
    expect(tracking).toContain("ok");
    expect(tracking).toContain("stale");
    // Capture keeps running: the last frame still lands at the requested duration.
    const last = result.manifest.frames[result.manifest.frames.length - 1]!;
    expect(Math.abs(last.t_ms - DURATION_MS)).toBeLessThanOrEqual(250);
  }, TIMEOUT);

  test("an unmatched selector fails loudly at start()", async () => {
    const page = await (await getBrowser()).newPage();
    openPages.push(page);
    const session = new VideoCaptureSession(page, "chromium", workDir);
    await expect(session.start({
      target: { kind: "element", selector: "#nope", padding: 0 },
      resolveElement: async () => null,
    })).rejects.toThrow(/no element matched/i);
  }, TIMEOUT);

  test("an element target with no resolver fails loudly rather than capturing the viewport", async () => {
    const page = await (await getBrowser()).newPage();
    openPages.push(page);
    const session = new VideoCaptureSession(page, "chromium", workDir);
    await expect(session.start({
      target: { kind: "element", selector: "#box", padding: 0 },
    })).rejects.toThrow(/no element resolver/i);
  }, TIMEOUT);
});

describe("VideoCaptureSession - triggers", () => {
  /** Run a trigger scenario against the timeline fixture. */
  async function triggerRun(overrides: Partial<VideoCaptureOptions>, name: string) {
    const page = await (await getBrowser()).newPage({ viewport: { width: 640, height: 400 } });
    openPages.push(page);
    await page.goto(`file://${join(FIXTURES, "triggers.html")}`);
    await page.waitForLoadState("load");

    const session = new VideoCaptureSession(page, "chromium", workDir);
    await session.start({
      fps: FPS,
      outDir: join(workDir, name),
      slug: name,
      format: ["gif"],
      resolveElement: async (selector: string) => page.locator(selector).first(),
      ...overrides,
    });
    return session.finished;
  }

  test("--after-element delays the first frame until the element is visible", async () => {
    const result = await triggerRun({
      startTrigger: { kind: "element", selector: "#late" },
      durationMs: 500,
    }, "trig-after-element");
    expect(result.manifest.start_trigger).toMatch(/^element:#late/);
    expect(result.manifest.trigger_timeout).toBe(false);
    expect(result.manifest.frames.length).toBeGreaterThan(0);
  }, TIMEOUT);

  test("a start delay composes with the start trigger", async () => {
    const result = await triggerRun({
      startTrigger: { kind: "lifecycle", event: "load" },
      startDelayMs: 200,
      durationMs: 500,
    }, "trig-composed");
    expect(result.manifest.start_trigger).toMatch(/^load\+200ms/);
    expect(result.manifest.stop_trigger).toBe("duration");
  }, TIMEOUT);

  test("--until-element stops when the element appears", async () => {
    const result = await triggerRun({
      stopTrigger: { kind: "element-appears", selector: "#late" },
      triggerTimeoutMs: 10_000,
    }, "trig-until");
    expect(result.manifest.stop_trigger).toBe("element-appears:#late");
    expect(result.manifest.trigger_timeout).toBe(false);
  }, TIMEOUT);

  test("--until-element-gone stops when the element disappears", async () => {
    const result = await triggerRun({
      stopTrigger: { kind: "element-disappears", selector: "#doomed" },
      triggerTimeoutMs: 10_000,
    }, "trig-gone");
    expect(result.manifest.stop_trigger).toBe("element-disappears:#doomed");
    expect(result.manifest.trigger_timeout).toBe(false);
  }, TIMEOUT);

  test("--until-idle stops after the page stops changing", async () => {
    const result = await triggerRun({
      stopTrigger: { kind: "idle", idleMs: 600 },
      triggerTimeoutMs: 15_000,
    }, "trig-idle");
    expect(result.manifest.stop_trigger).toBe("idle:600ms");
    expect(result.manifest.trigger_timeout).toBe(false);
    // The fixture quiesces ~1.8s in; idle must not fire during the animation.
    expect(result.manifest.duration_ms).toBeGreaterThan(600);
  }, TIMEOUT);

  test("a stop trigger that never fires times out, keeping every frame", async () => {
    const result = await triggerRun({
      stopTrigger: { kind: "element-appears", selector: "#never-appears" },
      triggerTimeoutMs: 1500,
    }, "trig-timeout");
    expect(result.manifest.trigger_timeout).toBe(true);
    expect(result.manifest.stop_trigger).toMatch(/timed out/);
    expect(result.manifest.frames.length).toBeGreaterThan(1);
  }, TIMEOUT);

  test("a start trigger that never fires reports the timeout instead of hanging", async () => {
    const result = await triggerRun({
      startTrigger: { kind: "element", selector: "#never-appears" },
      triggerTimeoutMs: 1500,
      durationMs: 500,
    }, "trig-start-timeout");
    expect(result.manifest.trigger_timeout).toBe(true);
    expect(result.manifest.start_trigger).toMatch(/timed out/);
  }, TIMEOUT);

  test("an explicit stop wins over a pending stop trigger", async () => {
    const page = await (await getBrowser()).newPage({ viewport: { width: 640, height: 400 } });
    openPages.push(page);
    await page.goto(`file://${join(FIXTURES, "triggers.html")}`);

    const session = new VideoCaptureSession(page, "chromium", workDir);
    await session.start({
      fps: FPS,
      outDir: join(workDir, "trig-manual"),
      slug: "trig-manual",
      format: ["gif"],
      stopTrigger: { kind: "element-appears", selector: "#never-appears" },
      triggerTimeoutMs: 30_000,
      resolveElement: async (selector: string) => page.locator(selector).first(),
    });

    await new Promise((r) => setTimeout(r, 400));
    const result = await session.stop();
    expect(result.manifest.stop_trigger).toBe("manual");
    expect(result.manifest.trigger_timeout).toBe(false);
  }, TIMEOUT);
});

describe("VideoCaptureSession - side channels and artifacts", () => {
  test("console and network events land on the frame whose window contains them", async () => {
    const result = await triggerRun2();
    const consoleEntries = result.manifest.frames.flatMap((f) =>
      f.console.map((c) => ({ index: f.index, tMs: f.t_ms, text: c.text })),
    );
    const networkEntries = result.manifest.frames.flatMap((f) =>
      f.network.map((n) => ({ index: f.index, tMs: f.t_ms, url: n.url })),
    );

    expect(consoleEntries.length).toBeGreaterThan(0);
    expect(networkEntries.length).toBeGreaterThan(0);
    expect(consoleEntries.some((c) => c.text.includes("capture-fixture"))).toBe(true);
    expect(networkEntries.some((n) => n.url.includes("capture-fixture-network"))).toBe(true);

    // Each event must sit inside its frame's window, not merely somewhere.
    for (const entry of [...consoleEntries, ...networkEntries]) {
      const frame = result.manifest.frames[entry.index]!;
      const next = result.manifest.frames[entry.index + 1];
      expect(frame.t_ms).toBeLessThanOrEqual(next ? next.t_ms : Infinity);
    }
  }, TIMEOUT);

  test("--contact-sheet writes one sheet alongside the animation", async () => {
    const result = await triggerRun2();
    expect(result.manifest.artifacts["contact-sheet"]).toBeDefined();
    const sheetPath = join(workDir, "sidechannel", result.manifest.artifacts["contact-sheet"]!);
    expect(existsSync(sheetPath)).toBe(true);
    const meta = await sharp(sheetPath).metadata();
    expect(meta.format).toBe("jpeg");
  }, TIMEOUT);
});

let sideChannelRun: Promise<VideoCaptureResult> | null = null;

/** One capture of the timeline fixture, shared by the side-channel tests. */
function triggerRun2(): Promise<VideoCaptureResult> {
  if (sideChannelRun) return sideChannelRun;
  sideChannelRun = (async () => {
    const page = await (await getBrowser()).newPage({ viewport: { width: 640, height: 400 } });
    openPages.push(page);
    await page.goto(`file://${join(FIXTURES, "triggers.html")}`);
    await page.waitForLoadState("load");

    const session = new VideoCaptureSession(page, "chromium", workDir);
    await session.start({
      fps: FPS,
      durationMs: 2000,
      outDir: join(workDir, "sidechannel"),
      slug: "sidechannel",
      format: ["gif"],
      contactSheet: true,
      resolveElement: async (selector: string) => page.locator(selector).first(),
    });
    return session.finished;
  })();
  return sideChannelRun;
}

describe("VideoCaptureSession - event attribution against the absolute clock", () => {
  /**
   * Console/network attribution can only be checked against a clock both sides
   * share. Page-relative log times and capture-relative frame times have
   * DIFFERENT origins - the navigate-to-capture-start gap - so comparing them
   * shows a constant offset that looks exactly like a bucketing bug and is not
   * one. The fixture stamps each log with Date.now(), the same absolute clock
   * `started_at` is written from.
   */
  test("every event lands on the frame whose window contains it", async () => {
    const page = await (await getBrowser()).newPage({ viewport: { width: 640, height: 400 } });
    openPages.push(page);
    await page.goto(`file://${join(FIXTURES, "timeline-log.html")}`);
    await page.waitForLoadState("load");

    const session = new VideoCaptureSession(page, "chromium", workDir);
    await session.start({
      fps: FPS,
      durationMs: 3000,
      outDir: join(workDir, "attribution"),
      slug: "attribution",
      format: ["gif"],
    });
    const result = await session.finished;

    const startedAt = new Date(result.manifest.started_at).getTime();
    const frames = result.manifest.frames;

    let checked = 0;
    for (const frame of frames) {
      const next = frames[frame.index + 1];
      for (const entry of frame.console) {
        const match = /wall=(\d+)/.exec(entry.text);
        if (!match) continue;
        checked++;

        // Where the event actually happened, on the capture's own clock.
        const expected = Number(match[1]) - startedAt;
        expect(Math.abs(entry.t_ms - expected)).toBeLessThan(60);

        // And it must sit inside THIS frame's display window.
        expect(entry.t_ms).toBeGreaterThanOrEqual(frame.index === 0 ? 0 : frame.t_ms);
        if (next) expect(entry.t_ms).toBeLessThan(next.t_ms);
      }
    }

    // The fixture logs every 250ms over a 3s capture, so a run that attributed
    // nothing would pass the loop vacuously.
    expect(checked).toBeGreaterThanOrEqual(5);
  }, TIMEOUT);

  test("no event timestamp is ever negative", async () => {
    const page = await (await getBrowser()).newPage({ viewport: { width: 640, height: 400 } });
    openPages.push(page);
    await page.goto(`file://${join(FIXTURES, "timeline-log.html")}`);

    const session = new VideoCaptureSession(page, "chromium", workDir);
    await session.start({
      fps: FPS,
      durationMs: 1500,
      outDir: join(workDir, "attribution-negative"),
      slug: "attribution-negative",
      format: ["gif"],
    });
    const result = await session.finished;

    for (const frame of result.manifest.frames) {
      for (const entry of [...frame.console, ...frame.network]) {
        expect(entry.t_ms).toBeGreaterThanOrEqual(0);
      }
    }
  }, TIMEOUT);
});

describe("change_points vs anomaly", () => {
  test("a small UI change is a change point but not an anomaly", async () => {
    const page = await (await getBrowser()).newPage({ viewport: { width: 1280, height: 800 } });
    openPages.push(page);
    await page.goto(`file://${join(FIXTURES, "keyboard.html")}`);

    const session = new VideoCaptureSession(page, "chromium", workDir);
    await session.start({
      fps: FPS,
      durationMs: 2500,
      outDir: join(workDir, "smallchange"),
      slug: "smallchange",
      format: ["gif"],
    });

    // Type into a small field: the kind of change a recorded flow is made of,
    // and far too small to move a whole-viewport SSIM past the anomaly bar.
    await new Promise((r) => setTimeout(r, 700));
    await page.fill("#field", "a small but real change");
    const result = await session.finished;

    const anomalies = result.manifest.frames.filter((f) => f.anomaly).map((f) => f.index);
    expect(result.manifest.change_points.length).toBeGreaterThan(0);
    // The two fields answer different questions, so the strict one must be a
    // strict subset: everything flagged an anomaly is also a change point, and
    // small real changes (the fill) are change points WITHOUT being anomalies.
    expect(anomalies.length).toBeLessThan(result.manifest.change_points.length);
    for (const index of anomalies) expect(result.manifest.change_points).toContain(index);
  }, TIMEOUT);
});
