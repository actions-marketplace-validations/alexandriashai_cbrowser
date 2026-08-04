/**
 * Served-artifact contract.
 *
 * Every image tool returns a `https://cbrowser.ai/heatmaps/<file>` URL. nginx
 * serves that prefix from `/var/www/cbrowser-data/heatmaps/`, but four call
 * sites wrote to `/home/wyld-web/static/cbrowser-web/out/heatmaps` (and one to
 * `/var/www/cbrowser-web/heatmaps`). Measured 2026-07-29: a file written that
 * morning by the live code fetched 404, while the served directory's newest
 * file was from Jul 19 and fetched 200.
 *
 * The interesting part is why it went unnoticed for ten days. Each tool
 * considered itself successful when the write did not throw. Nothing anywhere
 * asked the only question that matters to a customer: does the URL I am handing
 * back resolve? These tests ask exactly that, without needing the network — the
 * URL and the directory must be derived from a single constant, so they cannot
 * drift apart again.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";

// Imported STATICALLY, at the top, on purpose: an ES import is evaluated before
// anything below it, so artifact-store is loaded before this file sets a single
// variable. That is exactly the situation that arose whenever another test file
// imported it first. Under the old import-time `const` it made the override
// dead and every assertion about WHERE a file landed went red. Keep this import
// where it is -- moving it into the tests restores the order dependency this
// file exists to rule out.
import { writeArtifact, artifactDir, artifactBaseUrl } from "../src/artifact-store.js";

// Set at MODULE scope, not in `beforeAll`. A hook fires at a moment the test
// runner chooses, which is an implementation detail of the runner and its
// version; a module body runs at a moment this file chooses. The override has
// to be in place before the first write either way, so it is stated where this
// file controls it. (Not a measured difference between bun versions -- 1.3.8
// and 1.3.14 both pass here. It removes one thing that would not have to be
// ruled out again.)
const sandbox = mkdtempSync(join(tmpdir(), "cbrowser-artifact-"));
process.env.CBROWSER_ARTIFACT_DIR = sandbox;
process.env.CBROWSER_ARTIFACT_BASE_URL = "https://cbrowser.ai/heatmaps";

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env.CBROWSER_ARTIFACT_DIR;
  delete process.env.CBROWSER_ARTIFACT_BASE_URL;
});

describe("served artifact store", () => {
  test("the configured directory wins over the one captured at import", () => {
    // The whole claim, stated once and directly. This is what was untestable
    // while the paths were import-time constants, and it is what has to hold
    // for every assertion below to mean anything.
    expect(artifactDir()).toBe(sandbox);
    expect(artifactDir()).not.toBe("/var/www/cbrowser-data/heatmaps");
  });

  test("a written artifact lands in the directory its URL points at", () => {
    const written = writeArtifact(Buffer.from("PNGDATA"), "probe-1.png");
    expect(written).not.toBeNull();
    // The file exists on disk...
    expect(existsSync(written!.path)).toBe(true);
    expect(readFileSync(written!.path).toString()).toBe("PNGDATA");
    // ...at the path the URL implies, under the one configured directory.
    expect(written!.path.startsWith(sandbox)).toBe(true);
    expect(written!.url).toBe(`${artifactBaseUrl()}/${written!.filename}`);
  });

  test("the URL's last segment is the filename actually written", () => {
    const written = writeArtifact(Buffer.from("x"), "journey-first-timer-123.gif");
    const urlTail = new URL(written!.url).pathname.split("/").pop();
    // Read back from the SANDBOX. Under the old code this had to read from
    // whatever the module had cached, which is why the assertion could not
    // check the location and the escape went unnoticed.
    const onDisk = readdirSync(sandbox).find((f) => f === urlTail);
    expect(onDisk).toBe(urlTail!);
  });

  test("a failed write returns null rather than a URL to a missing file", () => {
    // A directory that cannot be created: a file where a directory must go.
    const prev = process.env.CBROWSER_ARTIFACT_DIR;
    process.env.CBROWSER_ARTIFACT_DIR = "/proc/version/nope";
    try {
      const bad = writeArtifact(Buffer.from("x"), "probe-unwritable.png");
      expect(bad).toBeNull();
    } finally {
      process.env.CBROWSER_ARTIFACT_DIR = prev;
    }
    // And the store recovers: the next write goes back to the configured dir.
    expect(artifactDir()).toBe(sandbox);
  });

  test("filenames are sanitized so the URL is always fetchable", () => {
    const written = writeArtifact(Buffer.from("x"), "motor first timer/../etc.png");
    expect(written).not.toBeNull();
    expect(written!.filename).not.toContain("/");
    expect(written!.filename).not.toContain(" ");
    expect(written!.url).toBe(`https://cbrowser.ai/heatmaps/${written!.filename}`);
  });

  test("no write escapes into the production served directory", () => {
    // The failure this file exists to prevent, asserted as an absence. It is
    // the assertion that would have caught the release-blocking bug on this
    // box, where root can write the production default and so a leaked write
    // succeeds silently instead of failing loudly.
    for (const name of ["probe-1.png", "journey-first-timer-123.gif"]) {
      expect(existsSync(join("/var/www/cbrowser-data/heatmaps", name))).toBe(false);
    }
  });
});

describe("no writer bypasses the artifact store", () => {
  // These are the assertions that fail against the pre-fix tree. They are
  // greps rather than behavioural probes on purpose: the defect was four
  // independent literals, and the only durable fix is that no literal remains.
  const SRC = join(import.meta.dir, "..", "src");

  function grepSrc(needle: string): string[] {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(p, "utf8");
          text.split("\n").forEach((line, i) => {
            // Skip the explanatory comments that quote the old paths.
            const code = line.trim();
            if (code.startsWith("*") || code.startsWith("//")) return;
            if (line.includes(needle)) hits.push(`${p}:${i + 1}`);
          });
        }
      }
    };
    walk(SRC);
    return hits;
  }

  test("no source file writes to the unserved out/heatmaps directory", () => {
    expect(grepSrc("cbrowser-web/out/heatmaps")).toEqual([]);
  });

  test("no source file hard-codes the public heatmap URL", () => {
    // artifact-store.ts owns the one occurrence, via ARTIFACT_BASE_URL.
    const hits = grepSrc("cbrowser.ai/heatmaps").filter(
      (h) => !h.includes("artifact-store.ts"),
    );
    expect(hits).toEqual([]);
  });
});
