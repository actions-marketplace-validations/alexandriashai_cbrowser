/**
 * Auto-Capture Tests (ISC-34)
 *
 * An existing test-suite run invoked with capture enabled must emit a capture
 * with no separate start/stop call, and the manifest must reflect the run's
 * viewport.
 *
 * The suite runs against a local file:// fixture — no network, no API key.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCaptureOptions,
  finishAutoCapture,
  startAutoCapture,
  DEFAULT_STOP_TIMEOUT_MS,
} from "../src/recording/auto-capture.js";
import { getPaths } from "../src/config.js";
import { chromium } from "playwright";
import { parseManifest } from "../src/recording/types.js";
import { runNLTestSuite } from "../src/testing/nl-test-suite.js";

const workDir = mkdtempSync(join(tmpdir(), "cbrowser-autocapture-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A page that repaints on a timer, so an event-driven recorder gets frames. */
function fixturePage(): string {
  const path = join(workDir, "animated.html");
  writeFileSync(
    path,
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
     <title>Capture Fixture</title></head>
     <body style="margin:0;background:#111">
       <h1 id="h" style="color:#fff;font:700 48px sans-serif">Frame 0</h1>
       <script>
         let n = 0;
         setInterval(() => {
           n++;
           document.getElementById("h").textContent = "Frame " + n;
           document.body.style.background = "hsl(" + (n * 17 % 360) + ",60%,20%)";
         }, 60);
       </script>
     </body></html>`,
  );
  return `file://${path}`;
}

describe("resolveCaptureOptions", () => {
  test("normalises the option union", () => {
    expect(resolveCaptureOptions(undefined)).toBeNull();
    expect(resolveCaptureOptions(false)).toBeNull();
    expect(resolveCaptureOptions(true)).toEqual({});
    expect(resolveCaptureOptions({ fps: 5 })).toEqual({ fps: 5 });
  });
});

describe("finishAutoCapture", () => {
  test("returns undefined when no capture was started", async () => {
    expect(await finishAutoCapture(null)).toBeUndefined();
  });

  test("a wedged stop fails fast and loudly instead of hanging the run", async () => {
    // A session whose stop() never settles — the failure mode that turned a
    // 16s suite into a 239s one. The wrapper must bound it, not wait it out.
    const wedged = {
      stop: () => new Promise(() => { /* never resolves */ }),
      status: () => ({
        state: "recording" as const,
        slug: "wedged-capture",
        outDir: "/tmp/wedged-capture",
        frames: 42,
        elapsedMs: 5000,
        captureMethod: "cdp-screencast" as const,
      }),
    };

    const started = Date.now();
    const result = await finishAutoCapture(wedged as never, 200);
    const elapsed = Date.now() - started;

    // Fast: bounded by the timeout, not by the caller's patience.
    expect(elapsed).toBeLessThan(5000);

    // Loud: a diagnostic naming the timeout and the state it was stuck in.
    expect(result).toBeDefined();
    expect(result!.error).toMatch(/timed out after 200ms/);
    expect(result!.error).toMatch(/frames=42/);
    expect(result!.error).toMatch(/state=recording/);
    expect(result!.error).toContain("/tmp/wedged-capture");
    // The frames are still on disk — the diagnostic says where.
    expect(result!.error).toMatch(/Frames are still on disk/);
    expect(result!.frames).toBe(42);
  });

  test("a slow-but-finishing stop is not cut off early", async () => {
    const slow = {
      stop: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return {
          manifestPath: "/tmp/slow/manifest.json",
          manifest: { slug: "slow", frames: [], actual_fps: 0, duration_ms: 0, artifacts: {} },
          encodeErrors: {},
        };
      },
      status: () => ({
        state: "stopped" as const,
        slug: "slow",
        outDir: "/tmp/slow",
        frames: 0,
        elapsedMs: 150,
        captureMethod: "cdp-screencast" as const,
      }),
    };

    const result = await finishAutoCapture(slow as never, 5000);
    expect(result!.error).toBeUndefined();
    expect(result!.manifestPath).toBe("/tmp/slow/manifest.json");
  });

  test("the default bound is set and finite", () => {
    expect(DEFAULT_STOP_TIMEOUT_MS).toBe(30_000);
    expect(Number.isFinite(DEFAULT_STOP_TIMEOUT_MS)).toBe(true);
  });
});

describe("production output location", () => {
  test("defaults to videosDir, never os.tmpdir()", async () => {
    // recordingsDir is the ACTION-recording feature's .json store; videosDir is
    // the declared home for captured video. A capture in tmp is one reboot from
    // gone, so this asserts the real default with a real session.
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
      await page.setContent("<!doctype html><html lang='en'><body>x</body></html>");

      const session = await startAutoCapture(page, true, "location-probe");
      expect(session).not.toBeNull();

      const paths = getPaths();
      const outDir = session!.status().outDir;
      expect(outDir.startsWith(paths.videosDir)).toBe(true);
      expect(outDir.startsWith(tmpdir())).toBe(false);
      expect(outDir).not.toContain(paths.recordingsDir);

      // Session-scoped: ~/.cbrowser/videos/<sessionId>/<slug>/, matching the CLI
      // and MCP layout. Without the session segment two concurrent captures that
      // pick the same slug would interleave frames into one directory.
      expect(outDir.startsWith(join(paths.videosDir, paths.sessionId))).toBe(true);
      expect(outDir).toContain(paths.sessionId);

      await finishAutoCapture(session);
      // This probe must use the real configured paths to assert the production
      // default, so it cleans up after itself rather than leaving a capture in
      // the user's ~/.cbrowser.
      rmSync(outDir, { recursive: true, force: true });
    } finally {
      await browser.close();
    }
  }, 120000);
});

describe("test suite auto-capture (ISC-34)", () => {
  test("a suite run with capture enabled emits a capture, no start/stop calls", async () => {
    const url = fixturePage();
    const outDir = join(workDir, "suite-capture");

    const result = await runNLTestSuite(
      {
        name: "autocapture fixture",
        tests: [
          {
            name: "visits the fixture",
            steps: [
              { instruction: `navigate to ${url}`, action: "navigate", target: url },
              // `value` is in SECONDS (parseFloat(value) * 1000), not ms.
              // 2s at 10fps is ~20 frames — ample to prove the wrap without
              // padding the suite runtime.
              { instruction: "wait 2", action: "wait", value: "2" },
            ],
          },
        ],
      },
      {
        headless: true,
        screenshotOnFailure: false,
        // The whole point: one flag, no capture_start/capture_stop.
        capture: { fps: 10, format: ["gif"], outDir, name: "suite-capture" },
      },
    );

    expect(result.capture).toBeDefined();
    expect(result.capture!.error).toBeUndefined();
    expect(result.capture!.manifestPath).toBeTruthy();
    expect(existsSync(result.capture!.manifestPath!)).toBe(true);
    expect(result.capture!.frames).toBeGreaterThan(1);

    const manifest = parseManifest(
      await Bun.file(result.capture!.manifestPath!).text(),
    );

    // The manifest must reflect the run's viewport.
    expect(manifest.target.kind).toBe("viewport");
    expect(manifest.viewport.width).toBeGreaterThan(0);
    expect(manifest.viewport.height).toBeGreaterThan(0);
    expect(manifest.output_dims.width).toBeGreaterThan(0);
    expect(manifest.frames.length).toBe(result.capture!.frames);
    expect(manifest.engine).toBe("chromium");

    // The suite result itself is unaffected by being recorded.
    expect(result.summary.total).toBe(1);
  }, 180000);

  test("a suite run without the flag produces no capture", async () => {
    const url = fixturePage();
    const result = await runNLTestSuite(
      {
        name: "no capture",
        tests: [
          {
            name: "visits the fixture",
            steps: [{ instruction: `navigate to ${url}`, action: "navigate", target: url }],
          },
        ],
      },
      { headless: true, screenshotOnFailure: false },
    );

    expect(result.capture).toBeUndefined();
    expect(result.summary.total).toBe(1);
  }, 120000);
});
