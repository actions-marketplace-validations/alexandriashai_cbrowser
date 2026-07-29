/**
 * Release pipeline invariants.
 *
 * Releases were cancelled on 2026-07-29 (bbd2743) after the job hit its
 * 30-minute ceiling. The gate step had PASSED; the time went into
 * `npx release-it`, because `.release-it.json`'s `before:init` hook ran
 * `bun test || true` — a third test invocation which:
 *
 *   - ran the whole suite in ONE process, the exact configuration
 *     `scripts/test-split.sh` exists to avoid (measured: only the union of all
 *     files fails, always at exactly 60000ms, a different test each run);
 *   - was unbounded, because hooks run INSIDE the release step and no step
 *     timeout reached them;
 *   - discarded its own result via `|| true`, so it could never prevent a bad
 *     release. It could only cost time.
 *
 * Two structural lessons are pinned here, because both are the kind of thing
 * that reads as fine in a diff:
 *
 * 1. A test run whose result is thrown away is not a safety measure.
 * 2. Step timeouts must fire BEFORE the job cap. A step timeout names the
 *    culprit; a job cap cancels the run and names nothing — which is why this
 *    looked like "the release is broken" rather than "one step hung".
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..");
const releaseIt = JSON.parse(readFileSync(join(ROOT, ".release-it.json"), "utf8"));
const workflow = parseYaml(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"));
const job = workflow.jobs.release;
const steps: Array<Record<string, any>> = job.steps;

const stepNamed = (fragment: string) =>
  steps.filter((s) => String(s.name ?? "").toLowerCase().includes(fragment.toLowerCase()));

describe("release-it hooks", () => {
  test("no hook runs the test suite", () => {
    const hooks = Object.values(releaseIt.hooks ?? {}).flat().map(String);
    const testish = hooks.filter((h) => /\bbun test\b|\bnpm test\b|\btest:/.test(h));
    expect(testish).toEqual([]);
  });

  test("no hook swallows its own exit code", () => {
    // `|| true` is the shape that made the old hook pointless: it ran, it cost
    // time, and its verdict was discarded.
    const hooks = Object.values(releaseIt.hooks ?? {}).flat().map(String);
    expect(hooks.filter((h) => h.includes("|| true"))).toEqual([]);
  });

  test("the build still runs before publish", () => {
    // Removing the test hook must not also remove the artifact guarantee.
    const before = (releaseIt.hooks?.["before:init"] ?? []).map(String);
    expect(before.some((h: string) => h.includes("build"))).toBe(true);
  });
});

describe("timeout ordering — steps must fail before the job cap", () => {
  test("the release steps are individually bounded", () => {
    const releaseSteps = steps.filter((s) => String(s.run ?? "").includes("release-it"));
    expect(releaseSteps.length).toBeGreaterThan(0);
    for (const s of releaseSteps) {
      expect({ step: s.name, timeout: s["timeout-minutes"] }).toEqual({
        step: s.name,
        timeout: expect.any(Number),
      });
    }
  });

  test("the job cap sits above the worst reachable step total", () => {
    // The two release steps are mutually exclusive via `if:`, so the worst case
    // is gate + one release + setup, not the sum of every ceiling.
    const gate = stepNamed("gate")[0]?.["timeout-minutes"] ?? 0;
    const worstRelease = Math.max(
      ...steps.filter((s) => String(s.run ?? "").includes("release-it"))
        .map((s) => s["timeout-minutes"] ?? 0),
    );
    expect(job["timeout-minutes"]).toBeGreaterThan(gate + worstRelease);
  });
});

describe("the gate stays a gate", () => {
  test("it exists and runs the gate script", () => {
    const gate = stepNamed("gate");
    expect(gate.length).toBe(1);
    expect(String(gate[0].run)).toContain("test:gate");
  });

  test("it is blocking — no continue-on-error, no swallowed exit code", () => {
    const gate = stepNamed("gate")[0];
    expect(gate["continue-on-error"]).toBeUndefined();
    expect(String(gate.run)).not.toContain("|| true");
  });

  test("it is bounded, so a hang fails rather than costs the job", () => {
    expect(typeof stepNamed("gate")[0]["timeout-minutes"]).toBe("number");
  });
});

describe("release-skip guard", () => {
  test("a chore: release commit does not trigger another release", () => {
    // Without this the release commit re-triggers the workflow forever.
    expect(String(job.if)).toContain("chore: release");
  });
});
