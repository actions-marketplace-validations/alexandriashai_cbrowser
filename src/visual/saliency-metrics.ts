/**
 * Saliency evaluation metrics against human fixation ground truth.
 *
 * WHY THIS IS IN src/ AND NOT research/
 *
 * The Study 1 benchmark (UEyes, Jiang et al. CHI 2023 — 495 web pages, 62
 * participants) reported AUC-Judd 0.663 / NSS 0.544 / CC 0.216 for the COT
 * saliency model. Those numbers were produced by a *Python reimplementation*
 * whose own docstring calls it a "vectorized Python port of CBrowser's
 * computeLabSaliency()" — and the port had already drifted from the shipped
 * code on the day the results were written: the TypeScript weights chrominance
 * 3x over luminance (wA = wB = 3.0), the Python summed all three Lab channels
 * unweighted.
 *
 * So the published accuracy claim did not describe the shipped model. Not
 * because anyone was careless — because two implementations of one concept with
 * nothing binding them will always drift, and a number is the last place that
 * shows up.
 *
 * Putting the metrics here means the benchmark scores the code that ships, by
 * construction. There is one saliency implementation and the evaluator calls it.
 *
 * THE METRICS
 *
 * Standard in the saliency literature (Bylinskii et al., "What do different
 * evaluation metrics tell us about saliency models?", TPAMI 2019). They
 * disagree with each other on purpose, and reporting one alone is how models
 * get oversold:
 *
 * - AUC-Judd — location-based, ranks fixated pixels against all others.
 *   Invariant to monotonic rescaling, so it says nothing about calibration.
 *   Chance = 0.5.
 * - NSS — value-based, mean normalized saliency at fixated points. Sensitive to
 *   false positives in a way AUC is not. Chance = 0.
 * - CC — distribution-based, linear correlation with the full fixation map.
 *   Penalises both misses and false alarms symmetrically. Range [-1, 1].
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

/** A grid of saliency values. Row-major, any scale. */
export interface SaliencyGrid {
  values: Float64Array | number[];
  width: number;
  height: number;
}

/** A single human fixation, in the grid's coordinate space. */
export interface Fixation {
  x: number;
  y: number;
  /** Dwell in ms, if known. Unused by these metrics but carried for weighting. */
  duration?: number;
}

export interface SaliencyScores {
  /** Ranks fixated pixels against all pixels. Chance 0.5. */
  aucJudd: number;
  /** Mean normalized saliency at fixations. Chance 0. */
  nss: number;
  /** Pearson correlation with the ground-truth map. Range [-1, 1]. */
  cc: number;
  /** How many fixations landed inside the grid and were scored. */
  fixationsScored: number;
}

/** Normalize to zero mean, unit standard deviation. */
function standardize(values: ArrayLike<number>): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (values[i] - mean) ** 2;
  variance /= n;
  const sd = Math.sqrt(variance);
  if (sd === 0) return out; // A flat map carries no signal; NSS is 0, not NaN.
  for (let i = 0; i < n; i++) out[i] = (values[i] - mean) / sd;
  return out;
}

/**
 * Normalized Scanpath Saliency: the mean of the standardized saliency map at
 * fixated locations.
 *
 * Unlike AUC this punishes a map that is salient everywhere — standardizing
 * first means a model cannot buy score by raising the whole map.
 */
export function computeNSS(grid: SaliencyGrid, fixations: Fixation[]): { nss: number; scored: number } {
  const z = standardize(grid.values);
  let sum = 0;
  let scored = 0;
  for (const f of fixations) {
    const x = Math.floor(f.x);
    const y = Math.floor(f.y);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
    sum += z[y * grid.width + x];
    scored++;
  }
  return { nss: scored > 0 ? sum / scored : 0, scored };
}

/**
 * AUC-Judd: sweep a threshold over the saliency map; at each level the true
 * positive rate is the share of fixations above it and the false positive rate
 * is the share of ALL pixels above it. Area under that curve.
 *
 * Thresholds are the saliency values AT the fixations, which is what makes this
 * Judd's variant rather than Borji's — no random negative sampling, so it is
 * deterministic. That matters here: a metric used to compare model revisions
 * must not itself introduce variance between runs.
 */
export function computeAUCJudd(grid: SaliencyGrid, fixations: Fixation[]): { auc: number; scored: number } {
  const n = grid.values.length;
  const inBounds: number[] = [];
  for (const f of fixations) {
    const x = Math.floor(f.x);
    const y = Math.floor(f.y);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
    inBounds.push(grid.values[y * grid.width + x]);
  }
  if (inBounds.length === 0 || n === 0) return { auc: 0.5, scored: 0 };

  // Sorted copy of the whole map, so each threshold's false-positive rate is a
  // binary search rather than a scan — O(n log n) once instead of O(n) per
  // fixation, which is the difference between usable and not on 1980 images.
  const sorted = Float64Array.from(grid.values as ArrayLike<number>).sort();
  const countAbove = (t: number): number => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return sorted.length - lo;
  };

  const nFix = inBounds.length;

  // UNIQUE thresholds, and TPR counted rather than assumed.
  //
  // Using (i+1)/nFix as the true-positive rate assumes every fixation sits at a
  // distinct saliency value. Ties break it badly, and ties are the normal case:
  // on a flat map every threshold is identical, so FPR jumped straight to 1
  // while TPR was still 1/nFix — which scored a flat map 0.25 instead of the
  // 0.5 that "carries no information" must produce, and pinned the WORST
  // possible predictor at exactly 0.5. Both are the same arithmetic slip.
  // Counting both rates at each distinct threshold is Judd's formulation.
  // (2026-07-29)
  const uniqueThresholds = [...new Set(inBounds)].sort((a, b) => b - a);
  const fixSorted = [...inBounds].sort((a, b) => a - b);
  const fixAtOrAbove = (t: number): number => {
    let lo = 0;
    let hi = fixSorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (fixSorted[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return fixSorted.length - lo;
  };

  // Curve from (0,0) through each threshold to (1,1), trapezoidal integration.
  let auc = 0;
  let prevFpr = 0;
  let prevTpr = 0;
  for (const t of uniqueThresholds) {
    const tpr = fixAtOrAbove(t) / nFix;
    const fpr = countAbove(t) / n;
    auc += ((fpr - prevFpr) * (tpr + prevTpr)) / 2;
    prevFpr = fpr;
    prevTpr = tpr;
  }
  auc += ((1 - prevFpr) * (1 + prevTpr)) / 2;
  return { auc: Math.min(1, Math.max(0, auc)), scored: nFix };
}

/**
 * Pearson correlation between the predicted map and a ground-truth fixation
 * density map. Both are standardized, so this is scale-invariant.
 */
export function computeCC(grid: SaliencyGrid, groundTruth: SaliencyGrid): number {
  if (grid.values.length !== groundTruth.values.length) {
    throw new Error(
      `CC needs matching grids: predicted ${grid.width}x${grid.height} vs ground truth ${groundTruth.width}x${groundTruth.height}. ` +
        `Resample one before comparing — silently reshaping here would compare unrelated regions.`,
    );
  }
  const a = standardize(grid.values);
  const b = standardize(groundTruth.values);
  let num = 0;
  for (let i = 0; i < a.length; i++) num += a[i] * b[i];
  // Both are unit-variance, so the denominator is n.
  return a.length > 0 ? num / a.length : 0;
}

/**
 * Score a predicted saliency map against human fixations.
 *
 * `groundTruth` (a fixation density map) is optional because CC needs one while
 * AUC and NSS need only the fixation points. Reporting CC as 0 when it was
 * never computable would be indistinguishable from a genuinely uncorrelated
 * model, so it is omitted from the average rather than faked.
 */
export function scoreSaliency(
  predicted: SaliencyGrid,
  fixations: Fixation[],
  groundTruth?: SaliencyGrid,
): SaliencyScores {
  const { auc, scored } = computeAUCJudd(predicted, fixations);
  const { nss } = computeNSS(predicted, fixations);
  return {
    aucJudd: auc,
    nss,
    cc: groundTruth ? computeCC(predicted, groundTruth) : Number.NaN,
    fixationsScored: scored,
  };
}

/**
 * Resample a grid to a target size by area-averaging.
 *
 * Ground-truth fixation maps and predicted grids rarely share dimensions, and
 * comparing them at different resolutions is the mistake `computeCC` refuses to
 * make silently. This is the explicit way to reconcile them.
 */
export function resampleGrid(grid: SaliencyGrid, width: number, height: number): SaliencyGrid {
  const out = new Float64Array(width * height);
  const xScale = grid.width / width;
  const yScale = grid.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yScale);
    const y1 = Math.min(grid.height, Math.max(y0 + 1, Math.ceil((y + 1) * yScale)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xScale);
      const x1 = Math.min(grid.width, Math.max(x0 + 1, Math.ceil((x + 1) * xScale)));
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          sum += grid.values[yy * grid.width + xx];
          count++;
        }
      }
      out[y * width + x] = count > 0 ? sum / count : 0;
    }
  }
  return { values: out, width, height };
}
