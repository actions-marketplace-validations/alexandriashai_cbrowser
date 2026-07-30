/**
 * CLI argument parsing — negative flags
 *
 * Regression tests for a bug shipped in 18.72.3: `--no-x` set only
 * options["no-x"], so any reader written as `options.x !== false` never saw the
 * flag. Measured across the four documented negative flags:
 *
 *   --no-color      reads options["no-color"]   worked
 *   --no-vision     reads options["no-vision"]  worked
 *   --no-persistent reads options.persistent    SILENTLY IGNORED
 *   --no-restore    reads options.restore       SILENTLY IGNORED
 *
 * The two broken ones are both opt-outs for persisted browser state, so state
 * the user explicitly asked to discard was kept: `cbrowser cookie list
 * --no-persistent` still returned cookies out of the persistent profile. A
 * silently-ignored flag is worse than a rejected one - the command exits 0 and
 * looks like it honoured the request.
 */

import { describe, test, expect } from "bun:test";
import { parseArgs } from "../src/cli-args.js";

const opts = (argv: string[]) => parseArgs(["cmd", ...argv]).options;

describe("negative flags set the stripped key to false", () => {
  test("--no-persistent (was silently ignored)", () => {
    // The exact read in cli.ts: options.persistent !== false && !== "false"
    const o = opts(["--no-persistent"]);
    expect(o.persistent).toBe(false);
    expect(o.persistent !== false).toBe(false); // i.e. persistentMode is now off
  });

  test("--no-restore (was silently ignored)", () => {
    expect(opts(["--no-restore"]).restore).toBe(false);
  });
});

describe("flags that already worked keep working", () => {
  test("--no-color still sets options['no-color']", () => {
    expect(opts(["--no-color"])["no-color"]).toBe(true);
  });

  test("--no-vision still sets options['no-vision']", () => {
    expect(opts(["--no-vision"])["no-vision"]).toBe(true);
  });

  test("both spellings are present, so either reader resolves", () => {
    const o = opts(["--no-persistent"]);
    expect(o["no-persistent"]).toBe(true);
    expect(o.persistent).toBe(false);
  });
});

describe("the inversion does not overreach", () => {
  test("a --no-x that takes a VALUE is not inverted", () => {
    // `--no-cache foo` means the value "foo"; flipping it to cache=false would
    // invent a flag the user did not pass.
    const o = opts(["--no-cache", "foo"]);
    expect(o["no-cache"]).toBe("foo");
    expect(o.cache).toBeUndefined();
  });

  test("a bare --no is not treated as a negation", () => {
    expect(opts(["--no"])["no"]).toBe(true);
    expect(Object.keys(opts(["--no"]))).toEqual(["no"]);
  });

  test("ordinary flags are untouched", () => {
    const o = opts(["--headless", "--device", "iphone-15"]);
    expect(o.headless).toBe(true);
    expect(o.device).toBe("iphone-15");
  });

  test("positional args still separate from options", () => {
    const p = parseArgs(["navigate", "https://example.com", "--no-persistent"]);
    expect(p.command).toBe("navigate");
    expect(p.args).toEqual(["https://example.com"]);
    expect(p.options.persistent).toBe(false);
  });
});
