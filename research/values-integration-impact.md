# Values Integration — Impact on CHI 2027 Paper Formulas

**Date:** 2026-04-14
**Context:** Motivational values (Schwartz) were integrated into the cognitive simulation engine and attention quality system. This document describes how the implementation changes map to the paper's mathematical framework and what needs updating.

---

## 1. Demand Distribution (Section 3.2) — Now Value-Modulated

### Paper's Current Formula

```
demand_k = σ((raw_feature_k − threshold_k) / scale_k)
```

Demand is computed purely from page features — same for all personas.

### What Changed

Demand is now SCALED by the persona's value profile before entering the CTC computation. For decision-related dimensions (satisficing, anchoringBias, riskTolerance, fearOfMissingOut, socialProofSensitivity):

```
conservation = (security + conformity + tradition) / 3
openness = (selfDirection + stimulation) / 2

demand'_k = demand_k × (1 + (conservation − openness) × 0.3)
```

For frustration-related dimensions (resilience, selfEfficacy, emotionalContagion):

```
achievementMod = 1 + (achievement − 0.5) × 0.3

demand'_k = demand_k × achievementMod
```

### Paper Impact

Section 3.2 needs a new subsection: **"Value-Modulated Demand."** The mapping functions f, g, h, j now take a persona parameter:

```
demand_k(page, persona) = σ(raw_k) × valueModulator_k(persona.values)
```

This is theoretically significant — the SAME page has different effective demand for different personas, not just different capacity. A page with many choices is objectively complex, but a high-conformity persona perceives it as MORE demanding because they need social proof to decide.

### Implementation Reference

`src/mcp-tools/base/persona-comparison-tools.ts` — demand modulation block after `computeDemandDistribution()`.

---

## 2. Sequential Transport Chain (Section 3.4) — Values Shift Layer Costs

### Paper's Current Formula

```
CTC_total = Σ_i w_i × CTC_layer_i(U_{i-1}, D_i) + Σ_{ij} w_{ij} × CTC_i × CTC_j
```

Layer costs are trait-dependent only. Values play no role.

### What Changed

Layer 3 (decision) and Layer 5 (frustration) now have value-dependent coefficients:

```
CTC_layer3' = CTC_layer3 × (1 + (conservation − openness) × 0.3)
CTC_layer5' = CTC_layer5 × (1 + (achievement − 0.5) × 0.3)
```

### Paper Impact

The sequential chain formula becomes:

```
CTC_total = Σ_i w_i × v_i(persona) × CTC_layer_i(U_{i-1}, D_i) + Σ_{ij} w_{ij} × CTC_i × CTC_j
```

Where `v_i(persona)` is the value modulation coefficient for layer i. This adds 6 value-modulation parameters (one per layer) to the model. In practice only 2 are non-trivial (decision and frustration); the other 4 default to 1.0.

### Mathematical Justification

Values scale the *effective cost* of each layer, not the demand or capacity directly. A high-achievement persona doesn't have less patience (that's the trait); they experience the same delay as more costly because their motivational system penalizes inefficiency. This is the distinction between traits (HOW the persona processes) and values (WHAT the persona prioritizes).

### Implementation Reference

`src/mcp-tools/base/persona-comparison-tools.ts` — demand scaling block.
`src/mcp-tools/base/cognitive-tools.ts` — `cognitive_journey_update_state` handler.

---

## 3. Cognitive Journey State Machine — Values Modulate Dynamics

### Paper's Current Model

```
patience -= 0.02 + frustration × 0.05
frustration += 0.2  (on failure)
confusion += (1 − comprehension) × 0.15  (on confusing action)
```

### What Changed

Four value modulation factors (0.8-1.2 range):

```
securityMod    = 1 + (security − 0.5) × 0.4
stimulationMod = 1 + (stimulation − 0.5) × 0.4
achievementMod = 1 + (achievement − 0.5) × 0.4
conformityMod  = 1 + (conformity − 0.5) × 0.4
```

Applied to state transitions:

```
patience -= frustration × 0.05 × achievementMod           // Achievement: impatient with inefficiency
frustration += 0.2 × securityMod                           // Security: more reactive to failure
confusion -= 0.1 × stimulationMod  (on success)            // Stimulation: recovers faster from novelty
confusion += (1 − comprehension) × 0.15 × conformityMod   // Conformity: needs clear guidance
confidence -= 0.15 × securityMod  (on going back)          // Security: risk aversion
confidence += 0.1 × achievementMod  (on progress)          // Achievement: progress = confidence
```

### Abandonment Thresholds

```
frustrationThreshold = 0.85 / securityMod    // Security-focused abandon earlier on risk
confusionThreshold = 0.8 / conformityMod     // Conformity-focused abandon earlier on ambiguity
```

### Value-Specific Abandonment Messages

- High security + frustration: "This doesn't feel safe or reliable. I'm leaving."
- High conformity + confusion: "I can't tell what most people would do here. I'll try something else."
- Default: "This is so frustrating! I'm done." / "I have no idea what I'm supposed to do here."

### Paper Impact

Section 3.4 (Layer 5: Frustration and Abandonment) needs to incorporate value-dependent thresholds. The distributional RL model should include value-weighted reward expectations:

```
reward_expectation(step) = f(outcome_distribution, persona.values)
abandonment_threshold(persona) = base_threshold / valueModulation(persona)
```

### Implementation Reference

`src/mcp-tools/base/cognitive-tools.ts` — `cognitive_journey_update_state` handler.

---

## 4. Attention Quality (Layer 1) — NEW: Value Relevance

### Not in Paper Yet

The paper describes Layer 1 as pure perceptual saliency (CIE-Lab center-surround contrast with persona-specific attention filters). There is no motivational component.

### What Was Built

A three-layer extension to the attention quality system:

#### Layer A: Semantic Element Classification

DOM elements are now classified into 7 value-relevant semantic types using regex patterns on text content and CSS class names:

| Type | Detection Patterns | Example |
|------|-------------------|---------|
| `trust-signal` | secure, verified, guarantee, badge, shield, lock | "Money-back guarantee" |
| `social-proof` | review, rating, trusted by, 4K+ users | "Trusted by 10,000 companies" |
| `novelty` | new, beta, updated, just added, early access | "New Feature" badge |
| `metrics` | percentages, ROI, save, faster, performance | "3x faster deployment" |
| `urgency` | limited, only X left, hurry, countdown | "Only 3 seats left" |
| `community` | community, join, together, open source | "Join our community" |
| `authority` | Fortune, Forbes, award, enterprise, expert | "Used by Fortune 500" |

#### Layer B: Value-Semantic Weight Matrix

Each semantic type maps to Schwartz values with empirical weights:

```
VALUE_SEMANTIC_WEIGHTS = {
  "trust-signal":  { security: 1.0, conformity: 0.5, tradition: 0.3 },
  "social-proof":  { conformity: 1.0, security: 0.6, tradition: 0.3 },
  "novelty":       { stimulation: 1.0, selfDirection: 0.5 },
  "metrics":       { achievement: 1.0, power: 0.4 },
  "urgency":       { stimulation: 0.5, achievement: 0.4 },
  "community":     { benevolence: 0.8, universalism: 0.6, conformity: 0.3 },
  "authority":     { security: 0.5, conformity: 0.6, tradition: 0.4, power: 0.3 },
}
```

#### Layer C: Value Relevance Score

```
valueRelevance(element, persona) = Σ_v (persona.values[v] × weight[semanticType][v]) / Σ_v weight[v]

valueRelevanceScore(page, persona) = Σ_targets (saliency_i × valueRelevance_i) / totalSaliency
```

### Paper Impact

Layer 1 needs to become a **two-component model**:

```
attention_quality = w_sal × saliency_match + w_val × value_relevance
```

- **Component A:** Perceptual saliency (existing CIE-Lab W₂) — WHERE the persona looks
- **Component B:** Motivational salience (value × semantic type matching) — WHETHER what they see matters to them

This is the most novel theoretical contribution — no existing saliency model includes motivational values. The `valueRelevanceScore` provides the empirical metric.

### Quality Score Formula

```
qualityScore = ctaCaptureRate × 35       // CTA visibility
             + valuePropSalience × 25    // Headline/message visibility
             + (1 − distractorRatio) × 25 // Low distraction
             + valueRelevanceScore × 10   // Value-relevant attention (NEW)
             + 5                          // Base
```

### Implementation Reference

`src/visual/attention-quality.ts` — `classifySemanticType()`, `computeValueRelevance()`, `VALUE_SEMANTIC_WEIGHTS`, updated `computeAttentionQuality()`.

---

## 5. What the Paper Should Add

### New Section: 3.1.2 "Motivational Values as Modulation Layer"

Key points:
- Values don't replace traits — they modulate how traits interact with demands
- Mathematical hierarchy: **traits = HOW** the persona processes, **values = WHAT** the persona prioritizes
- Values create a multiplicative coupling between the persona's motivational profile and the interface's semantic content
- The relationship is: `effective_cost = trait_cost × value_modulation`

### Relationship to Existing Sections

| Section | Current State | With Values |
|---------|--------------|-------------|
| 3.1 (Profiles) | 26-dim Gaussian + Schwartz values (not used) | 26-dim Gaussian + Schwartz values (active modulation) |
| 3.2 (Demand) | Page features → demand (persona-independent) | Page features × value modulation → demand (persona-dependent) |
| 3.4 (Sequential chain) | 6 layers with trait-based costs | 6 layers with trait × value costs |
| 3.4 Layer 1 (Saliency) | Perceptual only | Perceptual + motivational salience |
| 3.4 Layer 5 (Frustration) | Fixed thresholds | Value-dependent thresholds |

---

## 6. Testable Predictions for Study 3

The value integration creates two NEW crossover predictions, orthogonal to the existing trait-based saliency crossover:

### Prediction A: Security × Trust Signals

High-security personas (elderly μ=0.9, first-timer μ=0.8, anxious-user μ=0.95) should show disproportionate attention to trust badges, security icons, guarantee text.

**Test:** Compare `valueRelevanceScore` for high-security vs low-security personas on pages WITH trust signals vs WITHOUT. Expect interaction: high-security personas get higher VRS on trust-signal-rich pages, but not on trust-signal-poor pages.

### Prediction B: Stimulation × Novelty

High-stimulation personas (ADHD μ=0.9, explorer μ=0.9) should show disproportionate attention to "New" badges, beta labels, feature announcements.

**Test:** Compare `valueRelevanceScore` for high-stimulation vs low-stimulation personas on pages WITH novelty indicators vs WITHOUT. Expect same interaction pattern.

### Prediction C: Achievement × Metrics

High-achievement personas (power-user μ=0.8, impatient-user μ=0.8, task-focused μ=0.9) should fixate on ROI numbers, performance stats, and efficiency claims.

**Test:** Pages with visible metrics (comparison tables, stat badges) should produce higher VRS for achievement-focused personas.

### Why These Are Novel

No existing saliency model predicts attention allocation from motivational values. Deep learning saliency models (DeepGaze, SAM) predict WHERE people look from visual features. COT predicts WHERE people look from visual features × cognitive traits. The value extension predicts WHETHER WHAT THEY SEE MATTERS from motivational profiles — a third dimension that is orthogonal to both perceptual saliency and cognitive capacity.

---

## 7. Parameter Count Impact

| Component | Before | After | New Parameters |
|-----------|--------|-------|----------------|
| Demand modulation | 0 | 2 | conservation-openness axis, achievement axis |
| Layer cost modulation | 0 | 6 | One per layer (4 are 1.0 by default) |
| Value-semantic weights | 0 | ~35 | 7 semantic types × ~5 values each |
| Journey state modulation | 0 | 4 | security, stimulation, achievement, conformity mods |
| Quality score weights | 4 | 5 | Added valueRelevance weight |
| **Total new** | | | **~52 parameters** |

All new parameters have default values that reproduce the pre-values behavior (modulation = 1.0, value weights from Schwartz theory). The model degrades gracefully — without values, it's identical to the trait-only version.
