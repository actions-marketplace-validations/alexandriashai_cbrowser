#!/usr/bin/env python3
"""
Study 1b: Schwartz Value Modulation Effect on CTC

Measures the effect size of integrating Schwartz motivational values
into the Cognitive Transport Chain (v18.54.0).

For each of the 495 UEyes web images × 6 personas:
1. Compute CTC WITHOUT Schwartz values (baseline — identical to Study 1)
2. Compute CTC WITH Schwartz values (modulated demands)
3. Measure: delta CTC, delta abandonment risk, per-layer cost shifts

Hypotheses:
H1: Decision layer costs change significantly with value modulation
H2: Persona differentiation (CTC variance across personas) increases
H3: Conformity-driven personas show higher social proof demand
H4: Achievement-driven personas show lower satisficing demand

Uses extract_page_features.py to compute page metrics from screenshots,
then applies the Python-equivalent of cognitive-transport-chain.ts math.
"""

import os
import sys
import json
import time
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from scipy.stats import ttest_rel, wilcoxon

# ── Persona Cognitive Trait Profiles ──
# Matches CBrowser's built-in personas

PERSONA_TRAITS = {
    'neurotypical': {
        'patience': 0.5, 'riskTolerance': 0.5, 'comprehension': 0.5,
        'persistence': 0.5, 'curiosity': 0.5, 'workingMemory': 0.5,
        'readingTendency': 0.5, 'resilience': 0.5, 'selfEfficacy': 0.5,
        'satisficing': 0.5, 'trustCalibration': 0.5, 'interruptRecovery': 0.5,
        'informationForaging': 0.5, 'changeBlindness': 0.3,
        'anchoringBias': 0.5, 'timeHorizon': 0.5, 'attributionStyle': 0.5,
        'metacognitivePlanning': 0.5, 'proceduralFluency': 0.5,
        'transferLearning': 0.5, 'authoritySensitivity': 0.5,
        'emotionalContagion': 0.5, 'fearOfMissingOut': 0.5,
        'socialProofSensitivity': 0.5, 'mentalModelRigidity': 0.5,
        'siteFamiliarity': 0.5, 'attentionPattern': 0.5, 'motorPrecision': 0.5,
        'processingSpeed': 0.5, 'textProcessing': 0.5,
    },
    'adhd': {
        'patience': 0.2, 'riskTolerance': 0.7, 'comprehension': 0.5,
        'persistence': 0.3, 'curiosity': 0.9, 'workingMemory': 0.3,
        'readingTendency': 0.2, 'resilience': 0.4, 'selfEfficacy': 0.5,
        'satisficing': 0.7, 'trustCalibration': 0.5, 'interruptRecovery': 0.2,
        'informationForaging': 0.8, 'changeBlindness': 0.6,
        'anchoringBias': 0.3, 'timeHorizon': 0.2, 'attributionStyle': 0.5,
        'metacognitivePlanning': 0.2, 'proceduralFluency': 0.3,
        'transferLearning': 0.4, 'authoritySensitivity': 0.3,
        'emotionalContagion': 0.7, 'fearOfMissingOut': 0.8,
        'socialProofSensitivity': 0.6, 'mentalModelRigidity': 0.2,
        'siteFamiliarity': 0.3, 'attentionPattern': 0.3, 'motorPrecision': 0.5,
        'processingSpeed': 0.5, 'textProcessing': 0.4,
    },
    'power_user': {
        'patience': 0.4, 'riskTolerance': 0.8, 'comprehension': 0.95,
        'persistence': 0.7, 'curiosity': 0.6, 'workingMemory': 0.85,
        'readingTendency': 0.3, 'resilience': 0.8, 'selfEfficacy': 0.9,
        'satisficing': 0.3, 'trustCalibration': 0.7, 'interruptRecovery': 0.8,
        'informationForaging': 0.7, 'changeBlindness': 0.2,
        'anchoringBias': 0.3, 'timeHorizon': 0.7, 'attributionStyle': 0.3,
        'metacognitivePlanning': 0.8, 'proceduralFluency': 0.9,
        'transferLearning': 0.85, 'authoritySensitivity': 0.3,
        'emotionalContagion': 0.2, 'fearOfMissingOut': 0.3,
        'socialProofSensitivity': 0.2, 'mentalModelRigidity': 0.2,
        'siteFamiliarity': 0.7, 'attentionPattern': 0.7, 'motorPrecision': 0.8,
        'processingSpeed': 0.8, 'textProcessing': 0.7,
    },
    'elderly': {
        'patience': 0.9, 'riskTolerance': 0.2, 'comprehension': 0.3,
        'persistence': 0.6, 'curiosity': 0.3, 'workingMemory': 0.3,
        'readingTendency': 0.9, 'resilience': 0.5, 'selfEfficacy': 0.2,
        'satisficing': 0.4, 'trustCalibration': 0.3, 'interruptRecovery': 0.3,
        'informationForaging': 0.3, 'changeBlindness': 0.6,
        'anchoringBias': 0.7, 'timeHorizon': 0.7, 'attributionStyle': 0.7,
        'metacognitivePlanning': 0.4, 'proceduralFluency': 0.3,
        'transferLearning': 0.3, 'authoritySensitivity': 0.8,
        'emotionalContagion': 0.5, 'fearOfMissingOut': 0.2,
        'socialProofSensitivity': 0.5, 'mentalModelRigidity': 0.7,
        'siteFamiliarity': 0.2, 'attentionPattern': 0.5, 'motorPrecision': 0.3,
        'processingSpeed': 0.3, 'textProcessing': 0.3,
    },
    'dyslexic': {
        'patience': 0.7, 'riskTolerance': 0.4, 'comprehension': 0.3,
        'persistence': 0.6, 'curiosity': 0.5, 'workingMemory': 0.4,
        'readingTendency': 0.8, 'resilience': 0.6, 'selfEfficacy': 0.4,
        'satisficing': 0.5, 'trustCalibration': 0.5, 'interruptRecovery': 0.5,
        'informationForaging': 0.5, 'changeBlindness': 0.4,
        'anchoringBias': 0.5, 'timeHorizon': 0.5, 'attributionStyle': 0.5,
        'metacognitivePlanning': 0.5, 'proceduralFluency': 0.5,
        'transferLearning': 0.4, 'authoritySensitivity': 0.5,
        'emotionalContagion': 0.5, 'fearOfMissingOut': 0.4,
        'socialProofSensitivity': 0.5, 'mentalModelRigidity': 0.5,
        'siteFamiliarity': 0.3, 'attentionPattern': 0.5, 'motorPrecision': 0.5,
        'processingSpeed': 0.4, 'textProcessing': 0.3,
    },
    'low_vision': {
        'patience': 0.8, 'riskTolerance': 0.2, 'comprehension': 0.4,
        'persistence': 0.7, 'curiosity': 0.3, 'workingMemory': 0.5,
        'readingTendency': 0.8, 'resilience': 0.6, 'selfEfficacy': 0.3,
        'satisficing': 0.4, 'trustCalibration': 0.4, 'interruptRecovery': 0.4,
        'informationForaging': 0.3, 'changeBlindness': 0.7,
        'anchoringBias': 0.6, 'timeHorizon': 0.6, 'attributionStyle': 0.6,
        'metacognitivePlanning': 0.5, 'proceduralFluency': 0.4,
        'transferLearning': 0.4, 'authoritySensitivity': 0.6,
        'emotionalContagion': 0.4, 'fearOfMissingOut': 0.3,
        'socialProofSensitivity': 0.4, 'mentalModelRigidity': 0.6,
        'siteFamiliarity': 0.2, 'attentionPattern': 0.4, 'motorPrecision': 0.3,
        'processingSpeed': 0.4, 'textProcessing': 0.4,
    },
}

# ── Schwartz Values per Persona ──
# Derived from trait-value correlations (Roccas et al., 2002)

PERSONA_VALUES = {
    'neurotypical': {
        'selfDirection': 0.5, 'stimulation': 0.5, 'hedonism': 0.5,
        'achievement': 0.5, 'power': 0.5, 'security': 0.5,
        'conformity': 0.5, 'tradition': 0.5, 'benevolence': 0.5,
        'universalism': 0.5,
    },
    'adhd': {
        'selfDirection': 0.7, 'stimulation': 0.9, 'hedonism': 0.7,
        'achievement': 0.3, 'power': 0.3, 'security': 0.2,
        'conformity': 0.2, 'tradition': 0.1, 'benevolence': 0.5,
        'universalism': 0.4,
    },
    'power_user': {
        'selfDirection': 0.9, 'stimulation': 0.6, 'hedonism': 0.4,
        'achievement': 0.9, 'power': 0.7, 'security': 0.4,
        'conformity': 0.2, 'tradition': 0.2, 'benevolence': 0.4,
        'universalism': 0.5,
    },
    'elderly': {
        'selfDirection': 0.3, 'stimulation': 0.2, 'hedonism': 0.4,
        'achievement': 0.3, 'power': 0.2, 'security': 0.9,
        'conformity': 0.8, 'tradition': 0.9, 'benevolence': 0.8,
        'universalism': 0.7,
    },
    'dyslexic': {
        'selfDirection': 0.5, 'stimulation': 0.4, 'hedonism': 0.5,
        'achievement': 0.5, 'power': 0.3, 'security': 0.6,
        'conformity': 0.5, 'tradition': 0.5, 'benevolence': 0.6,
        'universalism': 0.6,
    },
    'low_vision': {
        'selfDirection': 0.4, 'stimulation': 0.3, 'hedonism': 0.4,
        'achievement': 0.4, 'power': 0.3, 'security': 0.8,
        'conformity': 0.6, 'tradition': 0.7, 'benevolence': 0.7,
        'universalism': 0.6,
    },
}

# ── Value Demand Modulation (mirrors cognitive-transport-chain.ts) ──

VALUE_MODULATIONS = [
    # Saliency layer
    {'value': 'stimulation', 'trait': 'changeBlindness', 'coefficient': -0.20},
    {'value': 'stimulation', 'trait': 'attentionPattern', 'coefficient': 0.20},
    {'value': 'security', 'trait': 'changeBlindness', 'coefficient': -0.15},
    {'value': 'conformity', 'trait': 'attentionPattern', 'coefficient': -0.15},
    # Frustration layer
    {'value': 'security', 'trait': 'trustCalibration', 'coefficient': 0.25},
    {'value': 'achievement', 'trait': 'satisficing', 'coefficient': -0.20},
    {'value': 'achievement', 'trait': 'riskTolerance', 'coefficient': -0.15},
    {'value': 'conformity', 'trait': 'socialProofSensitivity', 'coefficient': 0.30},
    {'value': 'conformity', 'trait': 'anchoringBias', 'coefficient': 0.20},
    {'value': 'stimulation', 'trait': 'curiosity', 'coefficient': 0.25},
    {'value': 'stimulation', 'trait': 'patience', 'coefficient': 0.20},
    {'value': 'selfDirection', 'trait': 'socialProofSensitivity', 'coefficient': -0.20},
    {'value': 'selfDirection', 'trait': 'metacognitivePlanning', 'coefficient': -0.15},
    {'value': 'tradition', 'trait': 'mentalModelRigidity', 'coefficient': 0.25},
    {'value': 'benevolence', 'trait': 'emotionalContagion', 'coefficient': -0.15},
    {'value': 'power', 'trait': 'fearOfMissingOut', 'coefficient': -0.20},
    {'value': 'universalism', 'trait': 'readingTendency', 'coefficient': 0.15},
]

# ── Transport Chain Constants ──

LAYER_DEFINITIONS = [
    {'name': 'saliency', 'traits': ['changeBlindness', 'attentionPattern']},
    {'name': 'cognitiveLoad', 'traits': ['comprehension', 'workingMemory', 'informationForaging']},
    {'name': 'decision', 'traits': ['satisficing', 'anchoringBias', 'riskTolerance', 'fearOfMissingOut', 'socialProofSensitivity']},
    {'name': 'motor', 'traits': ['patience', 'proceduralFluency']},
    {'name': 'frustration', 'traits': ['resilience', 'selfEfficacy', 'patience', 'emotionalContagion']},
    {'name': 'readability', 'traits': ['readingTendency', 'comprehension', 'transferLearning']},
]

WEIGHT_DEFICIT = 1.0
WEIGHT_SURPLUS = 0.3
DEPLETION_RATE = 0.15
CAPACITY_FLOOR = 0.05

DEMAND_DIMENSIONS = [
    'patience', 'riskTolerance', 'comprehension', 'persistence', 'workingMemory',
    'readingTendency', 'resilience', 'selfEfficacy', 'emotionalContagion',
    'satisficing', 'anchoringBias', 'fearOfMissingOut', 'socialProofSensitivity',
    'changeBlindness', 'attentionPattern', 'motorPrecision', 'proceduralFluency',
    'informationForaging', 'metacognitivePlanning', 'transferLearning',
    'interruptRecovery', 'trustCalibration', 'mentalModelRigidity', 'curiosity',
    'processingSpeed', 'textProcessing',
]


# ── Core CTC Computation ──

def sigmoid(raw, threshold, scale):
    x = -(raw - threshold) / scale
    if x > 500: return 0.0
    if x < -500: return 1.0
    return 1.0 / (1.0 + np.exp(x))


def compute_demand(page_metrics):
    """Compute 26D demand distribution from page features."""
    demands = {d: 0.0 for d in DEMAND_DIMENSIONS}

    info = page_metrics.get('informationDensity', 0)
    vis = page_metrics.get('visualComplexity', 0)
    inter = page_metrics.get('interactiveElementCount', 0)
    text = page_metrics.get('textDensity', 0)
    anim = page_metrics.get('animationLevel', 0)
    choices = page_metrics.get('choiceCount', 0)
    nav = page_metrics.get('navigationDepth', 0)

    # Information density
    demands['comprehension'] = max(demands['comprehension'], info)
    demands['workingMemory'] = max(demands['workingMemory'], info * 0.9)
    demands['readingTendency'] = max(demands['readingTendency'], info * 0.85)
    demands['informationForaging'] = max(demands['informationForaging'], info * 0.8)

    # Visual complexity
    demands['changeBlindness'] = max(demands['changeBlindness'], vis)
    demands['mentalModelRigidity'] = max(demands['mentalModelRigidity'], vis * 0.7)
    demands['attentionPattern'] = max(demands['attentionPattern'], vis * 0.85)

    # Interactive elements
    inter_demand = inter / (inter + 20) if inter > 0 else 0
    demands['riskTolerance'] = max(demands['riskTolerance'], inter_demand * 0.75)
    demands['satisficing'] = max(demands['satisficing'], inter_demand * 0.8)
    demands['proceduralFluency'] = max(demands['proceduralFluency'], inter_demand * 0.9)
    demands['motorPrecision'] = max(demands['motorPrecision'], inter_demand)

    # Text density
    demands['readingTendency'] = max(demands['readingTendency'], text)
    demands['patience'] = max(demands['patience'], text * 0.7)
    demands['comprehension'] = max(demands['comprehension'], text * 0.85)

    # Animation
    anim_d = sigmoid(anim, 0.3, 0.15)
    demands['changeBlindness'] = max(demands['changeBlindness'], anim_d * 0.9)
    demands['interruptRecovery'] = max(demands['interruptRecovery'], anim_d * 0.85)
    demands['emotionalContagion'] = max(demands['emotionalContagion'], anim_d * 0.7)

    # Choices
    choice_d = choices / (choices + 10) if choices > 0 else 0
    demands['satisficing'] = max(demands['satisficing'], choice_d)
    demands['anchoringBias'] = max(demands['anchoringBias'], choice_d * 0.85)
    demands['fearOfMissingOut'] = max(demands['fearOfMissingOut'], choice_d * 0.75)
    demands['socialProofSensitivity'] = max(demands['socialProofSensitivity'], choice_d * 0.7)

    # Navigation depth
    nav_d = nav / (nav + 3) if nav > 0 else 0
    demands['workingMemory'] = max(demands['workingMemory'], nav_d * 0.95)
    demands['metacognitivePlanning'] = max(demands['metacognitivePlanning'], nav_d * 0.8)
    demands['persistence'] = max(demands['persistence'], nav_d * 0.7)
    demands['transferLearning'] = max(demands['transferLearning'], nav_d * 0.65)

    # Clamp
    for d in DEMAND_DIMENSIONS:
        demands[d] = max(0.0, min(1.0, demands[d]))

    return demands


def apply_value_modulation(demands, values):
    """Apply Schwartz value modulation to demand distribution."""
    modulated = dict(demands)
    if not values:
        return modulated

    for mod in VALUE_MODULATIONS:
        v_score = values.get(mod['value'], 0.5)
        current = modulated.get(mod['trait'], 0)
        modulation = mod['coefficient'] * v_score * max(0.1, current)
        modulated[mod['trait']] = max(0.0, min(1.0, current + modulation))

    return modulated


def compute_ctc(traits, demands):
    """Compute Sequential CTC. Returns (total_ctc, layer_costs, abandonment_risk)."""
    residual = {d: traits.get(d, 0.5) for d in DEMAND_DIMENSIONS}
    layer_costs = {}
    total = 0.0

    for layer_def in LAYER_DEFINITIONS:
        layer_cost = 0.0
        layer_traits = layer_def['traits']

        for trait in layer_traits:
            d = demands.get(trait, 0)
            c = residual.get(trait, 0.5)
            gap = d - c

            if gap > 0:
                cost = WEIGHT_DEFICIT * gap * gap
            else:
                cost = WEIGHT_SURPLUS * gap * gap

            layer_cost += cost

        # Scale by demand magnitude
        mag = sum(demands.get(t, 0) for t in layer_traits) / max(1, len(layer_traits))
        content_scale = min(1.0, mag * 3)
        layer_cost *= content_scale

        # Deplete capacity
        consumed = DEPLETION_RATE * layer_cost
        if content_scale > 0.1:
            for trait in layer_traits:
                residual[trait] = max(CAPACITY_FLOOR, residual[trait] - consumed)
            for dim in DEMAND_DIMENSIONS:
                if dim not in layer_traits:
                    residual[dim] = max(CAPACITY_FLOOR, residual[dim] - DEPLETION_RATE * 0.5 * layer_cost)

        layer_costs[layer_def['name']] = layer_cost
        total += layer_cost

    # Abandonment risk (sigmoid of total CTC)
    risk = 1.0 / (1.0 + np.exp(-(total - 0.3) / 0.15))

    return total, layer_costs, risk


# ── Page Feature Extraction ──

def extract_features_from_image(img_path):
    """Extract approximate page metrics from screenshot image."""
    from PIL import Image
    import cv2

    img = np.array(Image.open(img_path).convert('RGB'))
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)

    # Edge density → visual complexity proxy
    edges = cv2.Canny(gray, 100, 200)
    edge_density = np.sum(edges > 0) / (h * w)

    # Pixel entropy → information density proxy
    hist = cv2.calcHist([gray], [0], None, [256], [0, 256]).flatten()
    hist = hist / hist.sum()
    hist = hist[hist > 0]
    entropy = -np.sum(hist * np.log2(hist))
    info_density = min(1.0, entropy / 8.0)

    # Text density estimate (high-contrast thin regions)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    text_density = np.sum(thresh < 128) / (h * w)

    # Region count (connected components) → choice/interactive proxy
    _, labels = cv2.connectedComponents(edges)
    region_count = min(500, labels.max())

    return {
        'informationDensity': info_density,
        'visualComplexity': min(1.0, edge_density * 10),
        'interactiveElementCount': int(region_count * 0.3),  # rough proxy
        'textDensity': text_density,
        'animationLevel': 0.0,  # screenshots are static
        'choiceCount': int(region_count * 0.15),
        'navigationDepth': 2,  # assume average
    }


# ── Main Runner ──

def run_study1b(dataset_dir, output_dir, max_images=None):
    output_dir = Path(output_dir)
    output_dir.mkdir(exist_ok=True)
    dataset_dir = Path(dataset_dir)

    # Find images
    images_dir = dataset_dir / 'images'
    if not images_dir.exists():
        print(f"ERROR: No images directory at {images_dir}")
        sys.exit(1)

    # Filter to web images
    image_types_csv = dataset_dir / 'image_types.csv'
    web_images = set()
    if image_types_csv.exists():
        import csv as csv_mod
        with open(str(image_types_csv)) as f:
            reader = csv_mod.DictReader(f, delimiter=';')
            for row in reader:
                if row.get('Category', '').lower() == 'web':
                    web_images.add(row['Image Name'])

    all_paths = sorted(list(images_dir.glob('*.png')) + list(images_dir.glob('*.jpg')))
    if web_images:
        image_paths = [p for p in all_paths if p.name in web_images]
    else:
        image_paths = all_paths

    if max_images:
        image_paths = image_paths[:max_images]

    print(f"Study 1b: Schwartz Value Modulation Effect")
    print(f"Images: {len(image_paths)}")
    print(f"Personas: {list(PERSONA_TRAITS.keys())}")
    print(f"{'='*60}")

    results = []
    t_start = time.time()

    for i, img_path in enumerate(image_paths):
        try:
            features = extract_features_from_image(str(img_path))
            base_demands = compute_demand(features)
            basename = img_path.stem

            for persona_name in PERSONA_TRAITS:
                traits = PERSONA_TRAITS[persona_name]
                values = PERSONA_VALUES[persona_name]

                # Without value modulation (baseline)
                ctc_base, layers_base, risk_base = compute_ctc(traits, base_demands)

                # With value modulation
                mod_demands = apply_value_modulation(base_demands, values)
                ctc_mod, layers_mod, risk_mod = compute_ctc(traits, mod_demands)

                results.append({
                    'image': basename,
                    'persona': persona_name,
                    'ctc_baseline': ctc_base,
                    'ctc_modulated': ctc_mod,
                    'ctc_delta': ctc_mod - ctc_base,
                    'ctc_delta_pct': ((ctc_mod - ctc_base) / max(0.001, ctc_base)) * 100,
                    'risk_baseline': risk_base,
                    'risk_modulated': risk_mod,
                    'risk_delta': risk_mod - risk_base,
                    # Per-layer deltas
                    'saliency_delta': layers_mod.get('saliency', 0) - layers_base.get('saliency', 0),
                    'cognitiveLoad_delta': layers_mod.get('cognitiveLoad', 0) - layers_base.get('cognitiveLoad', 0),
                    'decision_delta': layers_mod.get('decision', 0) - layers_base.get('decision', 0),
                    'motor_delta': layers_mod.get('motor', 0) - layers_base.get('motor', 0),
                    'frustration_delta': layers_mod.get('frustration', 0) - layers_base.get('frustration', 0),
                    'readability_delta': layers_mod.get('readability', 0) - layers_base.get('readability', 0),
                })

            if (i + 1) % 25 == 0:
                elapsed = time.time() - t_start
                rate = (i + 1) / elapsed
                eta = (len(image_paths) - i - 1) / rate
                print(f"  [{i+1}/{len(image_paths)}] {basename} "
                      f"({elapsed:.0f}s elapsed, ~{eta:.0f}s remaining)")

        except Exception as e:
            print(f"  WARN: {img_path.name}: {e}")
            continue

    df = pd.DataFrame(results)

    # ── Analysis ──
    print(f"\n{'='*60}")
    print(f"STUDY 1b RESULTS")
    print(f"{'='*60}")
    print(f"Images processed: {df['image'].nunique()}")
    print(f"Total observations: {len(df)}")

    # Table 1: CTC delta by persona
    print(f"\n--- Table 1: CTC Change by Persona ---")
    print(f"{'Persona':<15} {'Baseline CTC':>12} {'Modulated CTC':>14} {'Delta':>8} {'Delta %':>8} {'p-value':>10}")
    for persona in PERSONA_TRAITS:
        subset = df[df['persona'] == persona]
        base = subset['ctc_baseline'].values
        mod = subset['ctc_modulated'].values
        _, p = wilcoxon(base, mod) if len(base) > 20 else (None, 1.0)
        print(f"{persona:<15} {base.mean():>12.4f} {mod.mean():>14.4f} "
              f"{(mod - base).mean():>+8.4f} {subset['ctc_delta_pct'].mean():>+7.1f}% "
              f"{'***' if p < 0.001 else '**' if p < 0.01 else '*' if p < 0.05 else 'ns':>10}")

    # Table 2: Per-layer delta by persona
    print(f"\n--- Table 2: Per-Layer CTC Delta by Persona ---")
    layers = ['saliency', 'cognitiveLoad', 'decision', 'motor', 'frustration', 'readability']
    header = f"{'Persona':<15}" + "".join(f"{l:>14}" for l in layers)
    print(header)
    for persona in PERSONA_TRAITS:
        subset = df[df['persona'] == persona]
        vals = [subset[f'{l}_delta'].mean() for l in layers]
        row = f"{persona:<15}" + "".join(f"{v:>+14.5f}" for v in vals)
        print(row)

    # Table 3: Persona differentiation (CTC variance)
    print(f"\n--- Table 3: Persona Differentiation ---")
    base_var = df.groupby('image')['ctc_baseline'].var().mean()
    mod_var = df.groupby('image')['ctc_modulated'].var().mean()
    print(f"Mean cross-persona CTC variance (baseline):   {base_var:.6f}")
    print(f"Mean cross-persona CTC variance (modulated):  {mod_var:.6f}")
    print(f"Variance ratio (modulated/baseline):          {mod_var/max(0.0001,base_var):.3f}")
    print(f"Interpretation: {'INCREASED' if mod_var > base_var else 'DECREASED'} differentiation "
          f"({abs(mod_var - base_var) / max(0.0001, base_var) * 100:.1f}% change)")

    # Save results
    df.to_csv(output_dir / 'study1b_results.csv', index=False)

    summary = {
        'images': int(df['image'].nunique()),
        'personas': list(PERSONA_TRAITS.keys()),
        'per_persona': {},
        'differentiation': {
            'baseline_variance': float(base_var),
            'modulated_variance': float(mod_var),
            'variance_ratio': float(mod_var / max(0.0001, base_var)),
        },
    }
    for persona in PERSONA_TRAITS:
        subset = df[df['persona'] == persona]
        summary['per_persona'][persona] = {
            'ctc_baseline_mean': float(subset['ctc_baseline'].mean()),
            'ctc_modulated_mean': float(subset['ctc_modulated'].mean()),
            'ctc_delta_mean': float(subset['ctc_delta'].mean()),
            'ctc_delta_pct': float(subset['ctc_delta_pct'].mean()),
            'decision_layer_delta': float(subset['decision_delta'].mean()),
        }

    with open(output_dir / 'study1b_summary.json', 'w') as f:
        json.dump(summary, f, indent=2)

    print(f"\nResults saved to {output_dir}")
    print(f"Total time: {time.time() - t_start:.0f}s")


if __name__ == '__main__':
    dataset = Path(__file__).parent / 'UEyes_dataset'
    output = Path(__file__).parent / 'results_study1b'
    max_img = int(sys.argv[1]) if len(sys.argv) > 1 else None
    run_study1b(dataset, output, max_img)
