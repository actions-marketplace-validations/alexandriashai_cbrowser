/**
 * ISC-96: the cognitive-journey `--capture` flag actually records.
 *
 * The flag was documented but its execution path had never run — the exact
 * shape of the eight accepted-and-ignored defects this project kept hitting. A
 * cognitive journey normally spends Anthropic credit per step, which is not a
 * thing a test may do, so this drives the REAL `runCognitiveJourney` through
 * its `decisionProvider` seam with a fake decider: no network, no spend, one
 * synthetic step, then it asserts a manifest landed.
 *
 * This exercises the whole path the flag reaches — options.capture ->
 * startAutoCapture -> finishAutoCapture -> manifest — rather than the capture
 * functions in isolation, so it catches a broken wiring hop, not just a broken
 * encoder.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runCognitiveJourney } from "../src/cognitive/index.js";
import { parseManifest } from "../src/recording/types.js";

const FIXTURE = `file://${resolve(import.meta.dir, "fixtures", "animating.html")}`;
const workDir = mkdtempSync(join(tmpdir(), "journey-capture-"));

// runCognitiveJourney refuses to start without a key. A fake one lets the
// Anthropic client construct; the fake decisionProvider means it is never used
// for a real call, and the post-journey eval is try/catch-guarded so a rejected
// request can't fail the test. Saved and restored so the suite is unaffected.
const priorKey = process.env.ANTHROPIC_API_KEY;

afterAll(() => {
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = priorKey;
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe("cognitive-journey --capture (ISC-96)", () => {
  test("a journey with capture enabled writes a manifest, with no API spend", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-nospend-test";
    let decideCalls = 0;

    const result = await runCognitiveJourney({
      persona: "first-timer",
      goal: "find the thing",
      startUrl: FIXTURE,
      maxSteps: 1,
      maxTime: 8,
      headless: true,
      capture: { name: "journey-capture", fps: 8, outDir: join(workDir, "cap") },
      // The seam that makes this affordable: a fake decider means zero LLM
      // calls. A key is still set below so the Anthropic client constructs;
      // the post-journey eval is wrapped in try/catch inside the journey, so a
      // rejected fake-key request cannot fail this test.
      decisionProvider: {
        decide: async () => {
          decideCalls++;
          return JSON.stringify({ action: "done", reasoning: "stop", monologue: "found it" });
        },
      },
    });

    // The per-step LLM was never called for real.
    expect(decideCalls).toBeGreaterThan(0);

    // The flag did something: a capture result came back, populated not errored.
    expect(result.capture).toBeDefined();
    expect(result.capture!.error).toBeUndefined();
    expect(result.capture!.manifestPath).toBeDefined();
    expect(result.capture!.frames).toBeGreaterThan(0);

    // And the manifest on disk is real and valid.
    const manifest = parseManifest(readFileSync(result.capture!.manifestPath!, "utf-8"));
    expect(manifest.frames.length).toBeGreaterThan(0);
    expect(manifest.capture_method).toBe("cdp-screencast");
  }, 60_000);
});
