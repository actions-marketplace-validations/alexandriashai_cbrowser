/**
 * Journey Trace Tests
 *
 * Tests for per-step trace recording and LLM-free deterministic replay.
 * No network, no API key — decisions come from a FakeProvider, and the
 * writer is pointed at a temp dataDir so nothing touches ~/.cbrowser.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  JourneyTraceWriter,
  TraceReplayProvider,
  TraceDivergenceError,
  hashPageState,
} from "../src/cognitive/journey-trace.js";
import type {
  DecisionProvider,
  StepContext,
} from "../src/cognitive/journey-trace.js";

/** Deterministic decision source — no network, no API key. */
class FakeProvider implements DecisionProvider {
  calls: StepContext[] = [];
  async decide(ctx: StepContext): Promise<string> {
    this.calls.push(ctx);
    return `{"monologue": "fake decision for step ${ctx.stepIndex}", "action": "scroll:down"}`;
  }
}

/** Build a StepContext the way runCognitiveJourney does. */
function makeCtx(
  stepIndex: number,
  url: string,
  pageContent: string
): StepContext {
  return {
    stepIndex,
    pageStateHash: hashPageState(url, pageContent),
    persona: "first-timer",
    systemPrompt: "You are a cognitive persona.",
    messages: [{ role: "user", content: `step ${stepIndex} prompt` }],
  };
}

/**
 * Mirror of the journey-loop wiring: for each page state, ask the provider
 * for a decision and record it if tracing is on. Returns the decisions.
 */
async function runFakeJourney(
  provider: DecisionProvider,
  pages: Array<{ url: string; content: string }>,
  writer: JourneyTraceWriter | null
): Promise<string[]> {
  const decisions: string[] = [];
  for (let step = 1; step <= pages.length; step++) {
    const { url, content } = pages[step - 1];
    const ctx = makeCtx(step, url, content);
    const decision = await provider.decide(ctx);
    decisions.push(decision);
    if (writer) {
      writer.record({
        step,
        pageStateHash: ctx.pageStateHash,
        persona: ctx.persona,
        decision,
        ts: new Date().toISOString(),
      });
    }
  }
  return decisions;
}

const PAGES = [
  { url: "https://example.com/", content: "Welcome — Sign up | Pricing" },
  { url: "https://example.com/pricing", content: "Pricing — $10/mo | $99/yr" },
  { url: "https://example.com/signup", content: "Create your account" },
];

describe("JourneyTrace", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cb-trace-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("JourneyTraceWriter", () => {
    test("records steps in order with hashed page state", async () => {
      const writer = new JourneyTraceWriter({ journeyId: "j1", dataDir });
      await runFakeJourney(new FakeProvider(), PAGES, writer);

      expect(writer.filePath).toBe(join(dataDir, "traces", "j1.jsonl"));
      const lines = readFileSync(writer.filePath, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines.length).toBe(3);
      expect(lines.map((l) => l.step)).toEqual([1, 2, 3]);
      for (let i = 0; i < 3; i++) {
        expect(lines[i].pageStateHash).toBe(
          hashPageState(PAGES[i].url, PAGES[i].content)
        );
        expect(lines[i].pageStateHash).toMatch(/^[a-f0-9]{64}$/);
        expect(lines[i].persona).toBe("first-timer");
        expect(lines[i].decision).toContain(`fake decision for step ${i + 1}`);
        expect(typeof lines[i].ts).toBe("string");
      }
    });

    test("tracing off means zero file writes", async () => {
      // Mirrors the wiring: options.trace falsy → no writer is constructed.
      await runFakeJourney(new FakeProvider(), PAGES, null);
      expect(readdirSync(dataDir)).toEqual([]);
      expect(existsSync(join(dataDir, "traces"))).toBe(false);
    });

    test("redacts secrets and raw HTML from the trace file", () => {
      const writer = new JourneyTraceWriter({ journeyId: "redact", dataDir });
      // Page state containing raw HTML + a secret is stored ONLY as a hash.
      const dirtyPageState = "<html><body>sk-ant-abc123456789</body></html>";
      writer.record({
        step: 1,
        pageStateHash: hashPageState("https://example.com/", dirtyPageState),
        persona: "first-timer",
        // Decision echoing both a secret and markup — must be scrubbed.
        decision:
          'I found the key sk-ant-abc123456789 inside <html><body class="x">the page</body></html>',
        ts: new Date().toISOString(),
      });

      const raw = readFileSync(writer.filePath, "utf-8");
      expect(raw).not.toContain("sk-ant-abc123456789");
      expect(raw).not.toContain("<html>");
      expect(raw).not.toContain("<body");
      // The non-markup, non-secret text survives.
      expect(raw).toContain("the page");
      expect(raw).toContain("[REDACTED]");
    });
  });

  describe("TraceReplayProvider", () => {
    test("replay returns identical decisions, deterministically (twice)", async () => {
      const writer = new JourneyTraceWriter({ journeyId: "replay", dataDir });
      const recorded = await runFakeJourney(new FakeProvider(), PAGES, writer);

      // Two independent replays over the same page states — both must match
      // the recorded run exactly, with no provider state carried between.
      for (let run = 0; run < 2; run++) {
        const replay = new TraceReplayProvider(writer.filePath);
        const replayed = await runFakeJourney(replay, PAGES, null);
        expect(replayed).toEqual(recorded);
      }
    });

    test("divergence throws TraceDivergenceError at the diverging step", async () => {
      const writer = new JourneyTraceWriter({ journeyId: "diverge", dataDir });
      await runFakeJourney(new FakeProvider(), PAGES, writer);

      const replay = new TraceReplayProvider(writer.filePath);
      // Step 1 matches the recording...
      await replay.decide(makeCtx(1, PAGES[0].url, PAGES[0].content));
      // ...but the page changed at step 2 — replay must STOP, not continue.
      let err: unknown;
      try {
        await replay.decide(makeCtx(2, PAGES[1].url, "Pricing — $20/mo NEW"));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TraceDivergenceError);
      expect((err as TraceDivergenceError).divergedAtStep).toBe(2);
      expect((err as TraceDivergenceError).expectedHash).toBe(
        hashPageState(PAGES[1].url, PAGES[1].content)
      );
    });

    test("running past the end of the trace throws with the correct step", async () => {
      const writer = new JourneyTraceWriter({ journeyId: "short", dataDir });
      await runFakeJourney(new FakeProvider(), PAGES.slice(0, 2), writer);

      const replay = new TraceReplayProvider(writer.filePath);
      let err: unknown;
      try {
        await replay.decide(makeCtx(3, PAGES[2].url, PAGES[2].content));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TraceDivergenceError);
      expect((err as TraceDivergenceError).divergedAtStep).toBe(3);
    });

    test("missing trace file throws at construction", () => {
      expect(() => new TraceReplayProvider(join(dataDir, "nope.jsonl"))).toThrow(
        /Trace file not found/
      );
    });
  });
});
