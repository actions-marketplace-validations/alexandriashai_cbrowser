/**
 * Two-Tier Change Signal Invariants (ISC-87..90)
 *
 * `change_points` (changeScore < CHANGE) answers "did anything change";
 * `key_frames` (changeScore < KEY) answers "did something notable happen".
 * Neither threshold was caught by a test before, because no test expressed what
 * the fields promise — and the detector behind them was global SSIM, which
 * could not see a localized change at any threshold. Both were fixed together
 * (2026-07-19): the detector is now window-min ({@link changeScore}) and the
 * thresholds re-tuned to that scale.
 *
 * The structural invariants below are pure and exhaustive. The two behavioural
 * tests use real captures, because a threshold's usefulness is a claim about
 * real pixels and cannot be asserted over synthetic score arrays.
 *
 * ONE INVARIANT FROM THE BRIEF IS DELIBERATELY NOT ASSERTED HERE:
 * "on a continuously animating fixture, key_frames.length < change_points.length".
 * It is fixture-dependent, not code-guaranteed, and it is FALSE for a
 * sufficiently animated page — measured on a full-viewport hue rotation:
 * 34 frames, change_points 32, key_frames 32, i.e. both tiers saturate together
 * and the sparse tier provides no fallback exactly when it is needed. Asserting
 * it would encode a fixture's behaviour as a property of the code, and the next
 * person to hit the equal case would "fix" it by lowering the key threshold,
 * destroying the sparse tier. The separation property IS asserted, in its true
 * form, over straddling scores below.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import sharp from "sharp";
import { CBrowser } from "../src/browser.js";
import { VideoCaptureSession } from "../src/recording/engine.js";
import { detectChangePoints, changeScore, frameSignature, ssim } from "../src/recording/ssim.js";
import {
  changeSignal,
  changeSignalIssues,
  parseManifest,
  CHANGE_SATURATION_RATIO,
  SSIM_THRESHOLDS,
} from "../src/recording/types.js";

const NUM_RUNS = 1000;
const workDir = mkdtempSync(join(tmpdir(), "cbrowser-tiers-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** SSIM scores, including the nulls a real manifest carries for frame 0. */
const scoresArb = fc.array(
  fc.oneof(
    { weight: 1, arbitrary: fc.constant(null) },
    { weight: 9, arbitrary: fc.float({ min: 0, max: 1, noNaN: true }) },
  ),
  { minLength: 1, maxLength: 120 },
);

async function capture(name: string, html: string, holdMs: number, drive?: (page: never) => Promise<void>) {
  const file = join(workDir, `${name}.html`);
  writeFileSync(file, html);
  const browser = new CBrowser({ headless: true, viewportWidth: 1280, viewportHeight: 800 });
  await browser.launch();
  try {
    await browser.navigate(`file://${file}`);
    const page = await browser.getPage();
    const session = new VideoCaptureSession(page, "chromium", workDir);
    await session.start({ fps: 10, slug: name, outDir: join(workDir, name), format: [] });
    if (drive) await drive(page as never);
    await new Promise((r) => setTimeout(r, holdMs));
    return (await session.stop()).manifest;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Structural invariants — pure, exhaustive
// ---------------------------------------------------------------------------

describe("change-tier structural invariants", () => {
  test("property: key_frames is always a subset of change_points", () => {
    // Guaranteed by construction: the key threshold is lower, so anything below
    // it is below the change threshold too. If this ever fails, the tiers were
    // computed from different score arrays.
    fc.assert(
      fc.property(scoresArb, (scores) => {
        const changePoints = detectChangePoints(scores, SSIM_THRESHOLDS.change);
        const keyFrames = detectChangePoints(scores, SSIM_THRESHOLDS.key);
        const changeSet = new Set(changePoints);
        for (const index of keyFrames) expect(changeSet.has(index)).toBe(true);
        expect(keyFrames.length).toBeLessThanOrEqual(changePoints.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("property: a score between the tiers lands in change_points only", () => {
    // The separation property in its TRUE form — a statement about scores, not
    // about any particular page. This is what "two tiers carry more information
    // than one" actually means.
    fc.assert(
      fc.property(
        // A value strictly between KEY (0.6) and CHANGE (0.95). Bounds are
        // float32-rounded and nudged inward so neither endpoint lands ON a
        // threshold — the same class of boundary bug the delay-ceiling property
        // had, where Math.fround(0.9) came out at 0.89999997 and leaked the case
        // into both tiers.
        fc.float({ min: Math.fround(SSIM_THRESHOLDS.key + 0.001), max: Math.fround(SSIM_THRESHOLDS.change - 0.001), noNaN: true }),
        (straddling) => {
          expect(straddling).toBeGreaterThanOrEqual(SSIM_THRESHOLDS.key);
          expect(straddling).toBeLessThan(SSIM_THRESHOLDS.change);
          const scores = [null, straddling];
          expect(detectChangePoints(scores, SSIM_THRESHOLDS.change)).toEqual([1]);
          expect(detectChangePoints(scores, SSIM_THRESHOLDS.key)).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("property: saturation flag matches the ratio it claims", () => {
    fc.assert(
      fc.property(scoresArb, (scores) => {
        const changePoints = detectChangePoints(scores, SSIM_THRESHOLDS.change);
        const saturated = changePoints.length > scores.length * CHANGE_SATURATION_RATIO;
        // Mirrors the engine's computation; a divergence here means the two
        // have drifted apart.
        expect(typeof saturated).toBe("boolean");
        if (changePoints.length > scores.length * 0.9) expect(saturated).toBe(true);
        if (changePoints.length === 0) expect(saturated).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("the key threshold must stay below the change threshold", () => {
    // If these ever cross, key_frames stops being a subset and the sparse tier
    // becomes the noisy one.
    expect(SSIM_THRESHOLDS.key).toBeLessThan(SSIM_THRESHOLDS.change);
  });
});

// ---------------------------------------------------------------------------
// Behavioural — real captures
// ---------------------------------------------------------------------------

const FORM_FILL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Form</title>
<style>body{font:16px sans-serif;padding:40px;background:#fff}
input{display:block;font-size:16px;padding:8px;margin:12px 0;width:320px}</style></head>
<body><h1>Sign up</h1>
<label>Email <input id="email" type="email"></label>
<label>Name <input id="name" type="text"></label></body></html>`;

const ANIMATING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Anim</title></head>
<body style="margin:0"><div id="b" style="width:200px;height:200px;background:#0af"></div>
<script>let n=0;setInterval(()=>{n++;
document.getElementById("b").style.transform="translateX("+(n*17%800)+"px)";
document.body.style.background="hsl("+(n*13%360)+",60%,30%)";},50)</script></body></html>`;

/** A large static page with only a tiny counter ticking in the corner. */
const TICKING_COUNTER = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Counter</title></head>
<body style="margin:0;font:16px sans-serif;padding:40px"><h1>Dashboard</h1>
<p>${"Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(40)}</p>
<span id="c" style="position:fixed;bottom:8px;right:8px;font:12px monospace">0</span>
<script>let n=0;setInterval(()=>{n++;document.getElementById("c").textContent="count "+n;},150)</script>
</body></html>`;

/** A progress bar advancing a MODERATE amount every frame: continuous change,
 * but each step is moderate — the shape that saturates change_points while
 * leaving key_frames sparse. */
const PROGRESS_BAR = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Progress</title></head>
<body style="margin:0;font:16px sans-serif;padding:40px"><h1>Loading</h1>
<div style="width:600px;height:40px;border:2px solid #333"><div id="bar" style="height:100%;width:0;background:#0a7"></div></div>
<p>${"Filler text. ".repeat(30)}</p>
<script>let n=0;setInterval(()=>{n=(n+4)%100;document.getElementById("bar").style.width=(n*6)+"px";},100)</script>
</body></html>`;

describe("change-tier behaviour on real captures", () => {
  test("a ticking counter is a change point but never a key frame", async () => {
    // A 12px counter ticking on an otherwise static page scores ~0.87 under
    // window-min: below CHANGE (0.95) so a tick registers as a change, but above
    // KEY (0.6) so it is never a notable event. Global SSIM could not represent
    // this at all — it read ~0.9998 regardless. The reliable claim about a
    // ticking counter is that it produces NO key frames and does not saturate;
    // exactly how many change points appear is event-driven and timing-varying,
    // so it is not asserted.
    const manifest = await capture("counter", TICKING_COUNTER, 2400);
    expect(manifest.frames.length).toBeGreaterThan(5);
    expect(manifest.key_frames).toEqual([]);
    expect(manifest.change_points_saturated).toBe(false);
    expect(changeSignalIssues(parseManifest(manifest))).toEqual([]);
  }, 180000);

  test("ISC-88: key_frames stays usable when change_points saturates", async () => {
    // THE case the two tiers exist for. A progress bar advancing every frame
    // makes nearly every frame a change point (change_points saturates and
    // carries no information), but each step is moderate, so only the larger
    // jumps cross the KEY threshold. Measured: change_points ~94%, key_frames
    // ~26%. So when change_points is useless, key_frames is still discriminating
    // — the fallback ISC-88 was reopened to require.
    const manifest = await capture("progress", PROGRESS_BAR, 3000);
    const frames = manifest.frames.length;
    const changeCount = manifest.change_points.length;
    const keyCount = manifest.key_frames!.length;

    expect(frames).toBeGreaterThan(10);
    // change_points has saturated...
    expect(manifest.change_points_saturated).toBe(true);
    expect(changeCount).toBeGreaterThan(frames * CHANGE_SATURATION_RATIO);
    // ...while key_frames is strictly sparser, non-empty, and NOT itself
    // saturated — i.e. it still discriminates.
    expect(keyCount).toBeGreaterThan(0);
    expect(keyCount).toBeLessThan(changeCount);
    expect(keyCount / frames).toBeLessThanOrEqual(CHANGE_SATURATION_RATIO);
    expect(changeSignalIssues(parseManifest(manifest))).toEqual([]);
  }, 180000);

  test("a two-form-fill flow produces change points and key frames", async () => {
    // With global SSIM this flow reported ZERO change points at any threshold
    // — the detector could not see a localized change. With window-min a form
    // fill scores ~0.21, well below both tiers.
    const manifest = await capture("formfill", FORM_FILL, 900, async (page) => {
      const p = page as unknown as { fill(sel: string, value: string): Promise<void> };
      await new Promise((r) => setTimeout(r, 400));
      await p.fill("#email", "alexandria.shai.eden@example.com");
      await new Promise((r) => setTimeout(r, 700));
      await p.fill("#name", "Alexandria Eden");
    });

    expect(manifest.change_points.length).toBeGreaterThan(0);
    expect(manifest.change_points_saturated).toBe(false);
    expect(changeSignalIssues(parseManifest(manifest))).toEqual([]);
  }, 180000);

  test("a continuously animating page is flagged saturated", async () => {
    // The flag is the honest part of the design: it says outright that
    // change_points carries no discriminating information for this capture.
    const manifest = await capture("animating", ANIMATING, 3000);
    const frames = manifest.frames.length;

    expect(frames).toBeGreaterThan(5);
    expect(manifest.change_points.length).toBeGreaterThan(frames * CHANGE_SATURATION_RATIO);
    expect(manifest.change_points_saturated).toBe(true);
    expect(changeSignalIssues(parseManifest(manifest))).toEqual([]);

    // Recorded, not asserted: on this fixture key_frames saturates too, so it
    // is NOT a usable fallback here. See the file header.
    const signal = changeSignal(parseManifest(manifest));
    expect(signal.keyFrames.length).toBeLessThanOrEqual(signal.changePoints.length);
  }, 180000);

  test("the engine emits a current-version manifest with all three fields", async () => {
    const manifest = await capture("emits", ANIMATING, 1200);
    expect(manifest.version).toBeGreaterThanOrEqual(3);
    expect(manifest.key_frames).toBeDefined();
    expect(manifest.change_points_saturated).toBeDefined();
    expect(manifest.ssim_thresholds).toEqual({ ...SSIM_THRESHOLDS });
    // Survives a round-trip through the schema rather than being stripped.
    expect(parseManifest(JSON.parse(JSON.stringify(manifest))).key_frames).toBeDefined();
  }, 180000);
});

// ---------------------------------------------------------------------------
// Viewport invariance — the strongest claim window-min makes, and its limit
// ---------------------------------------------------------------------------

/** Render a before/after localized change at (w,h) and return its change score. */
async function scorePairAtViewport(
  makeSvg: (w: number, h: number, changed: boolean) => string,
  w: number,
  h: number,
  size: number,
  cmpDir: string,
): Promise<{ change: number; global: number }> {
  const before = join(cmpDir, `b-${w}x${h}-${size}.png`);
  const after = join(cmpDir, `a-${w}x${h}-${size}.png`);
  await sharp(Buffer.from(makeSvg(w, h, false))).png().toFile(before);
  await sharp(Buffer.from(makeSvg(w, h, true))).png().toFile(after);
  const a = await frameSignature(before, size);
  const b = await frameSignature(after, size);
  return { change: changeScore(a, b, { size }), global: ssim(a, b) };
}

/** Tier a score falls in, under the shipped thresholds. */
function tierOf(score: number): "key" | "change" | "none" {
  if (score < SSIM_THRESHOLDS.key) return "key";
  if (score < SSIM_THRESHOLDS.change) return "change";
  return "none";
}

const VIEWPORTS: [number, number][] = [
  [640, 400],
  [1280, 800],
  [1920, 1080],
];

/** A form-fill-sized localized change: an email address appears in a field. */
const FORM_FILL_SVG = (w: number, h: number, filled: boolean): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
  `<rect width="${w}" height="${h}" fill="#fff"/>` +
  `<text x="40" y="60" font-size="28" font-family="sans-serif" fill="#111">Sign up</text>` +
  `<rect x="40" y="90" width="320" height="36" fill="none" stroke="#888"/>` +
  (filled
    ? `<text x="48" y="115" font-size="18" font-family="monospace" fill="#111">alexandria.eden@example.com</text>`
    : ``) +
  `</svg>`;

/** A sub-resolution change: a 7-character status word flips colour and text. */
const TINY_STATUS_SVG = (w: number, h: number, changed: boolean): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
  `<rect width="${w}" height="${h}" fill="#fff"/>` +
  `<text x="40" y="60" font-size="24" font-family="sans-serif" fill="#111">Dashboard</text>` +
  `<text x="40" y="100" font-size="16" font-family="monospace" fill="${changed ? "#c00" : "#080"}">` +
  `${changed ? "OFFLINE" : "ONLINE "}</text></svg>`;

describe("changeScore viewport invariance (ISC-88) and its resolution limit", () => {
  const cmpDir = mkdtempSync(join(tmpdir(), "cbrowser-viewport-"));
  afterAll(() => rmSync(cmpDir, { recursive: true, force: true }));

  test("tier membership is viewport-stable for a resolvable change at the shipped 128px", async () => {
    // THE claim window-min makes that global SSIM cannot: for a change large
    // enough to survive the signature downsample, its tier does not depend on
    // viewport size. A form fill is such a change.
    const changeTiers = new Set<string>();
    const scores: number[] = [];
    for (const [w, h] of VIEWPORTS) {
      const { change } = await scorePairAtViewport(FORM_FILL_SVG, w, h, 128, cmpDir);
      changeTiers.add(tierOf(change));
      scores.push(change);
    }
    // Same tier at every viewport, and the raw score stays within a tight band.
    expect(changeTiers.size).toBe(1);
    expect(Math.max(...scores) - Math.min(...scores)).toBeLessThan(0.3);
  }, 60000);

  test("global SSIM is NOT viewport-stable for the same change — the contrast", async () => {
    // Global SSIM is a fraction-of-frame metric, so the same fill dilutes as the
    // viewport grows: measured 0.82 -> 0.87 -> 0.92 across these sizes. That
    // spread is what makes a fixed global threshold viewport-relative and is why
    // the detector had to change.
    const scores: number[] = [];
    for (const [w, h] of VIEWPORTS) {
      const { global } = await scorePairAtViewport(FORM_FILL_SVG, w, h, 128, cmpDir);
      scores.push(global);
    }
    // Global drifts markedly more than window-min does on the same change.
    expect(Math.max(...scores) - Math.min(...scores)).toBeGreaterThan(0.05);
  }, 60000);

  test("resolution limit: a sub-resolution change is NOT viewport-stable at 128px, but is at 512px", async () => {
    // The honest boundary of the invariance claim, asserted rather than
    // described. A 7-char word flip is smaller than one 128px-signature window
    // at large viewports, so the fixed downsample averages it away before the
    // windows see it — reintroducing viewport-dependence. A larger signature
    // preserves it. This documents WHY 128 is a tradeoff, not a free win.
    const wide: [number, number][] = [[600, 400], [1280, 800], [1920, 1080], [2560, 1440]];

    const at128 = new Set<string>();
    const at512 = new Set<string>();
    for (const [w, h] of wide) {
      at128.add(tierOf((await scorePairAtViewport(TINY_STATUS_SVG, w, h, 128, cmpDir)).change));
      at512.add(tierOf((await scorePairAtViewport(TINY_STATUS_SVG, w, h, 512, cmpDir)).change));
    }
    // 128 cannot hold the tier across viewports for a sub-resolution change...
    expect(at128.size).toBeGreaterThan(1);
    // ...512 can, because the change survives the coarser downsample.
    expect(at512.size).toBe(1);
  }, 60000);
});
