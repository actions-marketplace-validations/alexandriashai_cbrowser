/**
 * `npm uninstall -g cbrowser` removes the package and nothing it wrote.
 *
 * Measured on one real install: 403MB under ~/.cbrowser, including an Anthropic
 * API key, an IPRoyal proxy password, and 253MB of Chrome profile data holding
 * live session cookies for every site the user had tested — plus a Claude skill
 * installed into ~/.claude/skills, which is outside the package entirely.
 *
 * Every test here runs against a temporary data dir. Nothing touches a real
 * ~/.cbrowser, which matters more than usual for a module whose job is deleting
 * things.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  planUninstall,
  executeUninstall,
  renderPlan,
  directorySize,
  formatBytes,
} from "../src/uninstall.js";

let dir: string;
/**
 * The skill directory is injected too. It is NOT optional: on the first run of
 * this file it defaulted to the real ~/.claude/skills/CBrowser and the
 * execution tests deleted it off this machine. Restored from git; the module
 * now takes the path.
 */
let skillDir: string;

/** A data dir shaped like a real one. */
function populate(root: string) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), '{"anthropicApiKey":"redacted"}');
  writeFileSync(join(root, "geo-proxy.json"), '{"basePassword":"redacted"}');
  mkdirSync(join(root, "accounts"), { recursive: true });
  writeFileSync(join(root, "accounts", "acct.json"), "{}");
  mkdirSync(join(root, "browser-state", "Default"), { recursive: true });
  writeFileSync(join(root, "browser-state", "Default", "Cookies"), "x".repeat(2048));
  mkdirSync(join(root, "har"), { recursive: true });
  writeFileSync(join(root, "har", "capture.har"), "{}");
  mkdirSync(join(root, "audit-screenshots"), { recursive: true });
  writeFileSync(join(root, "audit-screenshots", "shot.png"), "x".repeat(512));
}

const plan = (o: { keepConfig?: boolean } = {}) =>
  planUninstall({ dataDir: dir, skillDir, keepConfig: o.keepConfig });
const paths = (o: { keepConfig?: boolean } = {}) => plan(o).targets.map((t) => t.path);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cbrowser-uninstall-"));
  skillDir = join(mkdtempSync(join(tmpdir(), "cbrowser-skill-")), "CBrowser");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# skill");
  populate(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(skillDir, { recursive: true, force: true });
});

describe("the plan finds what npm leaves behind", () => {
  test("the API key is a target", () => {
    expect(paths()).toContain(join(dir, "config.json"));
  });

  test("the proxy password is a target", () => {
    expect(paths()).toContain(join(dir, "geo-proxy.json"));
  });

  test("the cookie jar is a target", () => {
    expect(paths()).toContain(join(dir, "browser-state"));
  });

  test("HAR captures are a target — they carry auth headers", () => {
    expect(paths()).toContain(join(dir, "har"));
  });

  test("capture directories nobody enumerated are still found", () => {
    // Discovered by reading the data dir rather than from a hand-kept list,
    // so a capture type added later is not silently left on disk. A hand-kept
    // list is exactly how the WCAG criteria list went stale.
    mkdirSync(join(dir, "some-future-capture-type"), { recursive: true });
    writeFileSync(join(dir, "some-future-capture-type", "f"), "x");
    expect(paths()).toContain(join(dir, "some-future-capture-type"));
  });

  test("a path that does not exist is not listed", () => {
    // "sessions" is in the spec but absent from this fixture.
    expect(paths()).not.toContain(join(dir, "sessions"));
  });

  test("nothing is deleted by planning", () => {
    plan();
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(existsSync(join(dir, "browser-state"))).toBe(true);
  });
});

describe("credentials lead the report", () => {
  test("credentials sort ahead of artifacts", () => {
    const kinds = plan().targets.map((t) => t.kind);
    expect(kinds.indexOf("credential")).toBeLessThan(kinds.lastIndexOf("artifact"));
  });

  test("sensitive items are counted", () => {
    // config, geo-proxy, accounts, browser-state, har
    expect(plan().sensitiveCount).toBe(5);
  });

  test("the report names credentials and says they survive npm uninstall", () => {
    const text = renderPlan(plan(), true);
    expect(text).toContain("CREDENTIAL");
    expect(text).toContain("npm uninstall");
  });

  test("a dry run says so and says nothing was removed", () => {
    const text = renderPlan(plan(), true);
    expect(text).toContain("dry run");
    expect(text).toContain("Nothing has been removed");
  });

  test("an empty machine reports nothing to do rather than an empty list", () => {
    const empty = mkdtempSync(join(tmpdir(), "cbrowser-empty-"));
    try {
      // Both roots empty, or this asserts nothing about an empty machine.
      const noSkill = join(empty, "no-skill");
      expect(
        renderPlan(planUninstall({ dataDir: empty, skillDir: noSkill }), true),
      ).toContain("Nothing to remove");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("--keep-config", () => {
  test("retains the API key and proxy config", () => {
    const kept = paths({ keepConfig: true });
    expect(kept).not.toContain(join(dir, "config.json"));
    expect(kept).not.toContain(join(dir, "geo-proxy.json"));
  });

  test("still removes cookies — a session is not configuration", () => {
    // The reinstall case wants settings back, not somebody's logged-in
    // sessions.
    expect(paths({ keepConfig: true })).toContain(join(dir, "browser-state"));
  });

  test("still removes saved account credentials", () => {
    expect(paths({ keepConfig: true })).toContain(join(dir, "accounts"));
  });
});

describe("executing", () => {
  test("targets are gone afterwards", () => {
    const result = executeUninstall(plan());
    expect(existsSync(join(dir, "config.json"))).toBe(false);
    expect(existsSync(join(dir, "browser-state"))).toBe(false);
    expect(result.failed).toEqual([]);
  });

  test("removal is verified, not assumed", () => {
    // rmSync with force:true does not throw for a path it could not remove,
    // so a report built from "no exception" would call a still-present
    // credential deleted.
    const result = executeUninstall(plan());
    for (const p of result.removed) {
      expect(existsSync(p), `${p} reported removed`).toBe(false);
    }
  });

  test("kept config survives execution", () => {
    executeUninstall(plan({ keepConfig: true }));
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(existsSync(join(dir, "browser-state"))).toBe(false);
  });

  test("bytes freed is reported and non-zero", () => {
    expect(executeUninstall(plan()).bytesFreed).toBeGreaterThan(2048);
  });
});

describe("sizing", () => {
  test("a directory is measured recursively", () => {
    expect(directorySize(join(dir, "browser-state"))).toBeGreaterThanOrEqual(2048);
  });

  test("an unreadable or absent path measures 0 rather than throwing", () => {
    expect(directorySize(join(dir, "definitely-not-here"))).toBe(0);
  });

  test("bytes render in human units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
