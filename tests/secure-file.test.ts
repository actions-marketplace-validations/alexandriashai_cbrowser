/**
 * Credential files must not be readable by other accounts on the machine.
 *
 * `setAnthropicApiKey` wrote the key with a bare `writeFileSync(path, data)`,
 * so its permissions were whatever the umask allowed — 0644 by default, i.e.
 * every account on the box could read the key.
 *
 * The trap that makes the obvious fix insufficient, and the reason this file
 * exists: `writeFileSync(path, data, { mode: 0o600 })` applies the mode ONLY
 * when creating the file. Every existing install already has config.json, so a
 * mode-only fix would tighten permissions for new users and silently leave
 * every current user exposed — while looking, in the diff, exactly like a fix.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeSecretFile,
  describeLoosePermissions,
  isGroupOrWorldAccessible,
  permissionBits,
  tightenPermissions,
  SECRET_MODE,
} from "../src/secure-file.js";

let dir: string;
const mode = (p: string) => permissionBits(statSync(p).mode);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cbrowser-secure-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writing a credential", () => {
  test("a new file is owner-only", () => {
    const p = join(dir, "config.json");
    writeSecretFile(p, '{"anthropicApiKey":"redacted"}');
    expect(mode(p)).toBe(SECRET_MODE);
  });

  test("an EXISTING world-readable file is repaired", () => {
    // The case a `mode:`-only fix misses, and the one that covers every
    // current install.
    const p = join(dir, "config.json");
    writeFileSync(p, "{}");
    chmodSync(p, 0o644);
    expect(isGroupOrWorldAccessible(statSync(p).mode)).toBe(true);

    writeSecretFile(p, '{"anthropicApiKey":"redacted"}');
    expect(mode(p)).toBe(SECRET_MODE);
  });

  test("the contents are what was asked for", () => {
    // Tightening permissions on the wrong bytes would be its own defect.
    const p = join(dir, "config.json");
    writeSecretFile(p, '{"a":1}');
    expect(Bun.file(p).text()).resolves.toBe('{"a":1}');
  });

  test("a group-readable file is repaired too, not just world-readable", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, "{}");
    chmodSync(p, 0o640);
    writeSecretFile(p, "{}");
    expect(mode(p)).toBe(SECRET_MODE);
  });
});

describe("classifying a mode", () => {
  test("0600 is not group or world accessible", () => {
    expect(isGroupOrWorldAccessible(0o600)).toBe(false);
  });

  test("0400 is safe — owner-read-only is not a leak", () => {
    // Comparing against 0600 for equality would wrongly flag this.
    expect(isGroupOrWorldAccessible(0o400)).toBe(false);
  });

  test("0644, 0640, 0604 and 0666 are all flagged", () => {
    for (const m of [0o644, 0o640, 0o604, 0o666]) {
      expect(isGroupOrWorldAccessible(m), `mode ${m.toString(8)}`).toBe(true);
    }
  });

  test("file-type bits do not confuse the check", () => {
    // statSync().mode carries S_IFREG (0o100000). Masking is required.
    expect(isGroupOrWorldAccessible(0o100600)).toBe(false);
    expect(isGroupOrWorldAccessible(0o100644)).toBe(true);
  });
});

describe("reporting on a file this tool only reads", () => {
  test("a loose credential file is described, with the fix", () => {
    // geo-proxy.json is written by hand, so load time is the only place its
    // permissions can be noticed. Measured on a real install: 0664.
    const p = join(dir, "geo-proxy.json");
    writeFileSync(p, "{}");
    chmodSync(p, 0o664);

    const msg = describeLoosePermissions(p);
    expect(msg).toContain("664");
    expect(msg).toContain("chmod 600");
    expect(msg).toContain(p);
  });

  test("an owner-only file produces no message", () => {
    const p = join(dir, "geo-proxy.json");
    writeSecretFile(p, "{}");
    expect(describeLoosePermissions(p)).toBeNull();
  });

  test("an absent file produces no message", () => {
    // Not configured is not a warning.
    expect(describeLoosePermissions(join(dir, "nope.json"))).toBeNull();
  });
});

describe("tightening in place", () => {
  test("a loose file is tightened and reported as changed", () => {
    const p = join(dir, "geo-proxy.json");
    writeFileSync(p, "{}");
    chmodSync(p, 0o664);
    expect(tightenPermissions(p)).toBe(true);
    expect(mode(p)).toBe(SECRET_MODE);
  });

  test("an already-tight file reports no change", () => {
    const p = join(dir, "geo-proxy.json");
    writeSecretFile(p, "{}");
    expect(tightenPermissions(p)).toBe(false);
  });

  test("an absent file is not an error", () => {
    expect(tightenPermissions(join(dir, "nope.json"))).toBe(false);
  });
});
