"""
cot_saliency.py — Generate COT (Cognitive Optimal Transport) saliency predictions.

Implements CBrowser's W2-based center-surround saliency in Python:
1. Divides image into grid cells
2. Computes per-cell CIE-Lab mean + variance (Gaussian model)
3. Computes Bures-Wasserstein distance between each cell and its surround
4. Normalizes to produce saliency map

This is the "predicted" saliency that we compare against UEyes fixation maps.

Output: predicted_saliency/ directory with one .npy per image.
"""

import os
import sys
import numpy as np
from PIL import Image
from pathlib import Path
from typing import Tuple


# ── CIE-Lab Conversion ──

def srgb_to_lab_pixel(r: int, g: int, b: int) -> Tuple[float, float, float]:
    """Convert single sRGB pixel to CIE-Lab."""
    def to_linear(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    rl, gl, bl = to_linear(r), to_linear(g), to_linear(b)

    x = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl
    y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl
    z = 0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl

    xn, yn, zn = 0.95047, 1.0, 1.08883
    def f(t):
        return t ** (1.0 / 3.0) if t > 0.008856 else 7.787 * t + 16.0 / 116.0

    fx, fy, fz = f(x / xn), f(y / yn), f(z / zn)
    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b_lab = 200.0 * (fy - fz)
    return (L, a, b_lab)


def rgb_array_to_lab(img_array: np.ndarray) -> np.ndarray:
    """Convert RGB image array to CIE-Lab using skimage for efficiency."""
    from skimage import color
    # skimage expects float64 in [0,1] or uint8
    if img_array.dtype == np.uint8:
        return color.rgb2lab(img_array[:, :, :3])
    else:
        return color.rgb2lab((img_array[:, :, :3] / 255.0).astype(np.float64))


# ── Core Saliency Computation ──

def compute_w2_saliency(
    img_array: np.ndarray,
    cell_size: int = 16,
    surround_radius: int = 3,
    downscale: float = 0.5,
) -> np.ndarray:
    """
    Compute center-surround saliency via Bures-Wasserstein (W2) distance
    on CIE-Lab Gaussian distributions per grid cell.

    Vectorized Python port of CBrowser's computeLabSaliency().
    Uses scipy.ndimage.uniform_filter for efficient surround computation.

    Returns: 2D array (rows x cols) of saliency values in [0, 1].
    """
    from skimage.transform import resize
    from scipy.ndimage import uniform_filter

    # Downscale for performance
    h_orig, w_orig = img_array.shape[:2]
    h = int(h_orig * downscale)
    w = int(w_orig * downscale)
    img_scaled = resize(img_array[:, :, :3], (h, w), anti_aliasing=True)

    # Convert to Lab
    lab = rgb_array_to_lab((img_scaled * 255).astype(np.uint8))

    rows = int(np.ceil(h / cell_size))
    cols = int(np.ceil(w / cell_size))

    # Compute per-cell statistics using block reduction (vectorized)
    # Pad lab array so it divides evenly by cell_size
    pad_h = rows * cell_size - h
    pad_w = cols * cell_size - w
    if pad_h > 0 or pad_w > 0:
        lab_padded = np.pad(lab, ((0, pad_h), (0, pad_w), (0, 0)), mode='edge')
    else:
        lab_padded = lab

    # Reshape into blocks: (rows, cell_size, cols, cell_size, 3)
    blocks = lab_padded.reshape(rows, cell_size, cols, cell_size, 3)

    # Per-cell mean (rows, cols, 3)
    cell_means = blocks.mean(axis=(1, 3))

    # Per-cell variance (rows, cols, 3)
    cell_vars = blocks.var(axis=(1, 3))
    cell_vars = np.maximum(cell_vars, 0.01)  # Floor at 0.01

    # Compute surround means and variances using uniform_filter
    # This computes the average over a (2*surround_radius+1) neighborhood
    kernel_size = 2 * surround_radius + 1

    # For each Lab channel, compute surround mean/variance
    surround_means = np.zeros_like(cell_means)
    surround_vars = np.zeros_like(cell_vars)

    for ch in range(3):
        # uniform_filter includes the center cell; we'll correct for that
        # Sum of neighborhood = filter_value * kernel_area
        kernel_area = kernel_size * kernel_size
        neighborhood_sum = uniform_filter(
            cell_means[:, :, ch], size=kernel_size, mode='reflect'
        ) * kernel_area
        # Surround sum = neighborhood sum - center value
        surround_sum = neighborhood_sum - cell_means[:, :, ch]
        surround_count = kernel_area - 1  # Approximate (ignores boundary effects)
        surround_means[:, :, ch] = surround_sum / surround_count

        neighborhood_var_sum = uniform_filter(
            cell_vars[:, :, ch], size=kernel_size, mode='reflect'
        ) * kernel_area
        surround_var_sum = neighborhood_var_sum - cell_vars[:, :, ch]
        surround_vars[:, :, ch] = surround_var_sum / surround_count

    # Bures-Wasserstein distance (diagonal covariance, vectorized)
    # BW^2 = ||mu_center - mu_surround||^2 + sum(sqrt(var_c) - sqrt(var_s))^2
    mean_dist = np.sum((cell_means - surround_means) ** 2, axis=2)
    var_dist = np.sum(
        (np.sqrt(cell_vars) - np.sqrt(np.maximum(surround_vars, 0.01))) ** 2,
        axis=2,
    )

    saliency = np.sqrt(mean_dist + var_dist)

    # Normalize to [0, 1]
    max_sal = max(np.max(saliency), 0.001)
    saliency /= max_sal

    return saliency


def saliency_to_full_resolution(
    saliency_grid: np.ndarray,
    target_h: int,
    target_w: int,
) -> np.ndarray:
    """
    Upscale saliency grid to full image resolution via bilinear interpolation.
    Applies Gaussian smoothing to match fixation map resolution.
    """
    from scipy.ndimage import zoom, gaussian_filter

    rows, cols = saliency_grid.shape
    # Compute zoom factors
    zoom_h = target_h / rows
    zoom_w = target_w / cols

    # Upscale
    full_res = zoom(saliency_grid, (zoom_h, zoom_w), order=1)

    # Gaussian smooth (sigma ~1 degree visual angle at typical viewing distance)
    # At 1920x1080, 1 degree ~ 35px
    sigma = 35.0
    full_res = gaussian_filter(full_res, sigma=sigma)

    # Renormalize
    max_val = np.max(full_res)
    if max_val > 0:
        full_res /= max_val

    return full_res


# ── Main ──

def process_image(img_path: str, output_dir: str, cell_size: int = 16) -> dict:
    """Process single image, save saliency map, return metadata."""
    img = Image.open(img_path).convert('RGB')
    img_array = np.array(img)
    h, w = img_array.shape[:2]

    # Compute grid-level saliency
    saliency_grid = compute_w2_saliency(img_array, cell_size=cell_size)

    # Upscale to full resolution
    saliency_full = saliency_to_full_resolution(saliency_grid, h, w)

    # Save
    basename = Path(img_path).stem
    npy_path = os.path.join(output_dir, f'{basename}_saliency.npy')
    np.save(npy_path, saliency_full)

    # Also save as PNG for visualization
    from PIL import Image as PILImage
    vis = (saliency_full * 255).astype(np.uint8)
    vis_img = PILImage.fromarray(vis, mode='L')
    png_path = os.path.join(output_dir, f'{basename}_saliency.png')
    vis_img.save(png_path)

    return {
        'image': os.path.basename(img_path),
        'grid_shape': saliency_grid.shape,
        'full_shape': saliency_full.shape,
        'max_saliency': float(np.max(saliency_full)),
        'mean_saliency': float(np.mean(saliency_full)),
        'entropy': float(-np.sum(
            saliency_full[saliency_full > 0] *
            np.log2(saliency_full[saliency_full > 0] + 1e-10)
        ) / max(1, saliency_full.size)),
    }


def main():
    """Generate COT saliency predictions for all UEyes images."""
    dataset_dir = Path(__file__).parent / 'UEyes_dataset'
    output_dir = Path(__file__).parent / 'predicted_saliency'
    output_dir.mkdir(exist_ok=True)

    # Find images
    images_dir = None
    for candidate in [
        dataset_dir / 'images',
        dataset_dir / 'stimuli',
        dataset_dir / 'Screenshots',
        dataset_dir,
    ]:
        if candidate.exists():
            pngs = list(candidate.glob('*.png'))
            jpgs = list(candidate.glob('*.jpg'))
            if pngs or jpgs:
                images_dir = candidate
                break

    if images_dir is None:
        # Recursive search
        if dataset_dir.exists():
            for p in sorted(dataset_dir.rglob('*.png'))[:1]:
                images_dir = p.parent
                break

    if images_dir is None:
        print("ERROR: Cannot find UEyes images. Unzip dataset first.")
        sys.exit(1)

    image_paths = sorted(
        list(images_dir.glob('*.png')) + list(images_dir.glob('*.jpg'))
    )
    print(f"Found {len(image_paths)} images in {images_dir}")
    print(f"Output: {output_dir}")

    results = []
    for i, img_path in enumerate(image_paths):
        try:
            result = process_image(str(img_path), str(output_dir))
            results.append(result)
            if (i + 1) % 10 == 0:
                print(f"  [{i+1}/{len(image_paths)}] {img_path.name} "
                      f"mean_sal={result['mean_saliency']:.3f}")
        except Exception as e:
            print(f"  WARN: Failed on {img_path.name}: {e}")
            continue

    # Save metadata
    import json
    meta_path = output_dir / 'saliency_metadata.json'
    with open(meta_path, 'w') as f:
        json.dump(results, f, indent=2)

    print(f"\nProcessed {len(results)} images")
    print(f"Metadata saved to {meta_path}")


if __name__ == '__main__':
    main()
