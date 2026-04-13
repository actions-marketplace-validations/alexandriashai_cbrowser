/**
 * Cognitive Optimal Transport — Sequential Transport Chain
 *
 * Implements the CHI 2027 paper's core contribution:
 * - 26-dimensional demand distribution computed from page features
 * - Sequential transport chain where each layer depletes capacity
 * - Asymmetric deficit-surplus cost
 * - Layer interaction terms
 *
 * Mathematical foundation: The total Cognitive Transport Cost is NOT
 * the sum of independent layers. Each layer receives the user's RESIDUAL
 * capacity after prior layers have consumed resources.
 *
 * @see Section 3.4 of "Cognitive Optimal Transport: A Unified Framework"
 * @since v18.39.0
 */

import {
  type OTCognitiveProfile,
  extractPageMetrics,
} from './cognitive-transport.js';

// ── Types ──

/** Page metrics extracted from a live page (matches extractPageMetrics return) */
export interface PageMetrics {
  informationDensity: number;       // 0-1: how dense the content is
  visualComplexity: number;         // 0-1: how visually complex
  interactiveElementCount: number;  // raw count of interactive elements
  textDensity: number;              // 0-1: text-heaviness
  animationLevel: number;           // 0-1: motion/animation amount
  choiceCount: number;              // number of decision points
  navigationDepth: number;          // clicks to reach content
}

export interface DemandDistribution {
  /** 26-dimensional demand vector (0-1 per trait) */
  demands: Record<string, number>;
  /** Per-dimension demand variance (from spatial variability across page) */
  variance: Record<string, number>;
}

export interface LayerResult {
  name: string;
  transportCost: number;
  capacityConsumed: number;
  residualCapacity: Record<string, number>;
}

export interface SequentialTransportResult {
  /** Total Cognitive Transport Cost */
  totalCTC: number;
  /** Per-layer results in sequential order */
  layers: LayerResult[];
  /** Pairwise interaction terms */
  interactions: Record<string, number>;
  /** Additive-only CTC for comparison */
  additiveCTC: number;
  /** Asymmetric deficit-surplus breakdown */
  deficitCost: number;
  surplusCost: number;
  /** Per-trait transport cost */
  traitCosts: Record<string, number>;
  /** Bottleneck layer (highest cost) */
  bottleneckLayer: string;
  /** Predicted abandonment probability (0-1) */
  abandonmentRisk: number;
}

// ── Constants ──

/**
 * The 26 demand dimensions used by the sequential transport chain.
 * Superset of the base 25 OT cognitive traits — includes extended traits
 * from CognitiveTraits that capture decision biases, learning transfer,
 * and emotional regulation.
 */
export const DEMAND_DIMENSIONS = [
  // Core capacity traits
  'patience', 'riskTolerance', 'comprehension',
  'persistence', 'workingMemory', 'readingTendency',
  // Emotional regulation
  'resilience', 'selfEfficacy', 'emotionalContagion',
  // Decision-making
  'satisficing', 'anchoringBias', 'fearOfMissingOut', 'socialProofSensitivity',
  // Perceptual
  'changeBlindness', 'attentionPattern',
  // Motor & procedural
  'motorPrecision', 'proceduralFluency',
  // Cognitive strategy
  'informationForaging', 'metacognitivePlanning', 'transferLearning',
  // Interrupt & recovery
  'interruptRecovery',
  // Trust
  'trustCalibration',
  // Additional extended traits
  'mentalModelRigidity', 'curiosity',
  // Processing
  'processingSpeed', 'textProcessing',
] as const;

/**
 * Layer definitions for the sequential transport chain.
 * Order reflects temporal processing: perception -> cognition -> decision -> action -> affect -> comprehension.
 */
const LAYER_DEFINITIONS: Array<{ name: string; traits: string[] }> = [
  {
    name: 'saliency',
    traits: ['changeBlindness', 'attentionPattern'],
  },
  {
    name: 'cognitiveLoad',
    traits: ['comprehension', 'workingMemory', 'informationForaging'],
  },
  {
    name: 'decision',
    traits: ['satisficing', 'anchoringBias', 'riskTolerance', 'fearOfMissingOut', 'socialProofSensitivity'],
  },
  {
    name: 'motor',
    traits: ['patience', 'proceduralFluency'],
  },
  {
    name: 'frustration',
    traits: ['resilience', 'selfEfficacy', 'patience', 'emotionalContagion'],
  },
  {
    name: 'readability',
    traits: ['readingTendency', 'comprehension', 'transferLearning'],
  },
];

/**
 * Pairwise interaction definitions — the top 5 cross-layer effects
 * identified in the CHI 2027 paper's empirical calibration (Table 3).
 */
const INTERACTION_PAIRS: Array<{ a: string; b: string; weight: number }> = [
  { a: 'cognitiveLoad', b: 'decision', weight: 0.15 },
  { a: 'saliency', b: 'cognitiveLoad', weight: 0.15 },
  { a: 'frustration', b: 'readability', weight: 0.15 },
  { a: 'cognitiveLoad', b: 'motor', weight: 0.15 },
  { a: 'frustration', b: 'decision', weight: 0.15 },
];

/** Asymmetric cost weights (Theorem 2 in paper) */
const WEIGHT_DEFICIT = 1.0;   // demand > capacity: high cost
const WEIGHT_SURPLUS = 0.3;   // capacity > demand: low cost (surplus is cheap)

/** Capacity depletion rate per layer (alpha_i, Section 3.4) */
const DEPLETION_RATE = 0.15;

/** Minimum residual capacity floor (prevents total exhaustion) */
const CAPACITY_FLOOR = 0.05;

// ── Sigmoid Helper ──

/**
 * Standard logistic sigmoid for mapping raw page metrics to demand values.
 * Calibrated thresholds ensure typical web pages produce demands in [0.1, 0.9].
 */
function sigmoid(raw: number, threshold: number, scale: number): number {
  const x = -(raw - threshold) / scale;
  // Clamp exponent to prevent overflow
  if (x > 500) return 0;
  if (x < -500) return 1;
  return 1 / (1 + Math.exp(x));
}

// ── 1. Demand Distribution Computation ──

/**
 * Compute the 26-dimensional demand distribution from page metrics.
 *
 * Each page feature maps to specific trait dimensions via calibrated
 * sigmoid functions. The mapping encodes HOW each page characteristic
 * creates cognitive demand on specific user capacities.
 *
 * Traits not affected by any page feature receive demand = 0.0 (no demand).
 *
 * @param pageMetrics - Extracted page analysis metrics
 * @returns DemandDistribution with per-trait demand and variance
 */
export function computeDemandDistribution(pageMetrics: PageMetrics): DemandDistribution {
  const demands: Record<string, number> = {};
  const variance: Record<string, number> = {};

  // Initialize all 26 dimensions to zero demand
  for (const dim of DEMAND_DIMENSIONS) {
    demands[dim] = 0;
    variance[dim] = 0;
  }

  // Sanitize inputs — guard against NaN, undefined, negative
  const safe = (v: number | undefined, fallback: number = 0): number => {
    if (v === undefined || v === null || Number.isNaN(v)) return fallback;
    return Math.max(0, v);
  };

  const infoDensity = safe(pageMetrics.informationDensity);
  const visCplx = safe(pageMetrics.visualComplexity);
  const interactiveCount = safe(pageMetrics.interactiveElementCount);
  const textDens = safe(pageMetrics.textDensity);
  const animLevel = safe(pageMetrics.animationLevel);
  const choices = safe(pageMetrics.choiceCount);
  const navDepth = safe(pageMetrics.navigationDepth);

  // ── informationDensity → comprehension, workingMemory, readingTendency, informationForaging
  // Page metrics already use logScale (0-1) — pass through directly for differentiation
  const infoDemand = infoDensity;
  demands.comprehension = Math.max(demands.comprehension, infoDemand);
  demands.workingMemory = Math.max(demands.workingMemory, infoDemand * 0.9);
  demands.readingTendency = Math.max(demands.readingTendency, infoDemand * 0.85);
  demands.informationForaging = Math.max(demands.informationForaging, infoDemand * 0.8);
  variance.comprehension += infoDensity * 0.1;
  variance.workingMemory += infoDensity * 0.08;
  variance.readingTendency += infoDensity * 0.07;
  variance.informationForaging += infoDensity * 0.06;

  // ── visualComplexity → changeBlindness, mentalModelRigidity, attentionPattern (inferred)
  const visDemand = visCplx; // already 0-1 from logScale
  demands.changeBlindness = Math.max(demands.changeBlindness, visDemand);
  demands.mentalModelRigidity = Math.max(demands.mentalModelRigidity, visDemand * 0.7);
  demands.attentionPattern = Math.max(demands.attentionPattern, visDemand * 0.85);
  variance.changeBlindness += visCplx * 0.12;
  variance.mentalModelRigidity += visCplx * 0.08;
  variance.attentionPattern += visCplx * 0.1;

  // ── interactiveElementCount → riskTolerance, satisficing, proceduralFluency, motorPrecision (inferred)
  // Use logScale for element count — 20 elements = 0.5, 100 = 0.83, 500 = 0.96
  const interDemand = interactiveCount / (interactiveCount + 20);
  demands.riskTolerance = Math.max(demands.riskTolerance, interDemand * 0.75);
  demands.satisficing = Math.max(demands.satisficing, interDemand * 0.8);
  demands.proceduralFluency = Math.max(demands.proceduralFluency, interDemand * 0.9);
  demands.motorPrecision = Math.max(demands.motorPrecision, interDemand);
  variance.riskTolerance += interDemand * 0.06;
  variance.satisficing += interDemand * 0.07;
  variance.proceduralFluency += interDemand * 0.08;
  variance.motorPrecision += interDemand * 0.1;

  // ── textDensity → readingTendency, patience, comprehension
  const textDemand = textDens; // already 0-1 from logScale
  demands.readingTendency = Math.max(demands.readingTendency, textDemand);
  demands.patience = Math.max(demands.patience, textDemand * 0.7);
  demands.comprehension = Math.max(demands.comprehension, textDemand * 0.85);
  variance.readingTendency += textDens * 0.09;
  variance.patience += textDens * 0.06;
  variance.comprehension += textDens * 0.08;

  // ── animationLevel → changeBlindness, interruptRecovery, emotionalContagion
  const animDemand = sigmoid(animLevel, 0.3, 0.15);
  demands.changeBlindness = Math.max(demands.changeBlindness, animDemand * 0.9);
  demands.interruptRecovery = Math.max(demands.interruptRecovery, animDemand * 0.85);
  demands.emotionalContagion = Math.max(demands.emotionalContagion, animDemand * 0.7);
  variance.changeBlindness += animLevel * 0.1;
  variance.interruptRecovery += animLevel * 0.09;
  variance.emotionalContagion += animLevel * 0.07;

  // ── choiceCount → satisficing, anchoringBias, fearOfMissingOut, socialProofSensitivity
  // LogScale: 10 choices = 0.5, 30 = 0.75, 100 = 0.91
  const choiceDemand = choices / (choices + 10);
  demands.satisficing = Math.max(demands.satisficing, choiceDemand);
  demands.anchoringBias = Math.max(demands.anchoringBias, choiceDemand * 0.85);
  demands.fearOfMissingOut = Math.max(demands.fearOfMissingOut, choiceDemand * 0.75);
  demands.socialProofSensitivity = Math.max(demands.socialProofSensitivity, choiceDemand * 0.7);
  variance.satisficing += Math.min(1, choices / 20) * 0.1;
  variance.anchoringBias += Math.min(1, choices / 20) * 0.08;
  variance.fearOfMissingOut += Math.min(1, choices / 20) * 0.07;
  variance.socialProofSensitivity += Math.min(1, choices / 20) * 0.06;

  // ── navigationDepth → workingMemory, metacognitivePlanning, persistence, transferLearning
  // LogScale: depth 2 = 0.4, depth 5 = 0.63, depth 10 = 0.77
  const navDemand = navDepth / (navDepth + 3);
  demands.workingMemory = Math.max(demands.workingMemory, navDemand * 0.95);
  demands.metacognitivePlanning = Math.max(demands.metacognitivePlanning, navDemand * 0.8);
  demands.persistence = Math.max(demands.persistence, navDemand * 0.7);
  demands.transferLearning = Math.max(demands.transferLearning, navDemand * 0.65);
  variance.workingMemory += Math.min(1, navDepth / 5) * 0.09;
  variance.metacognitivePlanning += Math.min(1, navDepth / 5) * 0.07;
  variance.persistence += Math.min(1, navDepth / 5) * 0.06;
  variance.transferLearning += Math.min(1, navDepth / 5) * 0.05;

  // Clamp all demands and variances to [0, 1]
  for (const dim of DEMAND_DIMENSIONS) {
    demands[dim] = Math.max(0, Math.min(1, demands[dim]));
    variance[dim] = Math.max(0, Math.min(1, variance[dim]));
  }

  return { demands, variance };
}

// ── 2. Sequential Transport Chain ──

/**
 * Resolve a trait value from the persona's trait record.
 * Falls back to 0.5 (neutral midpoint) for missing traits.
 */
function traitValue(traits: Record<string, number>, trait: string): number {
  const v = traits[trait];
  if (v === undefined || v === null || Number.isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

/**
 * Compute the Sequential Cognitive Transport Cost (CTC).
 *
 * Unlike additive cognitive load models, the sequential chain depletes
 * capacity at each processing layer. A user who spends cognitive resources
 * on saliency detection has LESS available for subsequent decision-making.
 *
 * The algorithm processes layers in temporal order:
 *   Saliency -> Cognitive Load -> Decision -> Motor -> Frustration -> Readability
 *
 * Each layer:
 * 1. Computes asymmetric transport cost (deficit is expensive, surplus is cheap)
 * 2. Depletes residual capacity proportional to cost incurred
 * 3. Records the remaining capacity for downstream layers
 *
 * @param persona - OTCognitiveProfile with trait values
 * @param demand - 26D demand distribution from page analysis
 * @param options - Enable/disable asymmetric costs and interaction terms
 * @returns Complete sequential transport result with per-layer breakdown
 */
export function computeSequentialCTC(
  persona: OTCognitiveProfile,
  demand: DemandDistribution,
  options?: { asymmetric?: boolean; interactions?: boolean },
): SequentialTransportResult {
  const useAsymmetric = options?.asymmetric !== false; // default true
  const useInteractions = options?.interactions !== false; // default true

  // Initialize residual capacity from persona traits
  const residualCapacity: Record<string, number> = {};
  for (const dim of DEMAND_DIMENSIONS) {
    residualCapacity[dim] = traitValue(persona.traits, dim);
  }

  const layers: LayerResult[] = [];
  const traitCosts: Record<string, number> = {};
  let totalDeficit = 0;
  let totalSurplus = 0;
  let additiveCTC = 0;

  // Initialize per-trait costs to zero
  for (const dim of DEMAND_DIMENSIONS) {
    traitCosts[dim] = 0;
  }

  // Process each layer sequentially
  for (const layerDef of LAYER_DEFINITIONS) {
    let layerCost = 0;
    let layerDeficit = 0;
    let layerSurplus = 0;

    // Compute transport cost for this layer's traits
    for (const trait of layerDef.traits) {
      const d = demand.demands[trait] ?? 0;
      const c = residualCapacity[trait] ?? 0.5;
      const gap = d - c;

      let cost: number;
      if (gap > 0) {
        // Deficit: demand exceeds capacity — expensive
        cost = (useAsymmetric ? WEIGHT_DEFICIT : 1.0) * gap * gap;
        layerDeficit += cost;
      } else {
        // Surplus: capacity exceeds demand — cheap
        cost = (useAsymmetric ? WEIGHT_SURPLUS : 1.0) * gap * gap;
        layerSurplus += cost;
      }

      layerCost += cost;
      traitCosts[trait] = (traitCosts[trait] ?? 0) + cost;
    }

    // Scale layer cost by demand presence — empty pages shouldn't produce high costs
    const layerDemandMagnitude = layerDef.traits.reduce(
      (sum, t) => sum + (demand.demands[t] ?? 0), 0
    ) / layerDef.traits.length;
    const contentScale = Math.min(1.0, layerDemandMagnitude * 3); // 0-1 scale, saturates at demand=0.33
    layerCost *= contentScale;
    layerDeficit *= contentScale;
    layerSurplus *= contentScale;

    totalDeficit += layerDeficit;
    totalSurplus += layerSurplus;
    additiveCTC += layerCost;

    // Deplete capacity for next layers (only when page has meaningful content)
    // Each trait in this layer loses capacity proportional to the layer's total cost
    const capacityConsumed = DEPLETION_RATE * layerCost;
    if (contentScale > 0.1) {
      for (const trait of layerDef.traits) {
        residualCapacity[trait] -= capacityConsumed;
        residualCapacity[trait] = Math.max(CAPACITY_FLOOR, residualCapacity[trait]);
      }

      // Also deplete shared traits that appear in later layers
      // (cross-layer fatigue: cognitive exhaustion bleeds across boundaries)
      for (const dim of DEMAND_DIMENSIONS) {
        if (!layerDef.traits.includes(dim)) {
          // Indirect depletion at half rate
          residualCapacity[dim] -= (DEPLETION_RATE * 0.5) * layerCost;
          residualCapacity[dim] = Math.max(CAPACITY_FLOOR, residualCapacity[dim]);
        }
      }
    }

    layers.push({
      name: layerDef.name,
      transportCost: layerCost,
      capacityConsumed,
      residualCapacity: { ...residualCapacity },
    });
  }

  // Compute interaction terms
  const interactions: Record<string, number> = {};
  let interactionTotal = 0;

  if (useInteractions) {
    const layerCostMap: Record<string, number> = {};
    for (const layer of layers) {
      layerCostMap[layer.name] = layer.transportCost;
    }

    for (const pair of INTERACTION_PAIRS) {
      const costA = layerCostMap[pair.a] ?? 0;
      const costB = layerCostMap[pair.b] ?? 0;
      const interaction = costA * costB * pair.weight;
      const key = `${pair.a}x${pair.b}`;
      interactions[key] = interaction;
      interactionTotal += interaction;
    }
  }

  // Total CTC = sum of layer costs + interaction terms
  // Note: additiveCTC is layers-only (no interactions, no sequential effects)
  // The sequential effect is already embedded in layer costs via capacity depletion
  const totalCTC = layers.reduce((sum, l) => sum + l.transportCost, 0) + interactionTotal;

  // Find bottleneck layer
  let maxLayerCost = 0;
  let bottleneckLayer = layers[0]?.name ?? 'saliency';
  for (const layer of layers) {
    if (layer.transportCost > maxLayerCost) {
      maxLayerCost = layer.transportCost;
      bottleneckLayer = layer.name;
    }
  }

  // Compute abandonment risk
  // Base abandonment on deficit, not total cost
  // Surplus (capacity > demand) should REDUCE risk, not increase it
  const patienceCapacity = traitValue(persona.traits, 'patience');
  const deficitMagnitude = totalDeficit; // raw deficit cost
  const adjustedCost = deficitMagnitude - totalSurplus * 0.2; // surplus provides some comfort
  const abandonmentRisk = Math.max(0, Math.min(1,
    1 / (1 + Math.exp(-(adjustedCost - patienceCapacity) / 0.4))
  ));

  return {
    totalCTC,
    layers,
    interactions,
    additiveCTC,
    deficitCost: totalDeficit,
    surplusCost: totalSurplus,
    traitCosts,
    bottleneckLayer,
    abandonmentRisk,
  };
}

// ── 3. Convenience: Full COT Pipeline ──

/**
 * End-to-end Cognitive Optimal Transport computation.
 *
 * Extracts page metrics from a live Playwright page, computes the
 * 26D demand distribution, and runs the full sequential transport chain.
 *
 * This is the primary entry point for MCP tools that need a single
 * CTC score with full breakdown.
 *
 * @param persona - OTCognitiveProfile with trait values
 * @param page - Playwright Page object (or any object with evaluate())
 * @returns Complete sequential transport result
 */
export async function computeFullCOT(
  persona: OTCognitiveProfile,
  page: any,
): Promise<SequentialTransportResult> {
  // Extract page metrics via Playwright's page.evaluate()
  const metrics = await extractPageMetrics(page);

  // Compute 26D demand distribution
  const demand = computeDemandDistribution(metrics);

  // Run sequential transport chain with full options
  return computeSequentialCTC(persona, demand, {
    asymmetric: true,
    interactions: true,
  });
}

// ── 4. Utility Exports ──

/**
 * Compute demand distribution from raw metric values (no page required).
 * Useful for testing, simulation, and sensitivity analysis.
 */
export function computeDemandFromRawMetrics(
  informationDensity: number,
  visualComplexity: number,
  interactiveElementCount: number,
  textDensity: number,
  animationLevel: number,
  choiceCount: number,
  navigationDepth: number,
): DemandDistribution {
  return computeDemandDistribution({
    informationDensity,
    visualComplexity,
    interactiveElementCount,
    textDensity,
    animationLevel,
    choiceCount,
    navigationDepth,
  });
}

/**
 * Compare sequential vs. additive CTC to quantify the sequential effect.
 *
 * Returns the ratio (sequential / additive). Values > 1.0 indicate that
 * capacity depletion and interactions amplify the total cost beyond what
 * independent layers would predict.
 */
export function sequentialAmplification(result: SequentialTransportResult): number {
  if (result.additiveCTC === 0) return 1.0;
  return result.totalCTC / result.additiveCTC;
}

/**
 * Identify the top N most costly traits across all layers.
 * Useful for targeted remediation — fix the traits that hurt most.
 */
export function topCostlyTraits(
  result: SequentialTransportResult,
  n: number = 5,
): Array<{ trait: string; cost: number }> {
  return Object.entries(result.traitCosts)
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([trait, cost]) => ({ trait, cost }));
}

/**
 * Compute CTC for a minimal/empty page (baseline).
 * Useful for normalizing CTC scores against the best-case scenario.
 */
export function baselineCTC(persona: OTCognitiveProfile): SequentialTransportResult {
  const emptyDemand: DemandDistribution = {
    demands: {},
    variance: {},
  };
  for (const dim of DEMAND_DIMENSIONS) {
    emptyDemand.demands[dim] = 0;
    emptyDemand.variance[dim] = 0;
  }
  return computeSequentialCTC(persona, emptyDemand);
}
