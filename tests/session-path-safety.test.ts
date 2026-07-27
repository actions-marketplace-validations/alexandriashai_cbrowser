// ============================================================================
// Session-name path safety + stealth wildcard boundary — bun test suite
// ============================================================================
//
// Two 2026-07-26 findings from the cross-vendor (GPT-5.5) source audit, both
// re-verified by hand before being fixed:
//
// 1. save_session / load_session / delete_session took a bare `z.string()` name
//    and built `join(sessionsDir, name + ".json")`. join() does not contain
//    traversal, so a crafted name resolved outside the sessions directory —
//    an arbitrary .json write on save and an arbitrary .json unlink on delete. These tools are priced `free` and the
//    remote server registers them for every caller.
// 2. stealth's authorized-domain wildcard used `hostname.endsWith(suffix)` with
//    no label boundary, so `*.example.com` also authorised `evil-example.com`.
//
// Run:  bun test tests/session-path-safety.test.ts

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/browser/session-manager.js";

let dir: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cb-sessions-"));
  outside = mkdtempSync(join(tmpdir(), "cb-outside-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const mgr = () => new SessionManager({ sessionsDir: dir, viewportWidth: 1280, viewportHeight: 720 });

/** Reach the private path resolver the way every public method does. */
const pathFor = (m: SessionManager, name: string): string =>
  (m as unknown as { sessionPathFor(n: string): string }).sessionPathFor(name);

describe("session names cannot escape the sessions directory", () => {
  test("a plain name resolves inside sessionsDir", () => {
    expect(pathFor(mgr(), "my-session")).toBe(join(dir, "my-session.json"));
  });

  test("traversal names are refused, not resolved", () => {
    const m = mgr();
    for (const evil of [
      "../pwned",
      "../../pwned",
      "../../../../etc/cron.d/payload",
      "..",
      "./../x",
      "sub/dir/x",
      "/etc/cron.d/x",
      "a/../../b",
    ]) {
      expect(() => pathFor(m, evil)).toThrow();
    }
  });

  test("names with separators or nulls are refused", () => {
    const m = mgr();
    for (const evil of ["a/b", "a\\b", "a\0b", "", " ", ".hidden", "-leading", "x".repeat(65)]) {
      expect(() => pathFor(m, evil)).toThrow();
    }
  });

  test("ordinary names still work (the guard is not a blanket refusal)", () => {
    const m = mgr();
    for (const ok of ["a", "session1", "my.session", "my-session", "my_session", "A1._-", "x".repeat(64)]) {
      expect(pathFor(m, ok)).toBe(join(dir, `${ok}.json`));
    }
  });

  test("delete of a traversal name does not unlink a file outside the directory", () => {
    const victim = join(outside, "victim.json");
    writeFileSync(victim, "{}");
    const m = mgr();
    // A relative hop from sessionsDir out to the victim — the exact shape the
    // MCP delete_session argument accepted before the fix.
    const escape = "../".repeat(12) + victim.replace(/^\//, "").replace(/\.json$/, "");
    expect(() => m.delete(escape)).toThrow();
    expect(existsSync(victim)).toBe(true);
  });
});
