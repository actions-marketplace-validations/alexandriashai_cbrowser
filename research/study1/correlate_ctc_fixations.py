"""
correlate_ctc_fixations.py — Correlate CTC scores with fixation patterns.

This is the novel analysis for the CHI 2027 paper:
  "Do pages with higher Cognitive Transport Cost produce more dispersed fixations?"

Hypothesis: Higher CTC -> higher fixation entropy (more scattered attention)

Pipeline:
1. Load page features (from extract_page_features.py)
2. Compute CTC for multiple personas
3. Load fixation data from UEyes
4. Compute fixation entropy/dispersion metrics per image
5. Correlate CTC with fixation dispersion
6. Generate Figure 3 of the paper

This validates that the COT framework's theoretical predictions
(cognitive load -> scattered attention) hold against real eye-tracking data.
"""

import os
import sys
import json
import math
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from scipy.stats import pearsonr, spearmanr
from scipy.ndimage import gaussian_filter


# Import local modules
from extract_page_features import (
    DEMAND_DIMENSIONS,
    compute_demand_distribution,
    extract_features_for_image,
)


# ── CTC Computation (Python port of cognitive-transport-chain.ts) ──

# Layer definitions matching CBrowser exactly
LAYER_DEFINITIONS = [
    {'name': 'saliency', 'traits': ['changeBlindness', 'attentionPattern']},
    {'name': 'cognitiveLoad', 'traits': ['comprehension', 'workingMemory', 'informationForaging']},
    {'name': 'decision', 'traits': ['satisficing', 'anchoringBias', 'riskTolerance',
                                     'fearOfMissingOut', 'socialProofSensitivity']},
    {'name': 'motor', 'traits': ['patience', 'proceduralFluency']},
    {'name': 'frustration', 'traits': ['resilience', 'selfEfficacy', 'patience',
                                        'emotionalContagion']},
    {'name': 'readability', 'traits': ['readingTendency', 'comprehension', 'transferLearning']},
]

INTERACTION_PAIRS = [
    {'a': 'cognitiveLoad', 'b': 'decision', 'weight': 0.15},
    {'a': 'saliency', 'b': 'cognitiveLoad', 'weight': 0.15},
    {'a': 'frustration', 'b': 'readability', 'weight': 0.15},
    {'a': 'cognitiveLoad', 'b': 'motor', 'weight': 0.15},
    {'a': 'frustration', 'b': 'decision', 'weight': 0.15},
]

WEIGHT_DEFICIT = 1.0
WEIGHT_SURPLUS = 0.3
DEPLETION_RATE = 0.15
CAPACITY_FLOOR = 0.05


# ── Persona Definitions ──

PERSONAS = {
    'average_user': {
        'patience': 0.5, 'riskTolerance': 0.5, 'comprehension': 0.5,
        'persistence': 0.5, 'workingMemory': 0.5, 'readingTendency': 0.5,
        'resilience': 0.5, 'selfEfficacy': 0.5, 'emotionalContagion': 0.5,
        'satisficing': 0.5, 'anchoringBias': 0.5, 'fearOfMissingOut': 0.5,
        'socialProofSensitivity': 0.5, 'changeBlindness': 0.5, 'attentionPattern': 0.5,
        'motorPrecision': 0.5, 'proceduralFluency': 0.5, 'informationForaging': 0.5,
        'metacognitivePlanning': 0.5, 'transferLearning': 0.5, 'interruptRecovery': 0.5,
        'trustCalibration': 0.5, 'mentalModelRigidity': 0.5, 'curiosity': 0.5,
        'processingSpeed': 0.5, 'textProcessing': 0.5,
    },
    'power_user': {
        'patience': 0.3, 'riskTolerance': 0.7, 'comprehension': 0.8,
        'persistence': 0.7, 'workingMemory': 0.8, 'readingTendency': 0.4,
        'resilience': 0.7, 'selfEfficacy': 0.8, 'emotionalContagion': 0.3,
        'satisficing': 0.3, 'anchoringBias': 0.3, 'fearOfMissingOut': 0.3,
        'socialProofSensitivity': 0.2, 'changeBlindness': 0.3, 'attentionPattern': 0.7,
        'motorPrecision': 0.8, 'proceduralFluency': 0.8, 'informationForaging': 0.8,
        'metacognitivePlanning': 0.7, 'transferLearning': 0.7, 'interruptRecovery': 0.7,
        'trustCalibration': 0.6, 'mentalModelRigidity': 0.4, 'curiosity': 0.7,
        'processingSpeed': 0.8, 'textProcessing': 0.7,
    },
    'elderly_user': {
        'patience': 0.8, 'riskTolerance': 0.2, 'comprehension': 0.5,
        'persistence': 0.6, 'workingMemory': 0.4, 'readingTendency': 0.8,
        'resilience': 0.6, 'selfEfficacy': 0.4, 'emotionalContagion': 0.5,
        'satisficing': 0.7, 'anchoringBias': 0.6, 'fearOfMissingOut': 0.3,
        'socialProofSensitivity': 0.4, 'changeBlindness': 0.7, 'attentionPattern': 0.3,
        'motorPrecision': 0.3, 'proceduralFluency': 0.4, 'informationForaging': 0.3,
        'metacognitivePlanning': 0.4, 'transferLearning': 0.3, 'interruptRecovery': 0.4,
        'trustCalibration': 0.4, 'mentalModelRigidity': 0.7, 'curiosity': 0.3,
        'processingSpeed': 0.4, 'textProcessing': 0.4,
    },
    'adhd_user': {
        'patience': 0.2, 'riskTolerance': 0.6, 'comprehension': 0.5,
        'persistence': 0.3, 'workingMemory': 0.3, 'readingTendency': 0.3,
        'resilience': 0.4, 'selfEfficacy': 0.4, 'emotionalContagion': 0.7,
        'satisficing': 0.7, 'anchoringBias': 0.5, 'fearOfMissingOut': 0.7,
        'socialProofSensitivity': 0.6, 'changeBlindness': 0.3, 'attentionPattern': 0.8,
        'motorPrecision': 0.5, 'proceduralFluency': 0.4, 'informationForaging': 0.6,
        'metacognitivePlanning': 0.3, 'transferLearning': 0.4, 'interruptRecovery': 0.2,
        'trustCalibration': 0.5, 'mentalModelRigidity': 0.3, 'curiosity': 0.8,
        'processingSpeed': 0.6, 'textProcessing': 0.3,
    },
    'low_vision': {
        'patience': 0.7, 'riskTolerance': 0.2, 'comprehension': 0.5,
        'persistence': 0.7, 'workingMemory': 0.5, 'readingTendency': 0.9,
        'resilience': 0.6, 'selfEfficacy': 0.3, 'emotionalContagion': 0.4,
        'satisficing': 0.6, 'anchoringBias': 0.5, 'fearOfMissingOut': 0.3,
        'socialProofSensitivity': 0.3, 'changeBlindness': 0.8, 'attentionPattern': 0.2,
        'motorPrecision': 0.3, 'proceduralFluency': 0.3, 'informationForaging': 0.3,
        'metacognitivePlanning': 0.4, 'transferLearning': 0.3, 'interruptRecovery': 0.4,
        'trustCalibration': 0.4, 'mentalModelRigidity': 0.6, 'curiosity': 0.3,
        'processingSpeed': 0.3, 'textProcessing': 0.3,
    },
}


def compute_sequential_ctc(
    persona_traits: Dict[str, float],
    demands: Dict[str, float],
) -> Dict:
    """
    Compute Sequential Cognitive Transport Cost.
    Python port of CBrowser's computeSequentialCTC().
    """
    # Initialize residual capacity from persona traits
    residual = {}
    for dim in DEMAND_DIMENSIONS:
        residual[dim] = persona_traits.get(dim, 0.5)

    layers = []
    trait_costs = {dim: 0.0 for dim in DEMAND_DIMENSIONS}
    total_deficit = 0.0
    total_surplus = 0.0
    additive_ctc = 0.0

    for layer_def in LAYER_DEFINITIONS:
        layer_cost = 0.0
        layer_deficit = 0.0
        layer_surplus = 0.0

        for trait in layer_def['traits']:
            d = demands.get(trait, 0.0)
            c = residual.get(trait, 0.5)
            gap = d - c

            if gap > 0:
                cost = WEIGHT_DEFICIT * gap * gap
                layer_deficit += cost
            else:
                cost = WEIGHT_SURPLUS * gap * gap
                layer_surplus += cost

            layer_cost += cost
            trait_costs[trait] += cost

        # Scale by demand magnitude
        layer_demand_mag = sum(
            demands.get(t, 0.0) for t in layer_def['traits']
        ) / len(layer_def['traits'])
        content_scale = min(1.0, layer_demand_mag * 3)
        layer_cost *= content_scale
        layer_deficit *= content_scale
        layer_surplus *= content_scale

        total_deficit += layer_deficit
        total_surplus += layer_surplus
        additive_ctc += layer_cost

        # Deplete capacity
        capacity_consumed = DEPLETION_RATE * layer_cost
        if content_scale > 0.1:
            for trait in layer_def['traits']:
                residual[trait] -= capacity_consumed
                residual[trait] = max(CAPACITY_FLOOR, residual[trait])
            for dim in DEMAND_DIMENSIONS:
                if dim not in layer_def['traits']:
                    residual[dim] -= (DEPLETION_RATE * 0.5) * layer_cost
                    residual[dim] = max(CAPACITY_FLOOR, residual[dim])

        layers.append({
            'name': layer_def['name'],
            'cost': layer_cost,
            'capacity_consumed': capacity_consumed,
        })

    # Interaction terms
    interactions = {}
    interaction_total = 0.0
    layer_cost_map = {l['name']: l['cost'] for l in layers}

    for pair in INTERACTION_PAIRS:
        cost_a = layer_cost_map.get(pair['a'], 0)
        cost_b = layer_cost_map.get(pair['b'], 0)
        interaction = cost_a * cost_b * pair['weight']
        key = f"{pair['a']}x{pair['b']}"
        interactions[key] = interaction
        interaction_total += interaction

    total_ctc = sum(l['cost'] for l in layers) + interaction_total

    # Bottleneck
    bottleneck = max(layers, key=lambda l: l['cost'])['name'] if layers else 'saliency'

    # Abandonment risk
    patience = persona_traits.get('patience', 0.5)
    resilience_val = persona_traits.get('resilience', 0.5)
    eff_patience = patience * 0.7 + resilience_val * 0.3
    adj_cost = max(0, total_deficit - total_surplus * 0.3)
    risk_input = adj_cost - eff_patience * 1.5
    abandonment_risk = max(0, min(1, 1 / (1 + math.exp(-risk_input / 0.6))))

    return {
        'total_ctc': total_ctc,
        'additive_ctc': additive_ctc,
        'deficit_cost': total_deficit,
        'surplus_cost': total_surplus,
        'bottleneck': bottleneck,
        'abandonment_risk': abandonment_risk,
        'layers': layers,
        'interactions': interactions,
    }


# ── Fixation Dispersion Metrics ──

def fixation_entropy(fixation_density: np.ndarray) -> float:
    """
    Compute entropy of fixation distribution.
    Higher entropy = more dispersed attention.
    """
    # Normalize to distribution
    flat = fixation_density.flatten()
    flat = np.maximum(flat, 0)
    total = np.sum(flat)
    if total < 1e-10:
        return 0.0
    p = flat / total
    p = p[p > 0]
    entropy = -np.sum(p * np.log2(p))
    max_entropy = np.log2(len(flat))
    return float(entropy / max_entropy) if max_entropy > 0 else 0.0


def fixation_spread(fixation_density: np.ndarray) -> float:
    """
    Spatial spread of fixations (standard deviation of fixation positions).
    Higher = more spread out.
    """
    h, w = fixation_density.shape
    total = np.sum(fixation_density)
    if total < 1e-10:
        return 0.0

    y_coords, x_coords = np.mgrid[0:h, 0:w]
    mean_x = np.sum(x_coords * fixation_density) / total
    mean_y = np.sum(y_coords * fixation_density) / total
    var_x = np.sum(((x_coords - mean_x) ** 2) * fixation_density) / total
    var_y = np.sum(((y_coords - mean_y) ** 2) * fixation_density) / total

    spread = np.sqrt(var_x + var_y)
    # Normalize by image diagonal
    diagonal = np.sqrt(h ** 2 + w ** 2)
    return float(spread / diagonal) if diagonal > 0 else 0.0


def fixation_concentration(fixation_density: np.ndarray, top_fraction: float = 0.2) -> float:
    """
    Fraction of total fixation density in top X% of locations.
    Higher = more concentrated (less dispersed).
    """
    flat = fixation_density.flatten()
    total = np.sum(flat)
    if total < 1e-10:
        return 0.0

    sorted_vals = np.sort(flat)[::-1]
    n_top = max(1, int(len(sorted_vals) * top_fraction))
    top_sum = np.sum(sorted_vals[:n_top])

    return float(top_sum / total)


# ── Main Pipeline ──

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description='Correlate CTC with fixation patterns'
    )
    parser.add_argument('--dataset', type=str, default='UEyes_dataset',
                        help='Path to UEyes dataset')
    parser.add_argument('--features', type=str, default='features.json',
                        help='Path to features.json from extract_page_features.py')
    parser.add_argument('--output', type=str, default='results',
                        help='Output directory')
    parser.add_argument('--max-images', type=int, default=None,
                        help='Max images to process')
    args = parser.parse_args()

    study_dir = Path(__file__).parent
    dataset_dir = Path(args.dataset)
    if not dataset_dir.is_absolute():
        dataset_dir = study_dir / dataset_dir
    output_dir = Path(args.output)
    if not output_dir.is_absolute():
        output_dir = study_dir / output_dir
    output_dir.mkdir(exist_ok=True)

    features_path = Path(args.features)
    if not features_path.is_absolute():
        features_path = study_dir / features_path

    # ── Load Features ──
    if features_path.exists():
        print(f"Loading features from {features_path}")
        with open(features_path) as f:
            features_list = json.load(f)
    else:
        print(f"Features file not found: {features_path}")
        print("Run extract_page_features.py first.")
        sys.exit(1)

    # ── Find Fixation Maps ──
    from run_study1 import find_dataset_dirs, load_fixation_map
    dirs = find_dataset_dirs(dataset_dir)

    if dirs['fixation_maps'] is None:
        print("WARNING: No fixation maps directory found.")
        print("Will generate synthetic analysis from features only.")
        has_fixations = False
    else:
        has_fixations = True

    # ── Process Each Image ──
    all_rows = []

    for i, feat in enumerate(features_list):
        if args.max_images and i >= args.max_images:
            break

        image_name = feat['image']
        basename = Path(image_name).stem

        # Extract demand distribution from features
        demands = {}
        for dim in DEMAND_DIMENSIONS:
            key = f'demand_{dim}'
            demands[dim] = feat.get(key, 0.0)

        # Compute CTC for each persona
        for persona_name, persona_traits in PERSONAS.items():
            ctc_result = compute_sequential_ctc(persona_traits, demands)

            row = {
                'image': basename,
                'persona': persona_name,
                'total_ctc': ctc_result['total_ctc'],
                'additive_ctc': ctc_result['additive_ctc'],
                'deficit_cost': ctc_result['deficit_cost'],
                'surplus_cost': ctc_result['surplus_cost'],
                'bottleneck': ctc_result['bottleneck'],
                'abandonment_risk': ctc_result['abandonment_risk'],
                'info_density': feat.get('info_density', 0),
                'vis_complexity': feat.get('vis_complexity', 0),
                'text_density': feat.get('text_density', 0),
            }

            # Add fixation metrics if available
            if has_fixations:
                fix_map = None
                for ext in ['.png', '.jpg', '.npy']:
                    fix_path = dirs['fixation_maps'] / f'{basename}{ext}'
                    if fix_path.exists():
                        fix_map = load_fixation_map(str(fix_path))
                        break
                    fix_path = dirs['fixation_maps'] / f'{basename}_fixmap{ext}'
                    if fix_path.exists():
                        fix_map = load_fixation_map(str(fix_path))
                        break

                if fix_map is not None:
                    row['fix_entropy'] = fixation_entropy(fix_map)
                    row['fix_spread'] = fixation_spread(fix_map)
                    row['fix_concentration'] = fixation_concentration(fix_map)

            all_rows.append(row)

        if (i + 1) % 20 == 0:
            print(f"  Processed {i+1}/{len(features_list)} images")

    df = pd.DataFrame(all_rows)
    print(f"\nTotal rows: {len(df)} ({df['image'].nunique()} images x {df['persona'].nunique()} personas)")

    # ── Correlation Analysis ──
    print(f"\n{'='*60}")
    print("CTC vs FIXATION CORRELATION ANALYSIS")
    print(f"{'='*60}")

    if has_fixations and 'fix_entropy' in df.columns:
        # Main result: CTC predicts fixation entropy
        for persona_name in PERSONAS:
            pdata = df[df['persona'] == persona_name].dropna(subset=['fix_entropy'])
            if len(pdata) < 10:
                continue

            r_pearson, p_pearson = pearsonr(pdata['total_ctc'], pdata['fix_entropy'])
            r_spearman, p_spearman = spearmanr(pdata['total_ctc'], pdata['fix_entropy'])

            print(f"\n  {persona_name}:")
            print(f"    CTC vs Fixation Entropy:  r={r_pearson:.3f} (p={p_pearson:.4f})")
            print(f"    Spearman rho:             rho={r_spearman:.3f} (p={p_spearman:.4f})")

            r_spread, p_spread = pearsonr(pdata['total_ctc'], pdata['fix_spread'])
            print(f"    CTC vs Fixation Spread:   r={r_spread:.3f} (p={p_spread:.4f})")

            r_conc, p_conc = pearsonr(pdata['total_ctc'], pdata['fix_concentration'])
            print(f"    CTC vs Concentration:     r={r_conc:.3f} (p={p_conc:.4f}) [expected negative]")
    else:
        # Without fixation data, analyze CTC distribution across personas
        print("\n  (No fixation ground truth - showing CTC analysis only)")
        for persona_name in PERSONAS:
            pdata = df[df['persona'] == persona_name]
            print(f"\n  {persona_name}:")
            print(f"    Mean CTC:    {pdata['total_ctc'].mean():.4f}")
            print(f"    Std CTC:     {pdata['total_ctc'].std():.4f}")
            print(f"    Mean Risk:   {pdata['abandonment_risk'].mean():.4f}")
            print(f"    Bottleneck:  {pdata['bottleneck'].mode().iloc[0] if len(pdata) > 0 else 'N/A'}")

    # ── Sequential vs Additive Comparison ──
    print(f"\n{'='*60}")
    print("SEQUENTIAL vs ADDITIVE CTC")
    print(f"{'='*60}")

    for persona_name in PERSONAS:
        pdata = df[df['persona'] == persona_name]
        mean_seq = pdata['total_ctc'].mean()
        mean_add = pdata['additive_ctc'].mean()
        amplification = mean_seq / mean_add if mean_add > 0 else 1.0
        print(f"  {persona_name:15s}: seq={mean_seq:.4f} add={mean_add:.4f} "
              f"amplification={amplification:.2f}x")

    # ── Save Results ──
    csv_path = output_dir / 'ctc_fixation_correlation.csv'
    df.to_csv(csv_path, index=False)
    print(f"\nResults saved to {csv_path}")

    json_path = output_dir / 'ctc_fixation_correlation.json'
    df.to_json(json_path, orient='records', indent=2)
    print(f"JSON saved to {json_path}")

    # ── Generate Plots ──
    try:
        generate_correlation_plots(df, output_dir, has_fixations)
    except Exception as e:
        print(f"Warning: Plot generation failed: {e}")

    print("\nCorrelation analysis complete.")


def generate_correlation_plots(df: pd.DataFrame, output_dir: Path, has_fixations: bool):
    """Generate publication-quality correlation plots."""
    import matplotlib.pyplot as plt
    import matplotlib
    matplotlib.use('Agg')

    persona_colors = {
        'average_user': '#607D8B',
        'power_user': '#2196F3',
        'elderly_user': '#FF9800',
        'adhd_user': '#F44336',
        'low_vision': '#9C27B0',
    }

    if has_fixations and 'fix_entropy' in df.columns:
        # Figure 3: CTC vs fixation entropy by persona
        fig, ax = plt.subplots(figsize=(8, 6))

        for persona_name in PERSONAS:
            pdata = df[df['persona'] == persona_name].dropna(subset=['fix_entropy'])
            if len(pdata) < 5:
                continue
            ax.scatter(
                pdata['total_ctc'], pdata['fix_entropy'],
                label=persona_name, alpha=0.5, s=30,
                color=persona_colors.get(persona_name, '#333'),
            )
            # Trend line
            if len(pdata) > 10:
                z = np.polyfit(pdata['total_ctc'], pdata['fix_entropy'], 1)
                p = np.poly1d(z)
                x_line = np.linspace(pdata['total_ctc'].min(), pdata['total_ctc'].max(), 50)
                ax.plot(x_line, p(x_line), '--', alpha=0.5,
                        color=persona_colors.get(persona_name, '#333'))

        ax.set_xlabel('Total CTC (Cognitive Transport Cost)')
        ax.set_ylabel('Fixation Entropy (normalized)')
        ax.set_title('CTC Predicts Fixation Dispersion (Study 1)')
        ax.legend(loc='best', fontsize=9)
        ax.grid(alpha=0.3)

        fig.savefig(output_dir / 'ctc_vs_fixation_entropy.png', dpi=300, bbox_inches='tight')
        fig.savefig(output_dir / 'ctc_vs_fixation_entropy.pdf', bbox_inches='tight')
        plt.close()

    # CTC distribution by persona (always available)
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))

    # Box plot of CTC by persona
    persona_names = list(PERSONAS.keys())
    ctc_data = [df[df['persona'] == p]['total_ctc'].values for p in persona_names]
    bp = axes[0].boxplot(ctc_data, tick_labels=persona_names, patch_artist=True)
    for patch, persona in zip(bp['boxes'], persona_names):
        patch.set_facecolor(persona_colors.get(persona, '#ccc'))
        patch.set_alpha(0.7)
    axes[0].set_ylabel('Total CTC')
    axes[0].set_title('CTC Distribution by Persona')
    axes[0].tick_params(axis='x', rotation=30)
    axes[0].grid(axis='y', alpha=0.3)

    # Sequential amplification
    for persona in persona_names:
        pdata = df[df['persona'] == persona]
        seq = pdata['total_ctc'].values
        add = pdata['additive_ctc'].values
        amp = np.where(add > 0, seq / add, 1.0)
        axes[1].hist(amp, bins=20, alpha=0.5,
                     label=persona, color=persona_colors.get(persona, '#ccc'))
    axes[1].set_xlabel('Sequential Amplification (seq/add)')
    axes[1].set_ylabel('Count')
    axes[1].set_title('Sequential Transport Amplification')
    axes[1].legend(fontsize=8)
    axes[1].grid(alpha=0.3)

    plt.tight_layout()
    fig.savefig(output_dir / 'ctc_persona_analysis.png', dpi=300, bbox_inches='tight')
    fig.savefig(output_dir / 'ctc_persona_analysis.pdf', bbox_inches='tight')
    plt.close()

    print(f"  Plots saved to {output_dir}")


if __name__ == '__main__':
    main()
