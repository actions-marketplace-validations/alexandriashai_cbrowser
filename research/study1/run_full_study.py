#!/usr/bin/env python3
"""
Study 1: Full benchmark with persona-specific saliency + CTC correlation.

Runs on UEyes web images (495 pages):
1. Generic COT W2 saliency (center-surround on CIE-Lab)
2. Persona-specific saliency (6 personas with attention filters)
3. Center bias + random baselines
4. CTC-to-fixation-complexity correlation
5. Per-persona metric breakdown
"""

import os
import sys
import csv
import json
import time
import numpy as np
from pathlib import Path
from PIL import Image
from scipy.ndimage import gaussian_filter, uniform_filter
from scipy.stats import pearsonr, spearmanr

# ── Persona Attention Profiles ──

PERSONAS = {
    'neurotypical': {
        'novelty_weight': 1.0,
        'text_weight': 1.0,
        'global_integration': 1.0,
        'peripheral_sensitivity': 1.0,
        'threshold_pct': 50,
    },
    'adhd': {
        'novelty_weight': 2.0,    # color pops grab attention
        'text_weight': 0.5,       # text ignored
        'global_integration': 0.4, # poor big-picture
        'peripheral_sensitivity': 1.5,
        'threshold_pct': 30,      # lower = more distracted
    },
    'low_vision': {
        'novelty_weight': 0.3,
        'text_weight': 0.8,
        'global_integration': 0.6,
        'peripheral_sensitivity': 0.3,
        'threshold_pct': 70,      # only big/bold things
    },
    'elderly': {
        'novelty_weight': 0.7,
        'text_weight': 1.3,       # concentrated on text
        'global_integration': 0.8,
        'peripheral_sensitivity': 0.6,
        'threshold_pct': 55,
    },
    'dyslexic': {
        'novelty_weight': 1.0,
        'text_weight': 1.5,       # fixates longer on text
        'global_integration': 0.9,
        'peripheral_sensitivity': 0.9,
        'threshold_pct': 50,
    },
    'color_blind': {
        'novelty_weight': 0.7,    # reduced color pop detection
        'text_weight': 1.1,       # relies more on text/structure than color
        'global_integration': 0.9,
        'peripheral_sensitivity': 0.8,
        'threshold_pct': 50,
        'color_attenuation': (0.6, 1.0, 0.8),  # deuteranopia: reduced red-green
    },
}

# ── Saliency Computation ──

def compute_base_saliency(img_rgb):
    """W2 center-surround on CIE-Lab."""
    from skimage import color
    lab = color.rgb2lab(img_rgb)
    h, w, _ = lab.shape
    saliency = np.zeros((h, w))

    for ch in range(3):
        channel = lab[:, :, ch].astype(np.float64)
        for sc, ss in [(2, 8), (4, 16), (8, 32)]:
            center = gaussian_filter(channel, sc)
            surround = gaussian_filter(channel, ss)
            saliency += np.abs(center - surround)

    mn, mx = saliency.min(), saliency.max()
    if mx > mn:
        saliency = (saliency - mn) / (mx - mn)
    return saliency


def compute_text_map(gray):
    """Horizontal edge dominance → text regions."""
    from scipy.ndimage import sobel
    h_edges = np.abs(sobel(gray, axis=0))
    v_edges = np.abs(sobel(gray, axis=1))
    text = h_edges / (v_edges + 1e-6)
    text = gaussian_filter(text, sigma=8)
    return np.clip(text / 3.0, 0, 1)


def compute_novelty_map(img_rgb):
    """Color novelty — difference from page mean."""
    from skimage import color
    lab = color.rgb2lab(img_rgb)
    mean_color = np.mean(lab, axis=(0, 1))
    diff = np.sqrt(np.sum((lab - mean_color) ** 2, axis=2))
    diff = gaussian_filter(diff, sigma=4)
    mn, mx = diff.min(), diff.max()
    if mx > mn:
        diff = (diff - mn) / (mx - mn)
    return diff


# ── Schwartz Value Profiles (v18.54.0) ──
# Matches persona-values.ts in the CBrowser codebase

PERSONA_SCHWARTZ = {
    'neurotypical': {'selfDirection': 0.5, 'stimulation': 0.5, 'achievement': 0.5, 'security': 0.5, 'conformity': 0.5, 'tradition': 0.5},
    'adhd': {'selfDirection': 0.7, 'stimulation': 0.9, 'achievement': 0.5, 'security': 0.3, 'conformity': 0.3, 'tradition': 0.2},
    'color_blind': {'selfDirection': 0.5, 'stimulation': 0.5, 'achievement': 0.5, 'security': 0.6, 'conformity': 0.5, 'tradition': 0.5},
    'elderly': {'selfDirection': 0.4, 'stimulation': 0.2, 'achievement': 0.4, 'security': 0.9, 'conformity': 0.7, 'tradition': 0.8},
    'dyslexic': {'selfDirection': 0.5, 'stimulation': 0.4, 'achievement': 0.6, 'security': 0.7, 'conformity': 0.6, 'tradition': 0.5},
    'low_vision': {'selfDirection': 0.4, 'stimulation': 0.3, 'achievement': 0.4, 'security': 0.8, 'conformity': 0.6, 'tradition': 0.7},
}


def compute_value_attention_params(persona_name):
    """
    Compute value-driven saliency filter parameters.
    Ports the TypeScript computeValueAttentionParams() from attention-transport.ts.

    Returns (exponent, bias, center_bias_strength, threshold)
    - exponent: <1 = dispersed attention, >1 = concentrated
    - bias: global saliency boost/suppress
    - center_bias_strength: 0-1 how much center is boosted
    - threshold: below this, saliency is suppressed
    """
    values = PERSONA_SCHWARTZ.get(persona_name, PERSONA_SCHWARTZ['neurotypical'])
    v = lambda key: values.get(key, 0.5)

    exponent = 1.0
    bias = 0.0
    center_bias_str = 0.0
    threshold_adj = 0.0

    # Stimulation: high → dispersed attention (notices novelty everywhere)
    exponent -= (v('stimulation') - 0.5) * 0.4

    # Security: high → vigilant scanning
    bias += (v('security') - 0.5) * 0.15
    threshold_adj -= (v('security') - 0.5) * 0.1

    # Achievement: high → concentrated on high-value targets
    exponent += (v('achievement') - 0.5) * 0.3

    # Conformity: high → center-biased (follows expected layout)
    center_bias_str += (v('conformity') - 0.5) * 0.3

    # Self-direction: high → less center-biased (explores periphery)
    center_bias_str -= (v('selfDirection') - 0.5) * 0.2

    # Tradition: high → suppresses novel elements
    threshold_adj += (v('tradition') - 0.5) * 0.1

    # Clamp
    exponent = max(0.3, min(2.0, exponent))
    bias = max(-0.3, min(0.3, bias))
    center_bias_str = max(0.0, min(1.0, center_bias_str))
    threshold_adj = max(-0.2, min(0.2, threshold_adj))

    return exponent, bias, center_bias_str, threshold_adj


def predict_saliency(img_rgb, persona_name='neurotypical', use_values=True):
    """Generate persona-specific saliency map with value-driven attention modulation."""
    from skimage import color
    profile = PERSONAS[persona_name]
    gray = color.rgb2gray(img_rgb)
    h, w = gray.shape

    # Apply color attenuation for color blindness before computing saliency
    img_for_saliency = img_rgb.copy()
    if 'color_attenuation' in profile:
        # Deuteranopia: reduce red-green channel contribution
        # Simulates reduced M-cone sensitivity
        att = profile['color_attenuation']  # (r_scale, g_scale, b_scale)
        img_for_saliency = img_for_saliency.astype(np.float64)
        img_for_saliency[:, :, 0] *= att[0]  # Red
        img_for_saliency[:, :, 1] *= att[1]  # Green
        img_for_saliency[:, :, 2] *= att[2]  # Blue
        img_for_saliency = np.clip(img_for_saliency, 0, 255).astype(np.uint8)

    base = compute_base_saliency(img_for_saliency)
    text_map = compute_text_map(gray)
    novelty = compute_novelty_map(img_for_saliency)

    # Center bias
    cy, cx = h / 2, w / 2
    yy, xx = np.mgrid[0:h, 0:w]
    center_bias = np.exp(-((yy - cy)**2 + (xx - cx)**2) / (2 * (min(h, w) * 0.3)**2))
    peripheral = 1.0 - center_bias

    # Combine with persona weights
    saliency = (
        base * profile['global_integration'] +
        novelty * profile['novelty_weight'] +
        text_map * profile['text_weight'] +
        peripheral * profile['peripheral_sensitivity']
    )

    # Center bias modulation
    saliency = saliency * (0.3 + 0.7 * center_bias * profile['global_integration'])

    # Normalize to [0,1] FIRST
    mn, mx = saliency.min(), saliency.max()
    if mx > mn:
        saliency = (saliency - mn) / (mx - mn)

    # ── Value-driven attention modulation (v18.54.0) ──
    if use_values and persona_name in PERSONA_SCHWARTZ:
        exponent, bias, center_bias_str, threshold_adj = compute_value_attention_params(persona_name)

        # Apply power curve (exponent controls concentration vs dispersion)
        saliency = np.power(np.clip(saliency, 0, 1), exponent)

        # Apply value-driven center bias (adds to persona's existing center bias)
        if center_bias_str > 0:
            dist = np.sqrt((yy - cy)**2 + (xx - cx)**2) / np.sqrt(cy**2 + cx**2)
            saliency *= (1 - dist * center_bias_str)

        # Apply global bias
        saliency *= (1 + bias)

        # Renormalize before thresholding
        mn, mx = saliency.min(), saliency.max()
        if mx > mn:
            saliency = (saliency - mn) / (mx - mn)

        # Adjusted threshold
        adjusted_threshold = max(0, profile['threshold_pct'] + threshold_adj * 100)
    else:
        adjusted_threshold = profile['threshold_pct']

    # Threshold — suppress below-threshold regions
    thr = np.percentile(saliency, adjusted_threshold)
    saliency[saliency < thr] *= 0.1

    # Light smoothing to approximate fixation density (not too much or it goes flat)
    saliency = gaussian_filter(saliency, sigma=min(h, w) * 0.02)

    # Final normalize to [0,1] — NOT to sum=1 (that creates flat distributions)
    mn, mx = saliency.min(), saliency.max()
    if mx > mn:
        saliency = (saliency - mn) / (mx - mn)
    return saliency


# ── Metrics ──

def auc_judd(smap, fmap):
    """AUC-Judd score."""
    s = smap.ravel()
    f = fmap.ravel()
    if f.max() > 1:
        f = f / f.max()
    # For binary fixation maps (0/1), use f > 0
    # For continuous density maps, use a percentile threshold
    n_unique = len(np.unique(f[f > 0])) if np.any(f > 0) else 0
    if n_unique <= 2:
        fix = f > 0  # binary map
    else:
        thresh = np.percentile(f[f > 0], 70)
        fix = f > thresh
    if not np.any(fix):
        return 0.5
    s_fix = s[fix]
    s_nonfix = s[~fix]
    thresholds = np.linspace(0, s.max(), 100)
    tp = np.array([np.mean(s_fix >= t) for t in thresholds])
    fp = np.array([np.mean(s_nonfix >= t) for t in thresholds])
    idx = np.argsort(fp)
    trapz_fn = getattr(np, 'trapezoid', getattr(np, 'trapz', None))
    return float(trapz_fn(tp[idx], fp[idx]))


def nss(smap, fmap):
    s = smap.astype(np.float64)
    s = (s - s.mean()) / (s.std() + 1e-8)
    f = fmap.astype(np.float64)
    if f.max() > 1:
        f = f / f.max()
    n_unique = len(np.unique(f[f > 0])) if np.any(f > 0) else 0
    if n_unique <= 2:
        fix = f > 0
    else:
        thresh = np.percentile(f[f > 0], 70)
        fix = f > thresh
    if not np.any(fix):
        return 0.0
    return float(np.mean(s[fix]))


def cc(smap, fmap):
    s = smap.ravel().astype(np.float64)
    f = fmap.ravel().astype(np.float64)
    s = (s - s.mean()) / (s.std() + 1e-8)
    f = (f - f.mean()) / (f.std() + 1e-8)
    return float(np.corrcoef(s, f)[0, 1])


def sim(smap, fmap):
    s = smap.astype(np.float64)
    f = fmap.astype(np.float64)
    s = s / (s.sum() + 1e-8)
    f = f / (f.sum() + 1e-8)
    return float(np.sum(np.minimum(s, f)))


def kld(smap, fmap):
    s = smap.astype(np.float64)
    f = fmap.astype(np.float64)
    s = s / (s.sum() + 1e-8) + 1e-8
    f = f / (f.sum() + 1e-8) + 1e-8
    return float(np.sum(f * np.log(f / s)))


def evaluate(pred, gt):
    from skimage.transform import resize
    if pred.shape != gt.shape:
        pred = resize(pred, gt.shape, anti_aliasing=True)
    return {
        'AUC': auc_judd(pred, gt),
        'NSS': nss(pred, gt),
        'CC': cc(pred, gt),
        'SIM': sim(pred, gt),
        'KLD': kld(pred, gt),
    }


# ── Fixation Complexity (for CTC correlation) ──

def fixation_complexity(fmap):
    f = fmap.astype(np.float64)
    f = f / (f.sum() + 1e-8)
    h, w = f.shape
    flat = f.ravel()
    flat = flat[flat > 0]
    entropy = -np.sum(flat * np.log2(flat)) if len(flat) > 0 else 0

    yy, xx = np.mgrid[0:h, 0:w]
    my = np.sum(yy * f)
    mx = np.sum(xx * f)
    vy = np.sum((yy - my)**2 * f)
    vx = np.sum((xx - mx)**2 * f)
    dispersion = np.sqrt(vy + vx)

    return {'entropy': float(entropy), 'dispersion': float(dispersion)}


# ── Page Demand Features (for CTC) ──

def compute_page_demand(img_rgb):
    """Compute simple demand features from image."""
    from skimage import color, filters, measure
    gray = color.rgb2gray(img_rgb)
    h, w = gray.shape

    edges = np.mean(np.abs(filters.sobel(gray)))
    hist, _ = np.histogram(gray, bins=256, range=(0, 1), density=True)
    hist = hist[hist > 0]
    pixel_entropy = -np.sum(hist * np.log2(hist))

    binary = gray > filters.threshold_otsu(gray)
    labeled = measure.label(binary)
    region_count = labeled.max()

    local_std = uniform_filter(gray**2, size=32) - uniform_filter(gray, size=32)**2
    local_std = np.sqrt(np.maximum(0, local_std))
    congestion = np.mean(local_std)

    return {
        'edge_density': float(edges),
        'pixel_entropy': float(pixel_entropy),
        'region_count': int(region_count),
        'congestion': float(congestion),
        'total_demand': float(edges * 0.3 + pixel_entropy / 8 * 0.3 + min(1, region_count / 100) * 0.2 + congestion * 5 * 0.2),
    }


# ── Main Benchmark ──

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset', default='UEyes_dataset')
    parser.add_argument('--output', default='results_full')
    parser.add_argument('--max-images', type=int, default=None)
    args = parser.parse_args()

    dataset_dir = Path(args.dataset)
    if not dataset_dir.is_absolute():
        dataset_dir = Path(__file__).parent / dataset_dir
    output_dir = Path(args.output)
    if not output_dir.is_absolute():
        output_dir = Path(__file__).parent / output_dir
    output_dir.mkdir(exist_ok=True)

    # Find web images
    images_dir = dataset_dir / 'images'
    fixmaps_dir = dataset_dir / 'saliency_maps' / 'fixmaps_3s'
    heatmaps_dir = dataset_dir / 'saliency_maps' / 'heatmaps_3s'

    # Filter to web only
    web_names = set()
    types_csv = dataset_dir / 'image_types.csv'
    if types_csv.exists():
        with open(str(types_csv)) as f:
            for row in csv.DictReader(f, delimiter=';'):
                if row.get('Category', '').lower() == 'web':
                    web_names.add(row['Image Name'])

    all_imgs = sorted(images_dir.glob('*.png')) + sorted(images_dir.glob('*.jpg'))
    if web_names:
        all_imgs = [p for p in all_imgs if p.name in web_names]
    if args.max_images:
        all_imgs = all_imgs[:args.max_images]

    print(f"Study 1: {len(all_imgs)} web images, {len(PERSONAS)} personas + 2 baselines")
    print(f"Output: {output_dir}\n")

    results = []
    ctc_data = []

    for i, img_path in enumerate(all_imgs):
        t0 = time.time()
        name = img_path.stem

        try:
            img = np.array(Image.open(str(img_path)).convert('RGB'))
            h, w = img.shape[:2]

            # Load ground truth — BOTH fixmap (binary, for AUC/NSS) and heatmap (continuous, for CC/SIM/KLD)
            gt_fixmap = None
            gt_heatmap = None
            for ext in ['.png', '.jpg']:
                fpath = fixmaps_dir / (name + ext)
                if fpath.exists():
                    gt_fixmap = np.array(Image.open(str(fpath)).convert('L')).astype(np.float64)
                    gt_fixmap = gt_fixmap / (gt_fixmap.max() + 1e-8)
                    break
            for ext in ['.png', '.jpg']:
                hpath = heatmaps_dir / (name + ext)
                if hpath.exists():
                    gt_heatmap = np.array(Image.open(str(hpath)).convert('L')).astype(np.float64)
                    gt_heatmap = gt_heatmap / (gt_heatmap.max() + 1e-8)
                    break

            if gt_fixmap is None and gt_heatmap is None:
                continue

            # Use fixmap for AUC/NSS (ranking metrics), heatmap for CC/SIM/KLD (spatial correlation)
            gt_ranking = gt_fixmap if gt_fixmap is not None else gt_heatmap
            gt_spatial = gt_heatmap if gt_heatmap is not None else gt_fixmap

            # Fixation complexity for CTC correlation
            fix_cplx = fixation_complexity(gt_ranking)
            page_demand = compute_page_demand(img)

            def eval_split(pred):
                """Evaluate using fixmap for AUC/NSS, heatmap for CC/SIM/KLD."""
                from skimage.transform import resize
                p_rank = resize(pred, gt_ranking.shape, anti_aliasing=True) if pred.shape != gt_ranking.shape else pred
                p_spat = resize(pred, gt_spatial.shape, anti_aliasing=True) if pred.shape != gt_spatial.shape else pred
                return {
                    'AUC': auc_judd(p_rank, gt_ranking),
                    'NSS': nss(p_rank, gt_ranking),
                    'CC': cc(p_spat, gt_spatial),
                    'SIM': sim(p_spat, gt_spatial),
                    'KLD': kld(p_spat, gt_spatial),
                }

            # Center bias baseline
            cy, cx = h / 2, w / 2
            yy, xx = np.mgrid[0:h, 0:w]
            cb = np.exp(-((yy - cy)**2 + (xx - cx)**2) / (2 * (min(h, w) * 0.3)**2))
            cb = cb / (cb.sum() + 1e-8)
            cb_metrics = eval_split(cb)
            results.append({'image': name, 'method': 'CenterBias', **cb_metrics})

            # Random baseline
            rng = np.random.RandomState(42)
            rand = rng.random((h, w))
            rand = rand / (rand.sum() + 1e-8)
            rand_metrics = eval_split(rand)
            results.append({'image': name, 'method': 'Random', **rand_metrics})

            # Per-persona saliency predictions — WITHOUT values (legacy, Study 1 baseline)
            for persona_name in PERSONAS:
                pred = predict_saliency(img, persona_name, use_values=False)
                metrics = eval_split(pred)
                results.append({'image': name, 'method': f'COT_{persona_name}', **metrics})

            # Per-persona saliency predictions — WITH values (v18.54.0, Study 1 updated)
            for persona_name in PERSONAS:
                pred = predict_saliency(img, persona_name, use_values=True)
                metrics = eval_split(pred)
                results.append({'image': name, 'method': f'COTv_{persona_name}', **metrics})

            ctc_data.append({
                'image': name,
                'fix_entropy': fix_cplx['entropy'],
                'fix_dispersion': fix_cplx['dispersion'],
                **page_demand,
            })

            elapsed = time.time() - t0
            if (i + 1) % 10 == 0 or i == 0:
                # Running average for neurotypical
                nt_results = [r for r in results if r['method'] == 'COT_neurotypical']
                avg_auc = np.mean([r['AUC'] for r in nt_results]) if nt_results else 0
                avg_cc = np.mean([r['CC'] for r in nt_results]) if nt_results else 0
                print(f"  [{i+1}/{len(all_imgs)}] {name} ({elapsed:.1f}s) NT AUC={avg_auc:.3f} CC={avg_cc:.3f}")
                sys.stdout.flush()

        except Exception as e:
            print(f"  [{i+1}/{len(all_imgs)}] {name} ERROR: {e}")
            sys.stdout.flush()

    # ── Results Summary ──
    import pandas as pd
    df = pd.DataFrame(results)
    print(f"\n{'='*70}")
    print(f"STUDY 1 RESULTS: {len(all_imgs)} web images")
    print(f"{'='*70}\n")

    summary = df.groupby('method')[['AUC', 'NSS', 'CC', 'SIM', 'KLD']].agg(['mean', 'std'])
    print("── Table 1: Saliency Prediction Accuracy ──\n")
    print(summary.round(3).to_string())

    # Per-persona breakdown
    print("\n\n── Per-Persona AUC Breakdown ──\n")
    persona_aucs = df[df['method'].str.startswith('COT_')].groupby('method')['AUC'].agg(['mean', 'std'])
    print(persona_aucs.sort_values('mean', ascending=False).round(3).to_string())

    # Persona separation check
    print("\n\n── Persona Separation Matrix (AUC differences) ──\n")
    persona_means = df[df['method'].str.startswith('COT_')].groupby('method')['AUC'].mean()
    names = sorted(persona_means.index)
    for a in names:
        diffs = [f"{abs(persona_means[a] - persona_means[b]):.3f}" for b in names]
        print(f"  {a:20s} {' '.join(diffs)}")

    # CTC correlation
    print("\n\n── CTC-to-Fixation Correlation ──\n")
    ctc_df = pd.DataFrame(ctc_data)
    if len(ctc_df) > 10:
        r_entropy, p_entropy = pearsonr(ctc_df['total_demand'], ctc_df['fix_entropy'])
        r_disp, p_disp = pearsonr(ctc_df['total_demand'], ctc_df['fix_dispersion'])
        rho_entropy, _ = spearmanr(ctc_df['total_demand'], ctc_df['fix_entropy'])
        rho_disp, _ = spearmanr(ctc_df['total_demand'], ctc_df['fix_dispersion'])
        print(f"  Demand vs Fixation Entropy:    r={r_entropy:.3f} (p={p_entropy:.4f}), rho={rho_entropy:.3f}")
        print(f"  Demand vs Fixation Dispersion: r={r_disp:.3f} (p={p_disp:.4f}), rho={rho_disp:.3f}")
    else:
        print("  Not enough data for correlation")

    # Save
    df.to_csv(str(output_dir / 'study1_results.csv'), index=False)
    ctc_df.to_csv(str(output_dir / 'study1_ctc.csv'), index=False)
    with open(str(output_dir / 'study1_summary.json'), 'w') as f:
        json.dump({
            'images': len(all_imgs),
            'personas': list(PERSONAS.keys()),
            'summary': {m: {k: float(v) for k, v in row.items()}
                        for m, row in df.groupby('method')[['AUC', 'NSS', 'CC']].mean().iterrows()},
        }, f, indent=2)
    print(f"\nSaved to {output_dir}/")


if __name__ == '__main__':
    main()
