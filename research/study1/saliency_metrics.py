"""
saliency_metrics.py — Evaluation metrics for saliency prediction.

Compares predicted saliency maps (from cot_saliency.py) against
UEyes human fixation density maps using standard saliency metrics
from Bylinskii et al. (IEEE TPAMI 2019).

Metrics implemented:
  - AUC-Judd: Area under ROC curve (fixation locations vs. saliency)
  - NSS: Normalized Scanpath Saliency (z-scored saliency at fixation points)
  - CC: Linear Correlation Coefficient (Pearson r between maps)
  - SIM: Similarity (histogram intersection of normalized maps)
  - KL: KL-Divergence (information-theoretic difference)
  - EMD/W1: Earth Mover's Distance (Wasserstein-1 between distributions)

All metrics from: Bylinskii et al., "What Do Different Evaluation Metrics
Tell Us About Saliency Models?" IEEE TPAMI 2019.
"""

import numpy as np
from scipy.ndimage import gaussian_filter
from scipy.stats import pearsonr
from typing import Dict, Optional


def normalize_map(smap: np.ndarray) -> np.ndarray:
    """Normalize saliency map to [0, 1]."""
    smap = smap.astype(np.float64)
    min_val = np.min(smap)
    max_val = np.max(smap)
    if max_val - min_val < 1e-10:
        return np.zeros_like(smap)
    return (smap - min_val) / (max_val - min_val)


def to_distribution(smap: np.ndarray) -> np.ndarray:
    """Convert saliency map to probability distribution (sums to 1)."""
    smap = smap.astype(np.float64)
    smap = np.maximum(smap, 0)
    total = np.sum(smap)
    if total < 1e-10:
        return np.ones_like(smap) / smap.size
    return smap / total


def auc_judd(
    predicted: np.ndarray,
    fixation_map: np.ndarray,
    jitter: bool = True,
) -> float:
    """
    AUC-Judd: Area under the ROC curve.

    Treats fixation locations as positive samples, non-fixation as negative.
    Sweeps threshold over predicted saliency to compute true/false positive rates.

    Higher = better. Chance = 0.5.
    """
    pred = normalize_map(predicted).flatten()
    fix = (fixation_map > 0).astype(bool).flatten()

    n_fix = np.sum(fix)
    n_nonfix = len(fix) - n_fix

    if n_fix == 0 or n_nonfix == 0:
        return 0.5

    # Get saliency values at fixation and non-fixation points
    fix_saliency = pred[fix].copy()
    nonfix_saliency = pred[~fix]

    if jitter:
        fix_saliency += np.random.rand(n_fix) * 1e-7

    # Sort non-fixation values (ascending) for vectorized FPR computation
    nonfix_sorted = np.sort(nonfix_saliency)

    # Sort fixation saliency (descending) as thresholds
    thresholds = np.sort(fix_saliency)[::-1]

    # Vectorized FPR: count non-fixation values >= each threshold
    # searchsorted gives insertion index; count >= threshold = n - index
    fpr_counts = n_nonfix - np.searchsorted(nonfix_sorted, thresholds, side='left')

    # Build TPR and FPR arrays
    tpr = np.zeros(len(thresholds) + 2)
    fpr = np.zeros(len(thresholds) + 2)
    tpr[0], fpr[0] = 0, 0
    tpr[-1], fpr[-1] = 1, 1
    tpr[1:-1] = np.arange(1, n_fix + 1) / n_fix
    fpr[1:-1] = fpr_counts / n_nonfix

    # Sort by FPR for proper integration
    sorted_indices = np.argsort(fpr)
    fpr = fpr[sorted_indices]
    tpr = tpr[sorted_indices]

    # Compute AUC via trapezoidal rule
    try:
        auc = np.trapezoid(tpr, fpr)
    except AttributeError:
        auc = np.trapz(tpr, fpr)
    return float(auc)


def nss(
    predicted: np.ndarray,
    fixation_map: np.ndarray,
) -> float:
    """
    NSS: Normalized Scanpath Saliency.

    Z-scores the predicted map, then averages at fixation locations.
    Higher = better. 0 = chance.
    """
    pred = predicted.astype(np.float64).flatten()
    fix = (fixation_map > 0).astype(bool).flatten()

    n_fix = np.sum(fix)
    if n_fix == 0:
        return 0.0

    # Z-score the predicted map
    mean_pred = np.mean(pred)
    std_pred = np.std(pred)
    if std_pred < 1e-10:
        return 0.0

    z_pred = (pred - mean_pred) / std_pred

    # Average z-score at fixation locations
    return float(np.mean(z_pred[fix]))


def cc(
    predicted: np.ndarray,
    fixation_density: np.ndarray,
) -> float:
    """
    CC: Linear Correlation Coefficient (Pearson's r).

    Measures linear relationship between predicted and ground-truth density maps.
    Range: [-1, 1]. Higher = better.
    """
    pred = predicted.astype(np.float64).flatten()
    gt = fixation_density.astype(np.float64).flatten()

    if np.std(pred) < 1e-10 or np.std(gt) < 1e-10:
        return 0.0

    r, _ = pearsonr(pred, gt)
    return float(r)


def sim(
    predicted: np.ndarray,
    fixation_density: np.ndarray,
) -> float:
    """
    SIM: Similarity (histogram intersection).

    Converts both maps to distributions and computes sum of element-wise minimums.
    Range: [0, 1]. Higher = better.
    """
    pred_dist = to_distribution(predicted)
    gt_dist = to_distribution(fixation_density)

    return float(np.sum(np.minimum(pred_dist, gt_dist)))


def kl_divergence(
    predicted: np.ndarray,
    fixation_density: np.ndarray,
    eps: float = 1e-10,
) -> float:
    """
    KL: Kullback-Leibler Divergence.

    KL(GT || Predicted). Lower = better. 0 = identical distributions.
    """
    pred_dist = to_distribution(predicted) + eps
    gt_dist = to_distribution(fixation_density) + eps

    # Renormalize after epsilon addition
    pred_dist /= np.sum(pred_dist)
    gt_dist /= np.sum(gt_dist)

    return float(np.sum(gt_dist * np.log(gt_dist / pred_dist)))


def emd_w1(
    predicted: np.ndarray,
    fixation_density: np.ndarray,
) -> float:
    """
    EMD/W1: Earth Mover's Distance (1D approximation).

    Wasserstein-1 distance between the two distributions.
    Uses CDF difference for efficiency.
    Lower = better.
    """
    pred_dist = to_distribution(predicted).flatten()
    gt_dist = to_distribution(fixation_density).flatten()

    # 1D Wasserstein via CDF difference
    pred_cdf = np.cumsum(pred_dist)
    gt_cdf = np.cumsum(gt_dist)

    return float(np.sum(np.abs(pred_cdf - gt_cdf)))


def information_gain(
    predicted: np.ndarray,
    fixation_map: np.ndarray,
    baseline: Optional[np.ndarray] = None,
) -> float:
    """
    IG: Information Gain over center-bias baseline.

    Measures bits of information the model provides beyond a center-bias prior.
    If no baseline provided, uses a centered Gaussian.
    """
    pred = normalize_map(predicted)
    fix = (fixation_map > 0).astype(bool)

    if baseline is None:
        h, w = predicted.shape[:2]
        y, x = np.mgrid[0:h, 0:w]
        cy, cx = h / 2, w / 2
        baseline = np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * (min(h, w) / 4) ** 2))

    pred_dist = to_distribution(pred)
    base_dist = to_distribution(baseline)

    eps = 1e-10
    pred_at_fix = pred_dist[fix]
    base_at_fix = base_dist[fix]

    # IG = mean(log2(pred/baseline)) at fixation points
    ig = np.mean(np.log2((pred_at_fix + eps) / (base_at_fix + eps)))
    return float(ig)


# ── Batch Evaluation ──

def evaluate_saliency(
    predicted: np.ndarray,
    fixation_density: np.ndarray,
    fixation_binary: Optional[np.ndarray] = None,
) -> Dict[str, float]:
    """
    Compute all saliency metrics for a predicted vs. ground-truth pair.

    Args:
        predicted: Predicted saliency map (any resolution, will be resized)
        fixation_density: Ground-truth fixation density map (continuous)
        fixation_binary: Binary fixation map (1 at fixation, 0 elsewhere).
                        If None, thresholded from fixation_density.

    Returns: Dict with all metric values.
    """
    from skimage.transform import resize

    # Ensure same size
    target_shape = fixation_density.shape[:2]
    if predicted.shape[:2] != target_shape:
        predicted = resize(predicted, target_shape, anti_aliasing=True)

    # Create binary fixation map if not provided
    if fixation_binary is None:
        # Threshold at top 10% of density
        threshold = np.percentile(fixation_density[fixation_density > 0], 90) \
            if np.any(fixation_density > 0) else 0.5
        fixation_binary = (fixation_density >= threshold).astype(float)

    metrics = {
        'AUC_Judd': auc_judd(predicted, fixation_binary),
        'NSS': nss(predicted, fixation_binary),
        'CC': cc(predicted, fixation_density),
        'SIM': sim(predicted, fixation_density),
        'KL': kl_divergence(predicted, fixation_density),
        'EMD_W1': emd_w1(predicted, fixation_density),
        'IG': information_gain(predicted, fixation_binary),
    }

    return metrics


def center_bias_baseline(h: int, w: int) -> np.ndarray:
    """
    Generate a center-bias baseline saliency map.
    Most eye-tracking datasets show strong center bias.
    """
    y, x = np.mgrid[0:h, 0:w]
    cy, cx = h / 2, w / 2
    sigma = min(h, w) / 4
    baseline = np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2))
    return baseline / np.max(baseline)


if __name__ == '__main__':
    # Quick self-test with synthetic data
    print("Running saliency metrics self-test...")

    h, w = 100, 150

    # Create a synthetic "predicted" map (hot spot upper-left)
    predicted = np.zeros((h, w))
    predicted[10:30, 10:40] = 1.0
    predicted = gaussian_filter(predicted, sigma=5)

    # Create a "ground truth" fixation density (hot spot same area)
    gt_density = np.zeros((h, w))
    gt_density[15:35, 15:45] = 1.0
    gt_density = gaussian_filter(gt_density, sigma=5)

    # Binary fixations
    gt_binary = np.zeros((h, w))
    gt_binary[20, 25] = 1
    gt_binary[25, 30] = 1
    gt_binary[18, 20] = 1

    metrics = evaluate_saliency(predicted, gt_density, gt_binary)
    print("\nMetrics (overlapping predictions):")
    for k, v in metrics.items():
        print(f"  {k}: {v:.4f}")

    # Test with random prediction (should be near chance)
    random_pred = np.random.rand(h, w)
    metrics_random = evaluate_saliency(random_pred, gt_density, gt_binary)
    print("\nMetrics (random prediction):")
    for k, v in metrics_random.items():
        print(f"  {k}: {v:.4f}")

    # Verify: good prediction should beat random on most metrics
    assert metrics['AUC_Judd'] > metrics_random['AUC_Judd'] - 0.1, \
        "Good prediction should have higher AUC than random"
    assert metrics['CC'] > metrics_random['CC'], \
        "Good prediction should have higher CC than random"

    print("\nSelf-test PASSED")
