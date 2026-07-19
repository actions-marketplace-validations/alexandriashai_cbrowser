/**
 * Recording Contact Sheet Tests
 *
 * Property tests for the frame-sampling helper plus integration tests that
 * build a real sheet from generated PNGs and assert the MCP byte budget holds.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import sharp from "sharp";
import {
  pickEvenlySpaced,
  buildContactSheet,
  MAX_CONTACT_SHEET_BYTES,
  DEFAULT_MAX_FRAMES,
} from "../src/recording/contact-sheet.js";

const NUM_RUNS = 1000;

const workDir = mkdtempSync(join(tmpdir(), "cbrowser-contact-sheet-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Solid-colour frames, hue stepped per frame so tiles are distinguishable. */
async function makeFrames(count: number, width = 160, height = 90): Promise<string[]> {
  const dir = join(workDir, `frames-${count}-${width}x${height}`);
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const path = join(dir, `${String(i).padStart(4, "0")}.png`);
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: (i * 23) % 256, g: (i * 71) % 256, b: (i * 137) % 256 },
      },
    })
      .png()
      .toFile(path);
    paths.push(path);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// pickEvenlySpaced
// ---------------------------------------------------------------------------

describe("recording/contact-sheet pickEvenlySpaced", () => {
  const nkArb = fc
    .integer({ min: 1, max: 5000 })
    .chain((n) => fc.tuple(fc.constant(n), fc.integer({ min: 1, max: n })));

  test("property: min(n,k) strictly increasing indices inside [0,n), ends pinned", () => {
    fc.assert(
      fc.property(nkArb, ([n, k]) => {
        const picked = pickEvenlySpaced(n, k);

        expect(picked.length).toBe(Math.min(n, k));
        for (const i of picked) {
          expect(Number.isInteger(i)).toBe(true);
          expect(i).toBeGreaterThanOrEqual(0);
          expect(i).toBeLessThan(n);
        }
        for (let i = 1; i < picked.length; i++) {
          expect(picked[i]!).toBeGreaterThan(picked[i - 1]!);
        }
        expect(picked[0]).toBe(0);
        if (k >= 2) {
          expect(picked[picked.length - 1]).toBe(n - 1);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("property: no duplicate indices", () => {
    fc.assert(
      fc.property(nkArb, ([n, k]) => {
        const picked = pickEvenlySpaced(n, k);
        expect(new Set(picked).size).toBe(picked.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("property: asking for more than exists returns every index", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 0, max: 500 }),
        (n, extra) => {
          const picked = pickEvenlySpaced(n, n + extra);
          expect(picked).toEqual([...Array(n).keys()]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("spaces evenly across a known input", () => {
    expect(pickEvenlySpaced(10, 1)).toEqual([0]);
    expect(pickEvenlySpaced(10, 2)).toEqual([0, 9]);
    expect(pickEvenlySpaced(10, 5)).toEqual([0, 2, 5, 7, 9]);
    expect(pickEvenlySpaced(100, 12)).toEqual([0, 9, 18, 27, 36, 45, 54, 63, 72, 81, 90, 99]);
  });

  test("rejects non-positive or non-integer arguments", () => {
    expect(() => pickEvenlySpaced(0, 3)).toThrow(/n must be a positive integer/);
    expect(() => pickEvenlySpaced(10, 0)).toThrow(/k must be a positive integer/);
    expect(() => pickEvenlySpaced(1.5, 1)).toThrow(/n must be a positive integer/);
    expect(() => pickEvenlySpaced(10, 2.5)).toThrow(/k must be a positive integer/);
  });
});

// ---------------------------------------------------------------------------
// buildContactSheet
// ---------------------------------------------------------------------------

describe("recording/contact-sheet buildContactSheet", () => {
  test("builds a valid, in-budget sheet from real frames", async () => {
    const frames = await makeFrames(40);
    const outPath = join(workDir, "sheet-default.jpg");

    const result = await buildContactSheet({ framePaths: frames, outPath });

    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toBe(outPath);
    expect(result.bytes).toBeLessThanOrEqual(MAX_CONTACT_SHEET_BYTES);
    expect(result.bytes).toBeGreaterThan(0);

    expect(result.frameIndices).toHaveLength(DEFAULT_MAX_FRAMES);
    expect(result.frameIndices[0]).toBe(0);
    expect(result.frameIndices[result.frameIndices.length - 1]).toBe(39);

    const meta = await sharp(result.path).metadata();
    expect(meta.format).toBe("jpeg");
    // 12 frames -> ceil(sqrt(12)) = 4 columns, 3 rows.
    expect(meta.width).toBe(160 * 4);
    expect(meta.height).toBe(90 * 3);
  });

  test("stays in budget for large frames by walking the ladder down", async () => {
    const frames = await makeFrames(30, 1280, 720);
    const outPath = join(workDir, "sheet-large.jpg");

    const result = await buildContactSheet({ framePaths: frames, outPath });

    expect(result.bytes).toBeLessThanOrEqual(MAX_CONTACT_SHEET_BYTES);
    const meta = await sharp(result.path).metadata();
    expect(meta.format).toBe("jpeg");
    // Pre-scaled so the assembled sheet never exceeds MAX_SHEET_EDGE.
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1600);
  }, 60000);

  test("honours an explicit column count and frame budget", async () => {
    const frames = await makeFrames(40);
    const outPath = join(workDir, "sheet-columns.jpg");

    const result = await buildContactSheet({
      framePaths: frames,
      outPath,
      columns: 2,
      maxFrames: 6,
    });

    expect(result.frameIndices).toEqual([0, 8, 16, 23, 31, 39]);
    const meta = await sharp(result.path).metadata();
    expect(meta.width).toBe(160 * 2);
    expect(meta.height).toBe(90 * 3);
  });

  test("labelIndices toggles the overlay and changes the encoded bytes", async () => {
    const frames = await makeFrames(40);
    const labelled = await buildContactSheet({
      framePaths: frames,
      outPath: join(workDir, "sheet-labelled.jpg"),
    });
    const bare = await buildContactSheet({
      framePaths: frames,
      outPath: join(workDir, "sheet-bare.jpg"),
      labelIndices: false,
    });

    expect(bare.bytes).not.toBe(labelled.bytes);
    expect(bare.bytes).toBeLessThanOrEqual(MAX_CONTACT_SHEET_BYTES);
    expect(await sharp(bare.path).metadata().then((m) => m.format)).toBe("jpeg");

    // Frame 0 is solid black, so any near-white pixel in its corner is burned-in
    // label text — this asserts the glyphs actually rendered, not just that the
    // badge changed the file size.
    const nearWhite = async (path: string) => {
      const data = await sharp(path)
        .extract({ left: 0, top: 0, width: 60, height: 30 })
        .greyscale()
        .raw()
        .toBuffer();
      return data.reduce((count, v) => (v >= 200 ? count + 1 : count), 0);
    };

    expect(await nearWhite(labelled.path)).toBeGreaterThan(10);
    expect(await nearWhite(bare.path)).toBe(0);
  });

  test("handles a single frame", async () => {
    const frames = await makeFrames(1);
    const result = await buildContactSheet({
      framePaths: frames,
      outPath: join(workDir, "sheet-single.jpg"),
    });

    expect(result.frameIndices).toEqual([0]);
    const meta = await sharp(result.path).metadata();
    expect(meta.width).toBe(160);
    expect(meta.height).toBe(90);
  });

  test("rewrites a non-JPEG extension and reports the real path", async () => {
    const frames = await makeFrames(1);
    const result = await buildContactSheet({
      framePaths: frames,
      outPath: join(workDir, "sheet-ext.png"),
      maxFrames: 1,
    });

    expect(result.path).toBe(join(workDir, "sheet-ext.jpg"));
    expect(existsSync(result.path)).toBe(true);
  });

  test("creates missing output directories", async () => {
    const frames = await makeFrames(1);
    const outPath = join(workDir, "nested", "deeper", "sheet.jpg");
    const result = await buildContactSheet({ framePaths: frames, outPath, maxFrames: 1 });
    expect(existsSync(result.path)).toBe(true);
  });

  test("throws rather than returning an over-budget sheet", async () => {
    const frames = await makeFrames(40);
    let error: Error | undefined;
    try {
      await buildContactSheet({
        framePaths: frames,
        outPath: join(workDir, "sheet-impossible.jpg"),
        maxBytes: 200,
      });
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    // The message must name the size actually achieved, not just "too big".
    expect(error!.message).toMatch(/smallest achieved \d+ bytes/);
    expect(existsSync(join(workDir, "sheet-impossible.jpg"))).toBe(false);
  }, 60000);

  test("rejects invalid options", async () => {
    const frames = await makeFrames(1);
    const outPath = join(workDir, "sheet-invalid.jpg");

    await expect(buildContactSheet({ framePaths: [], outPath })).rejects.toThrow(
      /must not be empty/,
    );
    await expect(
      buildContactSheet({ framePaths: frames, outPath, maxFrames: 0 }),
    ).rejects.toThrow(/maxFrames must be a positive integer/);
    await expect(
      buildContactSheet({ framePaths: frames, outPath, columns: -1 }),
    ).rejects.toThrow(/columns must be a positive integer/);
    await expect(
      buildContactSheet({ framePaths: frames, outPath, maxBytes: 0 }),
    ).rejects.toThrow(/maxBytes must be positive/);
  });
});
