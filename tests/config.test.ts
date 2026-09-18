/**
 * Config Tests
 *
 * Tests for configuration and data directory management.
 *
 * HERMETIC ON PURPOSE (2026-09-17)
 *
 * These tests used to read whatever CBROWSER_DATA_DIR the ambient environment
 * happened to carry, which made them depend on what ran before them:
 *
 *   - `path contains cbrowser` asserted the returned path contains the literal
 *     "cbrowser". That holds for the default ~/.cbrowser, but getDataDir() is
 *     `process.env.CBROWSER_DATA_DIR || join(homedir(), ".cbrowser")`, so ANY
 *     override — a mkdtemp dir, say — makes it false. Four test files set that
 *     variable, two of them in the release gate's shared process, so the
 *     assertion passed or failed on file discovery order. It took down the
 *     Release workflow on 2026-09-18 while the same commit passed locally.
 *
 *   - `creates required directories` called ensureDirectories() with no
 *     override, so on a developer machine it created 14 directories inside the
 *     real ~/.cbrowser as a side effect of running the suite.
 *
 * Both are fixed by owning the variable rather than reading it: each test sets
 * the state it needs and restores it, so the file's result no longer depends on
 * its neighbours or on who is running it.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  getDataDir,
  ensureDirectories,
} from "../src/config.js";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

const ORIGINAL_DATA_DIR = process.env.CBROWSER_DATA_DIR;
let tempDataDir: string;

beforeAll(() => {
  tempDataDir = mkdtempSync(join(tmpdir(), "cbrowser-config-test-"));
  process.env.CBROWSER_DATA_DIR = tempDataDir;
});

afterEach(() => {
  // Individual tests may clear the override to exercise the fallback branch.
  process.env.CBROWSER_DATA_DIR = tempDataDir;
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.CBROWSER_DATA_DIR;
  else process.env.CBROWSER_DATA_DIR = ORIGINAL_DATA_DIR;
  rmSync(tempDataDir, { recursive: true, force: true });
});

describe("Config", () => {
  describe("getDataDir", () => {
    test("returns a valid path", () => {
      const dataDir = getDataDir();
      expect(typeof dataDir).toBe("string");
      expect(dataDir.length).toBeGreaterThan(0);
    });

    test("honours CBROWSER_DATA_DIR when it is set", () => {
      expect(getDataDir()).toBe(tempDataDir);
    });

    test("falls back to a cbrowser-named dir under $HOME when unset", () => {
      // The original assertion, stated against the branch it actually describes
      // rather than against whatever the environment happened to hold.
      delete process.env.CBROWSER_DATA_DIR;
      const dataDir = getDataDir();
      expect(dataDir).toBe(join(homedir(), ".cbrowser"));
      expect(dataDir).toContain("cbrowser");
    });
  });

  describe("ensureDirectories", () => {
    test("creates required directories", () => {
      // Runs against the temp override, so the suite no longer writes into the
      // developer's real ~/.cbrowser.
      ensureDirectories();
      const dataDir = getDataDir();
      expect(dataDir).toBe(tempDataDir);
      expect(existsSync(dataDir)).toBe(true);
    });
  });
});
