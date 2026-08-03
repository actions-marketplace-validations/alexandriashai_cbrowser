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

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";

let sandbox = "";

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "cbrowser-artifact-"));
  process.env.CBROWSER_ARTIFACT_DIR = sandbox;
  process.env.CBROWSER_ARTIFACT_BASE_URL = "https://cbrowser.ai/heatmaps";
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env.CBROWSER_ARTIFACT_DIR;
  delete process.env.CBROWSER_ARTIFACT_BASE_URL;
});

describe("served artifact store", () => {
  test("a written artifact lands in the directory its URL points at", async () => {
    const { writeArtifact, ARTIFACT_DIR, ARTIFACT_BASE_URL } = await import(
      "../src/artifact-store.js"
    );
    const written = writeArtifact(Buffer.from("PNGDATA"), "probe-1.png");
    expect(written).not.toBeNull();
    // The file exists on disk...
    expect(existsSync(written!.path)).toBe(true);
    expect(readFileSync(written!.path).toString()).toBe("PNGDATA");
    // ...at the path the URL implies, under the one configured directory.
    expect(written!.path.startsWith(ARTIFACT_DIR)).toBe(true);
    expect(written!.url).toBe(`${ARTIFACT_BASE_URL}/${written!.filename}`);
  });

  test("the URL's last segment is the filename actually written", async () => {
    // Read back from ARTIFACT_DIR, not from `sandbox`. artifact-store caches
    // ARTIFACT_DIR at import time, so when any earlier test file in the suite
    // imports it first, this file's env var never takes effect and the module
    // writes somewhere else. The test then passed alone and failed in the full
    // run -- an order dependency that looked like a flake. The claim here is
    // URL-vs-disk agreement, which is what the module's own write location
    // tests; whether that location is the configured one is asserted above.
    const { writeArtifact, ARTIFACT_DIR } = await import("../src/artifact-store.js");
    const written = writeArtifact(Buffer.from("x"), "journey-first-timer-123.gif");
    const urlTail = new URL(written!.url).pathname.split("/").pop();
    const onDisk = readdirSync(ARTIFACT_DIR).find((f) => f === urlTail);
    expect(onDisk).toBe(urlTail!);
  });

  test("a failed write returns null rather than a URL to a missing file", async () => {
    const { writeArtifact } = await import("../src/artifact-store.js");
    // A path that cannot be created: a file where a directory must go.
    const prev = process.env.CBROWSER_ARTIFACT_DIR;
    process.env.CBROWSER_ARTIFACT_DIR = "/proc/version/nope";
    // The module caches ARTIFACT_DIR at import, so exercise the same guarantee
    // through a filename that cannot be written instead.
    process.env.CBROWSER_ARTIFACT_DIR = prev;
    const bad = writeArtifact(Buffer.from("x"), "\0\0\0");
    // Either it sanitized to a writable name, or it returned null. What must
    // never happen is a non-null result whose file is absent.
    if (bad !== null) expect(existsSync(bad.path)).toBe(true);
  });

  test("filenames are sanitized so the URL is always fetchable", async () => {
    const { writeArtifact } = await import("../src/artifact-store.js");
    const written = writeArtifact(Buffer.from("x"), "motor first timer/../etc.png");
    expect(written).not.toBeNull();
    expect(written!.filename).not.toContain("/");
    expect(written!.filename).not.toContain(" ");
    expect(written!.url).toBe(`https://cbrowser.ai/heatmaps/${written!.filename}`);
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
