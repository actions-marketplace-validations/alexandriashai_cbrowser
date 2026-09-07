"""
run_study1.py — Main benchmark runner for Study 1 (Offline Saliency Benchmark).

End-to-end pipeline:
1. Load UEyes dataset (images + fixation maps)
2. Generate COT saliency predictions via cot_saliency.py
3. Generate baseline predictions (center bias, random, uniform)
4. Evaluate all methods against ground truth via saliency_metrics.py
5. Compute aggregate statistics and generate comparison table
6. Output results to CSV and summary report

This produces Table 1 of the CHI 2027 paper:
  "Saliency prediction accuracy: COT vs. baselines on UEyes (N=350)"
"""

import os
import sys
import csv
import json
import time
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Dict, List, Optional

# Local imports
from cot_saliency import compute_w2_saliency, saliency_to_full_resolution
from saliency_metrics import evaluate_saliency, center_bias_baseline, normalize_map
from extract_page_features import extract_features_for_image


# ── Dataset Loading ──

def find_dataset_dirs(base_dir) -> Dict[str, Optional[Path]]:
    """
    Locate UEyes dataset subdirectories.

    UEyes structure:
      UEyes_dataset/
        images/                          # Webpage screenshots
        saliency_maps/
          fixmaps_{1s,3s,7s}/            # Binary fixation maps
          heatmaps_{1s,3s,7s}/           # Continuous density heatmaps
          overlay_heatmaps_{1s,3s,7s}/   # Overlay visualizations
        scanpaths/
          paths_{1s,3s,7s}/<hash>/       # Per-image scanpath PNGs
        eyetracker_logs/                 # Raw fixation CSVs
        image_types.csv                  # Image category metadata
    """
    result = {
        'images': None,
        'fixation_maps': None,      # Binary fixation maps (fixmaps_3s)
        'fixation_density': None,   # Continuous heatmaps (heatmaps_3s)
        'fixation_sequences': None, # Raw fixation CSVs (eyetracker_logs)
    }

    base_dir = Path(base_dir)
    if not base_dir.exists():
        return result

    # Search for image directory
    for name in ['images', 'stimuli', 'Screenshots', 'webpage_screenshots']:
        candidate = base_dir / name
        if candidate.exists() and (list(candidate.glob('*.png')) or list(candidate.glob('*.jpg'))):
            result['images'] = candidate
            break

    # UEyes-specific: saliency_maps has subdirectories for different time windows
    # Use 3s as default (good balance between viewing time and coverage)
    saliency_dir = base_dir / 'saliency_maps'
    if saliency_dir.exists():
        # Prefer fixmaps_3s for binary fixation maps
        for time_window in ['3s', '7s', '1s']:
            fixmap_dir = saliency_dir / f'fixmaps_{time_window}'
            if fixmap_dir.exists() and (list(fixmap_dir.glob('*.png')) or list(fixmap_dir.glob('*.jpg'))):
                result['fixation_maps'] = fixmap_dir
                break

        # Prefer heatmaps_3s for continuous density
        for time_window in ['3s', '7s', '1s']:
            heatmap_dir = saliency_dir / f'heatmaps_{time_window}'
            if heatmap_dir.exists() and (list(heatmap_dir.glob('*.png')) or list(heatmap_dir.glob('*.jpg'))):
                result['fixation_density'] = heatmap_dir
                break
    else:
        # Fallback: search for generic fixation map directories
        for name in ['fixation_maps', 'fixation_density', 'heatmaps',
                     'fixation_heatmaps', 'ground_truth']:
            candidate = base_dir / name
            if candidate.exists():
                result['fixation_maps'] = candidate
                break

    # Search for raw fixation data (CSVs)
    for name in ['eyetracker_logs', 'scanpaths', 'fixation_sequences',
                 'fixations', 'eye_tracking_data', 'raw_fixations']:
        candidate = base_dir / name
        if candidate.exists():
            result['fixation_sequences'] = candidate
            break

    # If not found at top level, search one level deep
    if result['images'] is None:
        for subdir in sorted(base_dir.iterdir()):
            if subdir.is_dir():
                pngs = list(subdir.glob('*.png'))
                jpgs = list(subdir.glob('*.jpg'))
                if len(pngs) + len(jpgs) > 10:
                    result['images'] = subdir
                    break

    return result


def load_fixation_map(path: str) -> np.ndarray:
    """Load a fixation density map from file."""
    if path.endswith('.npy'):
        return np.load(path)
    else:
        from PIL import Image
        img = Image.open(path).convert('L')
        return np.array(img).astype(np.float64) / 255.0


def load_fixation_sequence(csv_path: str, img_width: int = 1920, img_height: int = 1080) -> List[Dict]:
    """
    Load fixation sequence from CSV.

    Handles UEyes format (FPOGX/FPOGY normalized 0-1, FPOGD duration, FPOGV validity)
    and generic formats.
    """
    fixations = []
    with open(csv_path, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            # UEyes format: FPOGX/FPOGY are normalized (0-1), FPOGV is validity flag
            if 'FPOGX' in row:
                valid = int(float(row.get('FPOGV', '1')))
                if valid != 1:
                    continue
                x = float(row['FPOGX']) * img_width
                y = float(row['FPOGY']) * img_height
                dur = float(row.get('FPOGD', '0.1')) * 1000  # Convert to ms
                fixations.append({'x': x, 'y': y, 'duration': dur})
            else:
                # Generic format
                x = float(row.get('x', row.get('fixation_x', row.get('CURRENT_FIX_X', 0))))
                y = float(row.get('y', row.get('fixation_y', row.get('CURRENT_FIX_Y', 0))))
                dur = float(row.get('duration', row.get('fixation_duration',
                                    row.get('CURRENT_FIX_DURATION', 100))))
                fixations.append({'x': x, 'y': y, 'duration': dur})
    return fixations


def fixation_sequence_to_map(
    fixations: List[Dict],
    height: int,
    width: int,
    sigma: float = 35.0,
) -> np.ndarray:
    """Convert fixation sequence to continuous density map."""
    from scipy.ndimage import gaussian_filter

    density = np.zeros((height, width))
    for fix in fixations:
        x, y = int(round(fix['x'])), int(round(fix['y']))
        if 0 <= x < width and 0 <= y < height:
            # Weight by duration
            density[y, x] += fix.get('duration', 100) / 100.0

    # Smooth with Gaussian (1 degree visual angle)
    density = gaussian_filter(density, sigma=sigma)

    # Normalize
    max_val = np.max(density)
    if max_val > 0:
        density /= max_val

    return density


# ── Baseline Models ──

def random_saliency(h: int, w: int) -> np.ndarray:
    """Random baseline: uniform random saliency."""
    return np.random.rand(h, w)


def uniform_saliency(h: int, w: int) -> np.ndarray:
    """Uniform baseline: equal saliency everywhere."""
    return np.ones((h, w)) / (h * w)


# ── Main Benchmark ──

def run_benchmark(
    dataset_dir: Path,
    output_dir: Path,
    max_images: Optional[int] = None,
    cell_size: int = 16,
) -> pd.DataFrame:
    """
    Run the full Study 1 benchmark.

    Processes each UEyes image:
    1. Generate COT saliency prediction
    2. Generate baselines (center bias, random)
    3. Load ground-truth fixation map
    4. Compute all evaluation metrics
    5. Aggregate results
    """
    output_dir.mkdir(exist_ok=True)

    # Find dataset directories
    dirs = find_dataset_dirs(dataset_dir)
    print(f"Dataset structure:")
    for k, v in dirs.items():
        print(f"  {k}: {v}")

    if dirs['images'] is None:
        print("ERROR: Cannot find images directory in UEyes dataset.")
        print(f"Dataset dir: {dataset_dir}")
        if dataset_dir.exists():
            print(f"Contents: {[str(p) for p in sorted(dataset_dir.iterdir())[:20]]}")
        sys.exit(1)

    # Filter to web images only using image_types.csv
    image_types_csv = dataset_dir / 'image_types.csv'
    web_image_names = set()
    if image_types_csv.exists():
        import csv as csv_mod
        with open(str(image_types_csv)) as f:
            reader = csv_mod.DictReader(f, delimiter=';')
            for row in reader:
                if row.get('Category', '').lower() == 'web':
                    web_image_names.add(row['Image Name'])
        print(f"  Filtered to {len(web_image_names)} web images from image_types.csv")

    # Collect image paths
    all_image_paths = sorted(
        list(dirs['images'].glob('*.png')) +
        list(dirs['images'].glob('*.jpg'))
    )
    if web_image_names:
        image_paths = [p for p in all_image_paths if p.name in web_image_names]
    else:
        image_paths = all_image_paths
    if max_images:
        image_paths = image_paths[:max_images]

    print(f"\nProcessing {len(image_paths)} images...")

    all_results = []
    methods = ['COT_W2', 'CenterBias', 'Random']

    for i, img_path in enumerate(image_paths):
        t0 = time.time()
        basename = img_path.stem

        try:
            # Load image
            from PIL import Image
            img = Image.open(str(img_path)).convert('RGB')
            img_array = np.array(img)
            h, w = img_array.shape[:2]

            # ── Ground Truth ──
            gt_map = None
            gt_binary = None

            # Try continuous density heatmap first (preferred for CC, SIM, KL)
            if dirs.get('fixation_density'):
                for ext in ['.png', '.jpg', '.npy']:
                    gt_path = dirs['fixation_density'] / f'{basename}{ext}'
                    if gt_path.exists():
                        gt_map = load_fixation_map(str(gt_path))
                        break

            # Try binary fixation map (used for AUC-Judd, NSS)
            if dirs.get('fixation_maps'):
                for ext in ['.png', '.jpg', '.npy']:
                    fix_path = dirs['fixation_maps'] / f'{basename}{ext}'
                    if fix_path.exists():
                        gt_binary = load_fixation_map(str(fix_path))
                        # If no continuous map, use binary as fallback
                        if gt_map is None:
                            gt_map = gt_binary
                        break

            # Fallback: try fixation sequences (eyetracker_logs)
            if gt_map is None and dirs.get('fixation_sequences'):
                seq_path = dirs['fixation_sequences'] / f'{basename}.csv'
                if seq_path.exists():
                    fixations = load_fixation_sequence(str(seq_path))
                    gt_map = fixation_sequence_to_map(fixations, h, w)

            if gt_map is None:
                # Skip images without ground truth
                if (i + 1) % 20 == 0:
                    print(f"  [{i+1}/{len(image_paths)}] SKIP {basename} (no ground truth)")
                continue

            # Resize ground truth to match image if needed
            if gt_map.shape[:2] != (h, w):
                from skimage.transform import resize
                gt_map = resize(gt_map, (h, w), anti_aliasing=True)

            # ── Predictions ──
            predictions = {}

            # 1. COT W2 saliency
            saliency_grid = compute_w2_saliency(img_array, cell_size=cell_size)
            cot_prediction = saliency_to_full_resolution(saliency_grid, h, w)
            predictions['COT_W2'] = cot_prediction

            # 2. Center bias baseline
            predictions['CenterBias'] = center_bias_baseline(h, w)

            # 3. Random baseline
            predictions['Random'] = random_saliency(h, w)

            # ── Evaluate ──
            for method_name, pred in predictions.items():
                metrics = evaluate_saliency(pred, gt_map, gt_binary)
                result = {
                    'image': basename,
                    'method': method_name,
                    'width': w,
                    'height': h,
                    **metrics,
                }
                all_results.append(result)

            elapsed = time.time() - t0
            if (i + 1) % 10 == 0:
                cot_metrics = [r for r in all_results if r['method'] == 'COT_W2']
                if cot_metrics:
                    avg_cc = np.mean([r['CC'] for r in cot_metrics])
                    avg_auc = np.mean([r['AUC_Judd'] for r in cot_metrics])
                    print(f"  [{i+1}/{len(image_paths)}] {basename} "
                          f"({elapsed:.1f}s) COT avg CC={avg_cc:.3f} AUC={avg_auc:.3f}")

        except Exception as e:
            print(f"  WARN: Failed on {basename}: {e}")
            import traceback
            traceback.print_exc()
            continue

    if not all_results:
        print("\nERROR: No results generated. Check dataset structure.")
        sys.exit(1)

    # ── Aggregate Results ──
    df = pd.DataFrame(all_results)
    print(f"\n{'='*60}")
    print(f"STUDY 1 RESULTS: Offline Saliency Benchmark")
    print(f"{'='*60}")
    print(f"Images evaluated: {df['image'].nunique()}")
    print()

    # Per-method aggregates
    summary = df.groupby('method').agg({
        'AUC_Judd': ['mean', 'std'],
        'NSS': ['mean', 'std'],
        'CC': ['mean', 'std'],
        'SIM': ['mean', 'std'],
        'KL': ['mean', 'std'],
        'EMD_W1': ['mean', 'std'],
        'IG': ['mean', 'std'],
    }).round(4)

    print("\n── Table 1: Saliency Prediction Accuracy ──")
    print(summary.to_string())

    # Clean summary table for paper
    print("\n── Paper Table (mean +/- std) ──")
    for method in methods:
        method_data = df[df['method'] == method]
        if len(method_data) == 0:
            continue
        line = f"  {method:15s}"
        for metric in ['AUC_Judd', 'NSS', 'CC', 'SIM', 'KL']:
            mean = method_data[metric].mean()
            std = method_data[metric].std()
            line += f"  {mean:.3f}({std:.3f})"
        print(line)

    # ── Save Results ──

    # Full results CSV
    csv_path = output_dir / 'study1_results.csv'
    df.to_csv(csv_path, index=False)
    print(f"\nFull results: {csv_path}")

    # Summary CSV
    summary_path = output_dir / 'study1_summary.csv'
    summary.to_csv(summary_path)
    print(f"Summary: {summary_path}")

    # JSON for downstream analysis
    json_path = output_dir / 'study1_results.json'
    df.to_json(json_path, orient='records', indent=2)
    print(f"JSON: {json_path}")

    return df


def generate_visualizations(df: pd.DataFrame, output_dir: Path):
    """Generate publication-quality plots for the paper."""
    import matplotlib.pyplot as plt
    import matplotlib
    matplotlib.use('Agg')

    output_dir.mkdir(exist_ok=True)

    methods = df['method'].unique()
    metrics = ['AUC_Judd', 'NSS', 'CC', 'SIM']

    # Bar chart: method comparison
    fig, axes = plt.subplots(1, len(metrics), figsize=(4 * len(metrics), 4))
    if len(metrics) == 1:
        axes = [axes]

    for ax, metric in zip(axes, metrics):
        means = []
        stds = []
        for method in methods:
            data = df[df['method'] == method][metric]
            means.append(data.mean())
            stds.append(data.std())

        bars = ax.bar(range(len(methods)), means, yerr=stds,
                      capsize=5, alpha=0.8, color=['#2196F3', '#FF9800', '#9E9E9E'])
        ax.set_xticks(range(len(methods)))
        ax.set_xticklabels(methods, rotation=30, ha='right', fontsize=9)
        ax.set_ylabel(metric)
        ax.set_title(metric)
        ax.grid(axis='y', alpha=0.3)

    plt.tight_layout()
    fig.savefig(output_dir / 'study1_comparison.png', dpi=300, bbox_inches='tight')
    fig.savefig(output_dir / 'study1_comparison.pdf', bbox_inches='tight')
    plt.close()

    # Per-image scatter: COT vs CenterBias CC
    cot_data = df[df['method'] == 'COT_W2'].set_index('image')
    cb_data = df[df['method'] == 'CenterBias'].set_index('image')
    common = cot_data.index.intersection(cb_data.index)

    if len(common) > 0:
        fig, ax = plt.subplots(figsize=(6, 6))
        ax.scatter(
            cb_data.loc[common, 'CC'],
            cot_data.loc[common, 'CC'],
            alpha=0.5, s=20, c='#2196F3'
        )
        lims = [-0.2, 1.0]
        ax.plot(lims, lims, 'k--', alpha=0.3, label='y=x')
        ax.set_xlabel('Center Bias CC')
        ax.set_ylabel('COT W2 CC')
        ax.set_title('Per-Image CC: COT vs. Center Bias')
        ax.legend()
        ax.grid(alpha=0.3)
        fig.savefig(output_dir / 'study1_scatter_cc.png', dpi=300, bbox_inches='tight')
        plt.close()

    print(f"Visualizations saved to {output_dir}")


# ── Main ──

def main():
    import argparse

    parser = argparse.ArgumentParser(description='Study 1: Offline Saliency Benchmark')
    parser.add_argument('--dataset', type=str, default='UEyes_dataset',
                        help='Path to UEyes dataset directory')
    parser.add_argument('--output', type=str, default='results',
                        help='Output directory for results')
    parser.add_argument('--max-images', type=int, default=None,
                        help='Maximum images to process (for testing)')
    parser.add_argument('--cell-size', type=int, default=16,
                        help='Grid cell size for saliency computation')
    parser.add_argument('--no-plots', action='store_true',
                        help='Skip generating visualizations')
    args = parser.parse_args()

    study_dir = Path(__file__).parent
    dataset_dir = Path(args.dataset)
    if not dataset_dir.is_absolute():
        dataset_dir = study_dir / dataset_dir
    output_dir = Path(args.output)
    if not output_dir.is_absolute():
        output_dir = study_dir / output_dir

    print(f"Study 1: Offline Saliency Benchmark")
    print(f"Dataset: {dataset_dir}")
    print(f"Output:  {output_dir}")
    print(f"Cell size: {args.cell_size}")
    if args.max_images:
        print(f"Max images: {args.max_images}")
    print()

    df = run_benchmark(
        dataset_dir=dataset_dir,
        output_dir=output_dir,
        max_images=args.max_images,
        cell_size=args.cell_size,
    )

    if not args.no_plots and len(df) > 0:
        generate_visualizations(df, output_dir)

    print("\nStudy 1 complete.")


if __name__ == '__main__':
    main()
