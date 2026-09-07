"""
extract_page_features.py — Extract visual features from UEyes webpage screenshots.

Mirrors CBrowser's extractPageMetrics() and computeDemandDistribution() in Python.
Produces a 26-dimensional demand vector for each stimulus image so we can compute
CTC against the human fixation ground truth.

UEyes dataset structure (after unzip):
  UEyes_dataset/
    images/                   # 350 webpage screenshots (PNG, 1920x1080)
    fixation_maps/            # Per-image aggregated fixation density maps
    fixation_sequences/       # Per-participant fixation sequences (CSV)
    aoi_annotations/          # Area-of-interest annotations

Output: features.csv — one row per image with 26 demand dimensions + metadata.
"""

import os
import sys
import csv
import json
import math
import numpy as np
from PIL import Image
from pathlib import Path
from typing import Dict, Tuple


# ── CIE-Lab Conversion (matches CBrowser's srgbToLab) ──

def srgb_to_linear(c: float) -> float:
    """Convert sRGB channel (0-255) to linear RGB (0-1)."""
    c = c / 255.0
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def rgb_to_lab(r: int, g: int, b: int) -> Tuple[float, float, float]:
    """Convert sRGB to CIE-Lab (D65 illuminant)."""
    rl, gl, bl = srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b)

    # Linear RGB to XYZ (D65)
    x = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl
    y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl
    z = 0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl

    # XYZ to Lab
    xn, yn, zn = 0.95047, 1.0, 1.08883

    def f(t):
        if t > 0.008856:
            return t ** (1.0 / 3.0)
        return 7.787 * t + 16.0 / 116.0

    fx, fy, fz = f(x / xn), f(y / yn), f(z / zn)
    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b_lab = 200.0 * (fy - fz)
    return (L, a, b_lab)


# ── Feature Extraction ──

def compute_visual_complexity(img_array: np.ndarray) -> float:
    """
    Visual complexity via edge density + color variance.
    Approximates CBrowser's visualComplexity metric.
    """
    from skimage import color, filters

    # Convert to grayscale
    if img_array.ndim == 3:
        gray = color.rgb2gray(img_array[:, :, :3])
    else:
        gray = img_array

    # Edge density (Sobel)
    edges = filters.sobel(gray)
    edge_density = np.mean(edges > 0.05)

    # Color variance (in Lab space)
    if img_array.ndim == 3 and img_array.shape[2] >= 3:
        lab = color.rgb2lab(img_array[:, :, :3])
        color_var = np.std(lab[:, :, 1]) + np.std(lab[:, :, 2])
        color_var = min(1.0, color_var / 60.0)  # Normalize
    else:
        color_var = 0.0

    # Combine: 60% edges + 40% color variance
    complexity = 0.6 * edge_density + 0.4 * color_var
    return min(1.0, complexity)


def compute_information_density(img_array: np.ndarray) -> float:
    """
    Information density via spatial frequency analysis.
    High-frequency content = dense information.
    """
    from skimage import color

    if img_array.ndim == 3:
        gray = color.rgb2gray(img_array[:, :, :3])
    else:
        gray = img_array

    # FFT-based spectral energy
    f_transform = np.fft.fft2(gray)
    f_shift = np.fft.fftshift(f_transform)
    magnitude = np.abs(f_shift)

    # High-frequency energy ratio
    rows, cols = gray.shape
    crow, ccol = rows // 2, cols // 2
    # Low-freq region (center 10%)
    r = min(rows, cols) // 10
    total_energy = np.sum(magnitude ** 2)
    low_freq = magnitude[crow-r:crow+r, ccol-r:ccol+r]
    low_energy = np.sum(low_freq ** 2)

    if total_energy == 0:
        return 0.0

    high_freq_ratio = 1.0 - (low_energy / total_energy)
    return min(1.0, high_freq_ratio)


def compute_text_density(img_array: np.ndarray) -> float:
    """
    Text density estimation via horizontal edge patterns.
    Text regions have strong horizontal structure.
    """
    from skimage import color, filters

    if img_array.ndim == 3:
        gray = color.rgb2gray(img_array[:, :, :3])
    else:
        gray = img_array

    # Horizontal Sobel (text lines create horizontal edges)
    h_edges = filters.sobel_h(gray)
    v_edges = filters.sobel_v(gray)

    h_energy = np.mean(np.abs(h_edges))
    v_energy = np.mean(np.abs(v_edges))

    # Text has higher horizontal/vertical ratio
    if v_energy == 0:
        return 0.5
    ratio = h_energy / (h_energy + v_energy)

    # Also check for small-scale texture (text is fine-grained)
    local_var = filters.gaussian(gray, sigma=1) - filters.gaussian(gray, sigma=5)
    fine_texture = np.mean(np.abs(local_var))

    text_score = 0.5 * ratio + 0.5 * min(1.0, fine_texture * 10)
    return min(1.0, text_score)


def estimate_interactive_elements(img_array: np.ndarray) -> int:
    """
    Estimate number of interactive elements from visual cues.
    Looks for button-like rectangles, form fields, links (colored text).
    """
    from skimage import color, measure, morphology

    if img_array.ndim == 3:
        gray = color.rgb2gray(img_array[:, :, :3])
    else:
        gray = img_array

    # Detect rectangular regions with distinct boundaries
    from skimage.filters import threshold_otsu
    try:
        thresh = threshold_otsu(gray)
    except ValueError:
        return 5  # Default for uniform images

    binary = gray < thresh
    # Clean up
    binary = morphology.remove_small_objects(binary, max_size=100)
    binary = morphology.remove_small_holes(binary, max_size=50)

    # Label connected components
    labeled = measure.label(binary)
    regions = measure.regionprops(labeled)

    # Filter for interactive-element-sized regions
    interactive_count = 0
    for region in regions:
        # Interactive elements are typically 30-400px wide, 15-80px tall
        minr, minc, maxr, maxc = region.bbox
        w = maxc - minc
        h = maxr - minr
        aspect = w / max(h, 1)

        if 30 < w < 500 and 15 < h < 100 and 1.5 < aspect < 15:
            interactive_count += 1

    return max(3, min(interactive_count, 100))


def estimate_choice_count(img_array: np.ndarray) -> int:
    """
    Estimate number of choice/decision points.
    Approximated from interactive element clusters.
    """
    n_interactive = estimate_interactive_elements(img_array)
    # Rough heuristic: ~60% of interactive elements are distinct choices
    return max(2, int(n_interactive * 0.6))


def compute_animation_level(img_path: str) -> float:
    """
    Animation level from static screenshot = 0.0 (no animation detectable).
    For UEyes dataset, all stimuli are static screenshots.
    """
    return 0.0


def estimate_navigation_depth(img_array: np.ndarray) -> int:
    """
    Estimate navigation depth from visual hierarchy.
    Looks for navigation bars, breadcrumbs, sidebar menus.
    """
    # Check top region for navigation bar
    h, w = img_array.shape[:2]
    top_region = img_array[:int(h * 0.08), :, :]
    top_var = np.std(top_region)

    # Distinct top bar suggests navigation structure
    if top_var > 30:
        return 2
    return 1


# ── Demand Distribution (mirrors CBrowser's computeDemandDistribution) ──

DEMAND_DIMENSIONS = [
    'patience', 'riskTolerance', 'comprehension',
    'persistence', 'workingMemory', 'readingTendency',
    'resilience', 'selfEfficacy', 'emotionalContagion',
    'satisficing', 'anchoringBias', 'fearOfMissingOut', 'socialProofSensitivity',
    'changeBlindness', 'attentionPattern',
    'motorPrecision', 'proceduralFluency',
    'informationForaging', 'metacognitivePlanning', 'transferLearning',
    'interruptRecovery',
    'trustCalibration',
    'mentalModelRigidity', 'curiosity',
    'processingSpeed', 'textProcessing',
]


def sigmoid(raw: float, threshold: float, scale: float) -> float:
    """Logistic sigmoid for metric-to-demand mapping."""
    x = -(raw - threshold) / scale
    if x > 500:
        return 0.0
    if x < -500:
        return 1.0
    return 1.0 / (1.0 + math.exp(x))


def compute_demand_distribution(
    info_density: float,
    vis_complexity: float,
    interactive_count: int,
    text_density: float,
    animation_level: float,
    choice_count: int,
    nav_depth: int,
) -> Dict[str, float]:
    """
    Compute 26-dimensional demand distribution from page metrics.
    Exact port of CBrowser's computeDemandDistribution() from
    cognitive-transport-chain.ts.
    """
    demands = {dim: 0.0 for dim in DEMAND_DIMENSIONS}

    # informationDensity -> comprehension, workingMemory, readingTendency, informationForaging
    demands['comprehension'] = max(demands['comprehension'], info_density)
    demands['workingMemory'] = max(demands['workingMemory'], info_density * 0.9)
    demands['readingTendency'] = max(demands['readingTendency'], info_density * 0.85)
    demands['informationForaging'] = max(demands['informationForaging'], info_density * 0.8)

    # visualComplexity -> changeBlindness, mentalModelRigidity, attentionPattern
    demands['changeBlindness'] = max(demands['changeBlindness'], vis_complexity)
    demands['mentalModelRigidity'] = max(demands['mentalModelRigidity'], vis_complexity * 0.7)
    demands['attentionPattern'] = max(demands['attentionPattern'], vis_complexity * 0.85)

    # interactiveElementCount -> riskTolerance, satisficing, proceduralFluency, motorPrecision
    inter_demand = interactive_count / (interactive_count + 20)
    demands['riskTolerance'] = max(demands['riskTolerance'], inter_demand * 0.75)
    demands['satisficing'] = max(demands['satisficing'], inter_demand * 0.8)
    demands['proceduralFluency'] = max(demands['proceduralFluency'], inter_demand * 0.9)
    demands['motorPrecision'] = max(demands['motorPrecision'], inter_demand)

    # textDensity -> readingTendency, patience, comprehension
    demands['readingTendency'] = max(demands['readingTendency'], text_density)
    demands['patience'] = max(demands['patience'], text_density * 0.7)
    demands['comprehension'] = max(demands['comprehension'], text_density * 0.85)

    # animationLevel -> changeBlindness, interruptRecovery, emotionalContagion
    anim_demand = sigmoid(animation_level, 0.3, 0.15)
    demands['changeBlindness'] = max(demands['changeBlindness'], anim_demand * 0.9)
    demands['interruptRecovery'] = max(demands['interruptRecovery'], anim_demand * 0.85)
    demands['emotionalContagion'] = max(demands['emotionalContagion'], anim_demand * 0.7)

    # choiceCount -> satisficing, anchoringBias, fearOfMissingOut, socialProofSensitivity
    choice_demand = choice_count / (choice_count + 10)
    demands['satisficing'] = max(demands['satisficing'], choice_demand)
    demands['anchoringBias'] = max(demands['anchoringBias'], choice_demand * 0.85)
    demands['fearOfMissingOut'] = max(demands['fearOfMissingOut'], choice_demand * 0.75)
    demands['socialProofSensitivity'] = max(demands['socialProofSensitivity'], choice_demand * 0.7)

    # navigationDepth -> workingMemory, metacognitivePlanning, persistence, transferLearning
    nav_demand = nav_depth / (nav_depth + 3)
    demands['workingMemory'] = max(demands['workingMemory'], nav_demand * 0.95)
    demands['metacognitivePlanning'] = max(demands['metacognitivePlanning'], nav_demand * 0.8)
    demands['persistence'] = max(demands['persistence'], nav_demand * 0.7)
    demands['transferLearning'] = max(demands['transferLearning'], nav_demand * 0.65)

    # Clamp to [0, 1]
    for dim in DEMAND_DIMENSIONS:
        demands[dim] = max(0.0, min(1.0, demands[dim]))

    return demands


# ── Main Pipeline ──

def extract_features_for_image(img_path: str) -> Dict:
    """Extract all features for a single image."""
    img = Image.open(img_path).convert('RGB')
    img_array = np.array(img)

    # Extract raw page metrics
    info_density = compute_information_density(img_array)
    vis_complexity = compute_visual_complexity(img_array)
    interactive_count = estimate_interactive_elements(img_array)
    text_density = compute_text_density(img_array)
    animation_level = compute_animation_level(img_path)
    choice_count = estimate_choice_count(img_array)
    nav_depth = estimate_navigation_depth(img_array)

    # Compute 26D demand distribution
    demands = compute_demand_distribution(
        info_density, vis_complexity, interactive_count,
        text_density, animation_level, choice_count, nav_depth,
    )

    return {
        'image': os.path.basename(img_path),
        'info_density': round(info_density, 4),
        'vis_complexity': round(vis_complexity, 4),
        'interactive_count': interactive_count,
        'text_density': round(text_density, 4),
        'animation_level': round(animation_level, 4),
        'choice_count': choice_count,
        'nav_depth': nav_depth,
        **{f'demand_{k}': round(v, 4) for k, v in demands.items()},
    }


def main():
    """Extract features from all UEyes images."""
    # Find images directory
    dataset_dir = Path(__file__).parent / 'UEyes_dataset'
    images_dir = None

    # Try common UEyes directory structures
    for candidate in [
        dataset_dir / 'images',
        dataset_dir / 'stimuli',
        dataset_dir / 'Screenshots',
        dataset_dir / 'webpage_screenshots',
        dataset_dir,
    ]:
        if candidate.exists() and any(candidate.glob('*.png')) or any(candidate.glob('*.jpg')):
            images_dir = candidate
            break

    if images_dir is None:
        # List what's actually in the dataset dir for debugging
        if dataset_dir.exists():
            print(f"Dataset dir contents: {list(dataset_dir.iterdir())[:20]}")
            # Try recursively
            for p in sorted(dataset_dir.rglob('*.png'))[:5]:
                print(f"  Found image: {p}")
                images_dir = p.parent
                break

    if images_dir is None:
        print("ERROR: Cannot find UEyes images directory.")
        print(f"Looked in: {dataset_dir}")
        print("Please unzip UEyes_dataset.zip and check the directory structure.")
        sys.exit(1)

    # Collect image paths
    image_paths = sorted(
        list(images_dir.glob('*.png')) + list(images_dir.glob('*.jpg'))
    )
    print(f"Found {len(image_paths)} images in {images_dir}")

    if not image_paths:
        print("ERROR: No PNG or JPG images found.")
        sys.exit(1)

    # Process all images
    results = []
    for i, img_path in enumerate(image_paths):
        try:
            features = extract_features_for_image(str(img_path))
            results.append(features)
            if (i + 1) % 10 == 0:
                print(f"  Processed {i + 1}/{len(image_paths)}: {img_path.name}")
        except Exception as e:
            print(f"  WARN: Failed on {img_path.name}: {e}")
            continue

    # Write CSV
    output_path = Path(__file__).parent / 'features.csv'
    if results:
        fieldnames = list(results[0].keys())
        with open(output_path, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(results)
        print(f"\nWrote {len(results)} rows to {output_path}")
    else:
        print("ERROR: No results to write.")
        sys.exit(1)

    # Also write JSON for downstream scripts
    json_path = Path(__file__).parent / 'features.json'
    with open(json_path, 'w') as f:
        json.dump(results, f, indent=2)
    print(f"Wrote JSON to {json_path}")


if __name__ == '__main__':
    main()
