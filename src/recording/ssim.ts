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
