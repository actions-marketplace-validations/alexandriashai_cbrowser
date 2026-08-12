/**
 * CI must run the split runner, not the single-process union.
 *
 * `test.yml` ran `bun test --coverage` — the whole suite in one process, which
 * is exactly the configuration `scripts/test-split.sh` exists to avoid. Browser-
 * launching files accumulate something across a long-lived `bun test` until a
 * launch hangs, and which test times out is random.
 *
 * release.yml's own comments name this hazard ("the exact configuration
 * scripts/test-split.sh exists to avoid") while test.yml kept doing it, so the
 * lesson was written down and not applied one file over. This test applies it.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */
import { describe, test, expect } from "bun:test";

const wf = async (name: string) =>
  await Bun.file(new URL(`../.github/workflows/${name}`, import.meta.url)).text();
/** Strip `#` comments so a comment mentioning a command is not read as running it. */
const cmds = (s: string) =>
  s.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("the Tests workflow uses the split runner", () => {
  test("it invokes `bun run test`, which is test-split.sh", async () => {
    const c = cmds(await wf("test.yml"));
    expect(c).toContain("run: bun run test");
  });

  test("it does NOT invoke the single-process union", async () => {
    // `bun test` and `bun run test` are different commands. The first is the
    // union; the second is the package script, which is the split.
    const c = cmds(await wf("test.yml"));
    expect(c).not.toMatch(/run:\s*bun test(\s|$)/);
    expect(c).not.toContain("bun test --coverage");
  });

  test("the test step is bounded", async () => {
    // A hang must fail by name rather than eat the runner ceiling and be
    // cancelled — a cancelled job names no culprit.
    const c = cmds(await wf("test.yml"));
    const step = c.slice(c.indexOf("run: bun run test"));
    expect(step).toContain("timeout-minutes:");
  });
});

describe("the package script still points at the split", () => {
  test("`test` is test-split.sh", async () => {
    const pkg = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text());
    expect(pkg.scripts.test).toContain("test-split.sh");
  });

  test("the single-process form is kept, but under a name that says so", async () => {
    // Deleting it would remove a useful local tool. Naming it `test:single`
    // means nobody reaches for it by accident.
    const pkg = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text());
    expect(pkg.scripts["test:single"]).toBe("bun test");
  });
});

describe("the split runner and the release gate agree about the hanging files", () => {
  const read = async (rel: string) =>
    await Bun.file(new URL(rel, import.meta.url)).text();

  /** Files test-gate.sh excludes from the release gate. */
  const quarantined = (src: string) =>
    new Set((src.match(/QUARANTINED='([^']+)'/)?.[1] ?? "").split("|").filter(Boolean));

  /** Files test-split.sh runs in their own process. */
  const isolated = (src: string) =>
    new Set([...(src.match(/ISOLATED_FILES=\(([\s\S]*?)\n\)/)?.[1] ?? "")
      .matchAll(/"(tests\/[^"]+)"/g)].map((m) => m[1]));

  test("every gate-quarantined file is isolated by the split", async () => {
    // The gate's list IS the curated "does real browser work and hangs in a
    // shared process" set. The split may run more files than the gate, but it
    // must never run one of THOSE in the shared pass.
    //
    // They disagreed on four files, and CI proved it the first time the split
    // ran there: recording-autocapture timed out at exactly 180000.96ms in
    // pass 1. It passes on a fast dev box, which is why the disagreement
    // survived a full green local run.
    const splitSet = isolated(await read("../scripts/test-split.sh"));
    const missing = [...quarantined(await read("../scripts/test-gate.sh"))]
      .filter((f) => !splitSet.has(f));
    expect(missing).toEqual([]);
  });

  test("both lists are non-empty — this cannot pass by parsing nothing", async () => {
    expect(quarantined(await read("../scripts/test-gate.sh")).size).toBeGreaterThan(5);
    expect(isolated(await read("../scripts/test-split.sh")).size).toBeGreaterThan(9);
  });

  test("the split still runs MORE than the gate excludes", async () => {
    // Isolation is not exclusion. Every quarantined file must still appear as
    // something the split executes, just in its own process.
    const split = await read("../scripts/test-split.sh");
    for (const f of quarantined(await read("../scripts/test-gate.sh"))) {
      expect(split, `${f} must still be run by the split`).toContain(f);
    }
  });
});

describe("the runner never executes build output", () => {
  const read = async (rel: string) =>
    await Bun.file(new URL(rel, import.meta.url)).text();

  test("test discovery excludes dist/", async () => {
    // dist/ is gitignored, so anything found there runs HERE and not on CI.
    // That divergence is not theoretical: dist/security/audit-wrapper.test.js
    // was the whole 1298-vs-1284 gap between this box and the runner, and it
    // was a stale compiled duplicate of tests/audit-wrapper.test.ts built from
    // src/security/audit-wrapper.test.ts, a path that no longer exists.
    //
    // A test suite whose membership depends on whether someone has run a build
    // is not a suite, it is a coincidence.
    const split = await read("../scripts/test-split.sh");
    expect(split).toContain("-not -path './dist/*'");
  });

  test("the release gate searches source directories, not the repo root", async () => {
    // The gate never had the dist problem because it searches `tests src`.
    // Pinned so a future edit does not "helpfully" widen it to `.`.
    const gate = await read("../scripts/test-gate.sh");
    expect(gate).toMatch(/find\s+tests\s+src\b/);
  });

  test("the discovery command, as written, returns nothing from dist/", async () => {
    // End-to-end rather than by inspection: pull the actual find(1) invocation
    // out of the script and run it. A previous version of this test asserted
    // expect(true).toBe(true) after a console.warn -- decorative, could not
    // fail, and would have reported success while dist crept back in.
    const split = await read("../scripts/test-split.sh");
    const find = split.match(/find \. \\\([\s\S]*?\| sort\)/)?.[0];
    expect(find, "the find command must be locatable in the script").toBeTruthy();

    const cmd = find!.replace(/^mapfile[^<]*< <\(/, "").replace(/\)$/, "");
    const proc = Bun.spawnSync(["bash", "-c", cmd], {
      cwd: new URL("..", import.meta.url).pathname,
    });
    const files = new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean);

    expect(files.length).toBeGreaterThan(50);          // it really discovered a suite
    expect(files.filter((f) => f.startsWith("dist/"))).toEqual([]);
  });
});

describe("the isolated runs retry once, loudly", () => {
  const split = async () =>
    await Bun.file(new URL("../scripts/test-split.sh", import.meta.url)).text();

  test("a failed isolated run is retried", async () => {
    expect(await split()).toContain("Retrying ONCE");
  });

  test("a file that fails twice still fails the run", async () => {
    // The point of a retry is to absorb a flake, not to make red impossible.
    const src = await split();
    expect(src).toContain("failed TWICE");
    expect(src).toMatch(/FAILED\+=/);
    expect(src).toMatch(/exit 1/);
  });

  test("a pass-on-retry is REPORTED, not swallowed", async () => {
    // A retry that hides the flake rate is the same silent-degradation defect
    // this suite keeps finding in the product. "Green" and "green after a
    // retry" must never render as the same report.
    const src = await split();
    expect(src).toContain("PASSED ONLY ON RETRY");
    expect(src).toMatch(/RETRIED\+=/);
  });

  test("pass 1 is NOT retried", async () => {
    // Ordinary deterministic tests. A retry there would hide a real
    // regression, which is the opposite of what this buys.
    const src = await split();
    const passOne = src.slice(src.indexOf("bun test \"${REST[@]}\""));
    const beforeIsolated = passOne.slice(0, passOne.indexOf("for iso in"));
    expect(beforeIsolated).not.toContain("Retrying");
  });

  test("the retry is scoped to the isolated list only", async () => {
    // Every retried file must be one the release gate also quarantines, so the
    // set of "allowed to be flaky" files cannot quietly grow.
    const src = await split();
    const retryBlock = src.slice(src.indexOf("for iso in"));
    expect(retryBlock).toContain("${ISOLATED_FILES[@]}");
  });
});
