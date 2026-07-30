/**
 * CBrowser - Cognitive Browser Automation
 * Copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com
 * Learn more at https://cbrowser.ai - MIT License
 */

/**
 * Grayscale downsampled SSIM comparator.
 *
 * Frames are reduced to a fixed-size grayscale signature before comparison, so
 * the cost of comparing two frames is independent of the capture resolution and
 * the score is insensitive to sub-pixel noise. This is *global* SSIM (one
 * window covering the whole signature), which is what the recorder needs: a
 * single scalar per frame pair to drive change-point and anomaly detection.
 */

import sharp from "sharp";

/** SSIM stabilisation constants for data normalised to 0..1 (L = 1). */
const C1 = 0.01 * 0.01;
const C2 = 0.03 * 0.03;

/**
 * Reduce an image to a `size`x`size` grayscale signature normalised to 0..1.
 *
 * `fit: "fill"` is deliberate: aspect ratio is discarded so that two frames of
 * the same recording always produce comparable signatures even if a region
 * crop shifted by a pixel.
 *
 * @param input Image buffer or path to an image file.
 * @param size Signature edge length; the result has `size * size` values.
 */
export async function frameSignature(input: Buffer | string, size = 128): Promise<Float32Array> {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`frameSignature: size must be a positive integer, got ${size}`);
  }

  const { data, info } = await sharp(input)
    .resize(size, size, { fit: "fill" })
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const expected = size * size;
  const channels = info.channels;
  if (data.length < expected * channels) {
    throw new Error(
      `frameSignature: expected at least ${expected * channels} bytes, got ${data.length}`,
    );
  }

  const out = new Float32Array(expected);
  for (let i = 0; i < expected; i++) {
    out[i] = data[i * channels]! / 255;
  }
  return out;
}

/**
 * Global SSIM between two signatures.
 *
 * Returns exactly 1 for identical inputs and is exactly symmetric: the means,
 * variances and covariance are accumulated in a single loop with commutative
 * operations, so `ssim(a, b)` and `ssim(b, a)` agree bit-for-bit. The result is
 * clamped to [-1, 1] to absorb floating-point overshoot.
 *
 * @throws if the signatures differ in length or are empty.
 */
export function ssim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`ssim: signature length mismatch (${a.length} vs ${b.length})`);
  }
  if (a.length === 0) {
    throw new Error("ssim: signatures must not be empty");
  }

  const n = a.length;

  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i]!;
    sumB += b[i]!;
  }
  const muA = sumA / n;
  const muB = sumB / n;

  let sqA = 0;
  let sqB = 0;
  let sqAB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - muA;
    const db = b[i]! - muB;
    sqA += da * da;
    sqB += db * db;
    sqAB += da * db;
  }

  // Unbiased estimator; degenerate for n === 1, where all spread terms are 0.
  const denom = n > 1 ? n - 1 : 1;
  const varA = n > 1 ? sqA / denom : 0;
  const varB = n > 1 ? sqB / denom : 0;
  const cov = n > 1 ? sqAB / denom : 0;

  const numerator = (2 * muA * muB + C1) * (2 * cov + C2);
  const denominator = (muA * muA + muB * muB + C1) * (varA + varB + C2);

  const score = numerator / denominator;
  return Math.min(1, Math.max(-1, score));
}


/** Edge length of the window grid used by {@link changeScore}. */
export const CHANGE_WINDOW = 8;

/**
 * Change score: the MINIMUM SSIM across a grid of windows.
 *
 * {@link ssim} is global — one statistic over the whole frame — which makes it
 * a quality-assessment metric. Asked a detection question it fails badly: a
 * small localized change is diluted by the unchanged remainder of the frame.
 * Measured on a 1280x800 page differing only by a 12px counter, global SSIM
 * reads 0.999989 at a 128px signature and still 0.999254 at 1024px, so NO
 * threshold below 1.0 can see it. Raising resolution does not help, and neither
 * does averaging the windows (mean-over-windows scored 0.999956 — dilution
 * again). Taking the minimum does: the same pair reads 0.901 at 512px.
 *
 * So: mean-over-windows for "how similar are these images", minimum-over-windows
 * for "did any part of this image change". This is the latter.
 *
 * Identical inputs return exactly 1 and the score is symmetric, for the same
 * reasons as {@link ssim} — every window is computed by the same loop shape.
 *
 * RESOLUTION LIMIT (measured, not incidental). The score is far more stable
 * across viewport size than global SSIM, but only for changes large enough to
 * survive the fixed `size`x`size` downsample. A change occupying less than
 * roughly one window (`window/size` of a frame edge, ~6% at the defaults) can be
 * averaged away before the windows see it — and how much of the frame it
 * occupies is itself viewport-relative, so the downsample reintroduces exactly
 * the viewport-dependence min-over-windows removes at the SSIM step, just moved
 * to the resampling step. Measured on a 7-character status-word flip: at a 128px
 * signature its tier membership varied across 600px-2560px viewports (key /
 * change / none); at 512px it was stable (always key). A form fill, being a
 * larger region, is stable at 128px. Pick `size` for the smallest change that
 * must be reliably classified, against the per-frame CPU cost (512px is ~5x
 * 128px). The default 128 is right for real interactions; sub-resolution changes
 * on very large viewports need a larger signature.
 *
 * @param size Edge length of the square signature. Inferred from `a.length`
 *             when omitted.
 * @throws on length mismatch, empty input, or a non-square signature.
 */
export function changeScore(
  a: Float32Array,
  b: Float32Array,
  options: { size?: number; window?: number } = {},
): number {
  if (a.length !== b.length) {
    throw new Error(`changeScore: signature length mismatch (${a.length} vs ${b.length})`);
  }
  if (a.length === 0) {
    throw new Error("changeScore: signatures must not be empty");
  }

  const size = options.size ?? Math.round(Math.sqrt(a.length));
  if (size * size !== a.length) {
    throw new Error(
      `changeScore: signature of ${a.length} values is not square (${size}x${size}); ` +
        "pass an explicit size",
    );
  }

  const win = options.window ?? CHANGE_WINDOW;
  // A signature smaller than one window has nothing to localise; the global
  // score is the honest answer rather than a fabricated window.
  if (win <= 1 || size < win) return ssim(a, b);

  let worst = Number.POSITIVE_INFINITY;
  const n = win * win;

  for (let originY = 0; originY + win <= size; originY += win) {
    for (let originX = 0; originX + win <= size; originX += win) {
      let sumA = 0;
      let sumB = 0;
      for (let y = 0; y < win; y++) {
        const row = (originY + y) * size + originX;
        for (let x = 0; x < win; x++) {
          sumA += a[row + x]!;
          sumB += b[row + x]!;
        }
      }
      const muA = sumA / n;
      const muB = sumB / n;

      let sqA = 0;
      let sqB = 0;
      let sqAB = 0;
      for (let y = 0; y < win; y++) {
        const row = (originY + y) * size + originX;
        for (let x = 0; x < win; x++) {
          const da = a[row + x]! - muA;
          const db = b[row + x]! - muB;
          sqA += da * da;
          sqB += db * db;
          sqAB += da * db;
        }
      }
      const denom = n - 1;
      const varA = sqA / denom;
      const varB = sqB / denom;
      const cov = sqAB / denom;

      const score =
        ((2 * muA * muB + C1) * (2 * cov + C2)) /
        ((muA * muA + muB * muB + C1) * (varA + varB + C2));
      if (score < worst) worst = score;
    }
  }

  return Math.min(1, Math.max(-1, worst));
}

/**
 * Indices whose SSIM against the previous frame fell below `threshold`.
 *
 * `null` entries (frame 0, or frames where SSIM was not computed) are skipped
 * rather than treated as maximal change.
 */
export function detectChangePoints(scores: (number | null)[], threshold: number): number[] {
  const points: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i];
    if (score === null || score === undefined) continue;
    if (score < threshold) points.push(i);
  }
  return points;
}
