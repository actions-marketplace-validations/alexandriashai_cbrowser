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
