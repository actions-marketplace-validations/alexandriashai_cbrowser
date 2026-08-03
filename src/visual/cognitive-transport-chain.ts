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
  // Text readability metrics (v18.56) — HOW HARD the text is, not just how much
  avgWordLength?: number;           // 0-1: normalized avg word length (longer = harder)
  avgSentenceLength?: number;       // 0-1: normalized avg words per sentence
  lexicalDiversity?: number;        // 0-1: type-token ratio (higher = more diverse vocab)
  longWordRatio?: number;           // 0-1: fraction of 7+ character words
  technicalDensity?: number;        // 0-1: fraction of 10+ character words
  scriptFamily?: 'alphabetic' | 'cjk' | 'abjad';  // Detected script family
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
  /** Un-normalized total. `totalCTC` is a sigmoid of this. */
  rawCTC: number;
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
  'mentalModelFlexibility', 'curiosity',
  // Processing
  'processingSpeed', 'textProcessing',
  // Experience
  //
  // Absent until 2026-08-02, which is why the siteFamiliarity parameter was
  // inert. It is a member of COGNITIVE_TRAITS, so a persona carried a capacity
  // on this dimension, but the demand vector had no slot for it -- so the
  // capacity was transported against a demand that did not exist and
  // contributed nothing. Runs at familiarity 0 and 1 came back byte-identical
  // while the tool attested the parameter had been applied.
  //
  // The two vectors are supposed to be the same space. A dimension present in
  // one and missing from the other is silently dropped, and there is now a test
  // asserting COGNITIVE_TRAITS and DEMAND_DIMENSIONS do not diverge.
  'siteFamiliarity',
  // Capacity, bridged from the formal reading and pointing models.
  //
  // These layers previously read DISPOSITION traits -- readingTendency for
  // readability, patience and proceduralFluency for motor -- while the modules
  // that actually model decoding and Fitts pointing sat beside them, computing
  // WPM, visual span, phonological penalties, movement times and hit
  // probabilities that no layer ever consumed. A dyslexic persona therefore
  // scored LOWER readability cost than an ADHD persona on a text-dense page.
  //
  // `sustainedAttention` is the attentional half of reading, and it was missing
  // from the model entirely. Taking `readingTendency` out of the readability
  // layer left decoding and nothing else, so an ADHD reader -- whose decoding is
  // typically intact and whose difficulty is holding the line -- read a wall of
  // text at no attentional cost at all.
  'readingCapacity', 'motorCapacity', 'sustainedAttention',
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
    // siteFamiliarity added 2026-08-02. It was in COGNITIVE_TRAITS and in no
    // layer, so it reached the profile, got a capacity, and then contributed to
    // nothing -- the third and final reason the parameter was inert. Knowing a
    // site is a substitute for holding its layout in working memory, which is
    // exactly this layer, and the demand term for it comes from the same
    // navigationDepth signal that already feeds workingMemory here.
    // `transferLearning` moved here from readability 2026-08-02: applying a
    // pattern learned on one interface to another is a load question, not a
    // decoding one, and readability is now decoding-only.
    traits: ['comprehension', 'workingMemory', 'informationForaging', 'siteFamiliarity', 'transferLearning'],
  },
  {
    name: 'decision',
    traits: ['satisficing', 'anchoringBias', 'riskTolerance', 'fearOfMissingOut', 'socialProofSensitivity'],
  },
  {
    name: 'motor',
    // `patience` REMOVED: it is a disposition, it already drives the frustration
    // layer, and here it made two personas with no motor traits differ 5.6x in
    // motor cost. proceduralFluency stays -- multi-step flow execution is a real
    // motor-adjacent capacity -- alongside the Fitts throughput bridge.
    traits: ['proceduralFluency', 'motorCapacity'],
  },
  {
    name: 'frustration',
    traits: ['resilience', 'selfEfficacy', 'patience', 'emotionalContagion'],
  },
  {
    name: 'readability',
    // DECODING ONLY, as of 2026-08-02 (D-3 Option 1). This layer answers one
    // question -- how expensive is it for this person to turn these glyphs into
    // words -- and it is the layer `legibilityQuality` makes a promise about:
    // lower legibility for someone means higher readability cost for them.
    //
    // Everything else that was here has been moved out, and the history is why
    // it had to be:
    //
    //   R1  adhd 0.401 / dyslexic 0.189   inverted   (disposition drove it)
    //   R2  adhd 0.112 / dyslexic 0.142   correct    (attentional term removed)
    //   R4  adhd 0.161 / dyslexic 0.126   inverted   (attentional term restored)
    //
    // Removing the attentional term fixed the ordering and deleted ADHD reading
    // cost. Restoring it recovered ADHD reading cost and broke the ordering.
    // BOTH were correct fixes. The layer was carrying two mechanisms through
    // one scalar under a contract that only describes one of them, and no
    // weighting satisfies both -- an ADHD attentionSpan of 0.30 against a
    // dyslexic 0.50 swamps five decoding terms pointing the other way.
    //
    // So the second mechanism gets its own layer rather than a smaller weight.
    // `sustainedAttention` moved to `readingAttention` below.
    // `comprehension` moved out entirely: it is "grasp of UI conventions", not
    // decoding, and it already drives cognitiveLoad -- keeping it here made the
    // contract non-monotonic for personas whose comprehension and decoding
    // disagree, which after the reading-capacity schema change is most of them.
    // `transferLearning` moved to cognitiveLoad: applying a pattern learned on
    // one interface to another is not reading. It is not orphaned by the move.
    traits: ['readingCapacity'],
  },
  {
    name: 'readingAttention',
    // The attentional half of reading, split out of `readability` so both are
    // separately attributable rather than summed into one number that can only
    // be right about one of them.
    //
    // This is the layer an ADHD reader's cost lands in: decoding intact, loses
    // place, re-reads, pulled off the line by movement in the periphery. It is
    // NOT frustration -- losing your place is a processing cost, not an
    // emotional response to one, and routing it through frustration would point
    // remediation at reassurance instead of at chunking, shorter blocks and
    // fewer moving distractors.
    //
    // Appended as layer 7 rather than inserted before readability, deliberately:
    // layers spend from a budget the earlier ones depleted, so inserting would
    // have changed readability's numbers through depletion as well as through
    // its trait list, and the two effects could not be told apart.
    traits: ['sustainedAttention'],
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

/**
 * Dimensions where having MORE than the page asks for costs nothing at all.
 *
 * Surplus is cheap rather than free for most traits, which is defensible: a
 * maximiser on a trivial page really does spend effort the page did not need.
 * It is not defensible for site knowledge. Knowing a site better cannot make it
 * harder to use, and because familiarity is a parameter the caller sets
 * explicitly, the wrongness is directly visible rather than buried.
 *
 * Measured on cbrowser.ai, a shallow site, right after wiring the demand term:
 * familiarity 0 gave total 0.19 and familiarity 1 gave 0.268 — the daily user
 * charged more than the first-time visitor, because low navigation depth means
 * low demand and a familiarity of 1.0 is then almost entirely surplus. An
 * inverted knob is worse than an inert one: it produces a confident number
 * pointing the wrong way. (2026-08-02)
 *
 * `sustainedAttention` joins it on the same argument: being able to concentrate
 * harder than a page requires cannot make that page harder to read. Billed as
 * surplus it charged `power-user` 0.027 of readability cost on a text-dense
 * page for having an attention capacity of 0.85 against a demand of 0.50 --
 * i.e. a penalty for concentrating well. Free, it charges nothing.
 *
 * `readingCapacity` joined them on 2026-08-02, and unlike the other two it is
 * REQUIRED rather than merely defensible. `readability` is now decoding-only
 * and carries a stated contract -- lower `legibilityQuality` for someone means
 * higher readability cost for them. Both quantities derive from the same
 * reading profile, so the contract is monotonic exactly as long as cost falls
 * monotonically in capacity. Billed surplus breaks that at the top: above the
 * page's demand, cost starts RISING again at 0.3 per unit, so the strongest
 * readers re-enter the cost curve from the other side and a graph of
 * legibility against cost turns back on itself.
 *
 * This was deferred one commit earlier as "a calibration decision on numbers
 * customers have already seen". Splitting the layer removed the choice: a
 * contract the tool prints in its own output has to hold.
 */
const SURPLUS_FREE_DIMENSIONS = new Set(['siteFamiliarity', 'sustainedAttention', 'readingCapacity']);

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

  // ── visualComplexity → changeBlindness, mentalModelFlexibility, attentionPattern (inferred)
  const visDemand = visCplx; // already 0-1 from logScale
  demands.changeBlindness = Math.max(demands.changeBlindness, visDemand);
  demands.mentalModelFlexibility = Math.max(demands.mentalModelFlexibility, visDemand * 0.7);
  demands.attentionPattern = Math.max(demands.attentionPattern, visDemand * 0.85);
  variance.changeBlindness += visCplx * 0.12;
  variance.mentalModelFlexibility += visCplx * 0.08;
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

  // ── Text Readability Metrics (v18.56) ──
  // These measure HOW HARD the text is to read, not just how much there is.
  // Captures language effects (German compound words), technical jargon, prose complexity.
  const avgWordLen = safe((pageMetrics as any).avgWordLength);
  const avgSentLen = safe((pageMetrics as any).avgSentenceLength);
  const lexDiv = safe((pageMetrics as any).lexicalDiversity);
  const longWordR = safe((pageMetrics as any).longWordRatio);
  const techDens = safe((pageMetrics as any).technicalDensity);

  if (avgWordLen > 0 || avgSentLen > 0) {
    // avgWordLength → comprehension, readingTendency
    // Longer words = harder to parse (especially for dyslexic, ADHD, non-native speakers)
    demands.comprehension = Math.max(demands.comprehension, avgWordLen * 0.9);
    demands.readingTendency = Math.max(demands.readingTendency, avgWordLen * 0.85);
    variance.comprehension += avgWordLen * 0.12;
    variance.readingTendency += avgWordLen * 0.1;

    // avgSentenceLength → workingMemory, patience, comprehension
    // Longer sentences demand more working memory to hold clause structure
    demands.workingMemory = Math.max(demands.workingMemory, avgSentLen * 0.85);
    demands.patience = Math.max(demands.patience, avgSentLen * 0.7);
    demands.comprehension = Math.max(demands.comprehension, avgSentLen * 0.8);
    variance.workingMemory += avgSentLen * 0.1;
    variance.patience += avgSentLen * 0.07;

    // lexicalDiversity → comprehension, transferLearning
    // High vocabulary diversity = more cognitive effort to track meaning
    demands.comprehension = Math.max(demands.comprehension, lexDiv * 0.75);
    demands.transferLearning = Math.max(demands.transferLearning, lexDiv * 0.65);
    variance.comprehension += lexDiv * 0.08;

    // longWordRatio → readingTendency, comprehension
    // Pages with many 7+ character words are harder to skim
    demands.readingTendency = Math.max(demands.readingTendency, longWordR * 0.9);
    demands.comprehension = Math.max(demands.comprehension, longWordR * 0.8);
    variance.readingTendency += longWordR * 0.11;

    // technicalDensity → comprehension, transferLearning, mentalModelFlexibility
    // 10+ character words signal compound terms, jargon, domain-specific vocabulary
    demands.comprehension = Math.max(demands.comprehension, techDens * 0.95);
    demands.transferLearning = Math.max(demands.transferLearning, techDens * 0.8);
    demands.mentalModelFlexibility = Math.max(demands.mentalModelFlexibility, techDens * 0.7);
    variance.comprehension += techDens * 0.13;
    variance.transferLearning += techDens * 0.09;
    variance.mentalModelFlexibility += techDens * 0.07;
  }

  // ── animationLevel → changeBlindness, interruptRecovery, emotionalContagion
  const animDemand = sigmoid(animLevel, 0.3, 0.15);
  demands.changeBlindness = Math.max(demands.changeBlindness, animDemand * 0.9);
  demands.interruptRecovery = Math.max(demands.interruptRecovery, animDemand * 0.85);
  demands.emotionalContagion = Math.max(demands.emotionalContagion, animDemand * 0.7);
  variance.changeBlindness += animLevel * 0.1;
  variance.interruptRecovery += animLevel * 0.09;
  variance.emotionalContagion += animLevel * 0.07;

  // ── textDensity × distractor pressure → sustainedAttention
  //
  // How much attention the page asks you to HOLD, as opposed to how hard its
  // words are to decode (readingCapacity) or how much of it you choose to read
  // (readingTendency, which modulates demand below). Gated on text: a page with
  // no prose asks nothing here, however busy it is, because there is no line to
  // lose your place in.
  //
  // Multiplicative rather than this file's usual `max`, deliberately -- the
  // interaction IS the mechanism. A long article with nothing moving on it is
  // readable; the same article beside an autoplaying carousel is where the
  // re-reading happens. Two `max` terms would score those two pages the same.
  //
  // Animation dominates the distractor term because moving peripheral content
  // captures attention involuntarily, while static clutter merely competes for
  // it (Yantis & Jonides 1990 on abrupt-onset capture).
  //
  // The 0.7 base sits deliberately BELOW readingCapacity's 0.9: on a page with
  // nothing moving, decoding is the larger demand of text and attention is the
  // secondary one. The distractor multiplier is what lets it overtake decoding,
  // and only on a page that has earned it. Without that ordering this dimension
  // re-creates the exact inversion that removing readingTendency fixed --
  // measured: at a flat 1.0 base, ADHD outscored dyslexic on readability on a
  // page with animationLevel 0, which is the wrong answer.
  const distractorPressure = Math.min(1, animDemand * 0.7 + visDemand * 0.3);
  const sustainDemand = Math.min(1, textDemand * 0.7 * (1 + distractorPressure * 0.7));
  demands.sustainedAttention = Math.max(demands.sustainedAttention, sustainDemand);
  variance.sustainedAttention += textDens * 0.1 + animLevel * 0.08;

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
  // ── navigationDepth → siteFamiliarity
  //
  // This dimension had NO demand term at all. It was initialised to 0 and never
  // raised, so the persona's familiarity was transported against zero demand and
  // contributed exactly nothing to the chain — three runs at familiarity unset,
  // 1 and 0 returned byte-identical results while the tool reported the
  // parameter as applied. The value was never overridden; nothing ever asked
  // for it.
  //
  // Navigation depth is the honest driver: the further content sits from the
  // entry point, the more the page asks you to already know where things are.
  // A one-click page demands no site knowledge no matter who you are, which is
  // why this is proportional to navDemand rather than a constant. Weighted just
  // under workingMemory (0.95), since knowing the layout substitutes for
  // holding it in mind. (2026-08-02)
  demands.siteFamiliarity = Math.max(demands.siteFamiliarity, navDemand * 0.85);
  // Reading capacity is demanded by how much text there is to decode, and motor
  // capacity by how many things there are to hit. Both proportional, so a page
  // with no text asks nothing of decoding and a page with no controls asks
  // nothing of pointing.
  demands.readingCapacity = Math.max(demands.readingCapacity, Math.max(textDens, infoDensity) * 0.9);
  demands.motorCapacity = Math.max(demands.motorCapacity, interDemand * 0.9);
  variance.readingCapacity += textDens * 0.08;
  variance.motorCapacity += interDemand * 0.08;
  variance.siteFamiliarity += Math.min(1, navDepth / 5) * 0.08;
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
function traitValue(traits: Record<string, number | string>, trait: string): number {
  const v = traits?.[trait];
  // Handle string enum traits (e.g. attentionPattern: "targeted" | "f-pattern" | ...)
  if (typeof v === 'string') {
    const STRING_TRAIT_MAP: Record<string, number> = {
      'targeted': 0.9,
      'sequential': 0.8,
      'f-pattern': 0.7,
      'z-pattern': 0.6,
      'exploratory': 0.3,
    };
    return STRING_TRAIT_MAP[v] ?? 0.5;
  }
  if (typeof v === 'number' && !isNaN(v)) return Math.max(0, Math.min(1, v));
  return 0.5;
}

/**
 * Schwartz Value → Trait Demand Modulation Coefficients
 *
 * Each entry maps a Schwartz value to the cognitive traits it amplifies or
 * dampens in the demand distribution. The coefficient represents how much
 * a high value score (1.0) amplifies (+) or dampens (-) the demand on that trait.
 *
 * Theoretical basis:
 * - Security-driven personas demand MORE trustCalibration (Fogg 2003)
 * - Achievement-driven personas demand LESS satisficing (Simon 1956 — they optimize)
 * - Conformity-driven personas amplify socialProof demands (Cialdini 2001)
 * - Stimulation-driven personas amplify curiosity but deplete patience faster
 *
 * @see Schwartz (1992) "Universals in the content and structure of values"
 * @see Section 4.2 of "Cognitive Optimal Transport: A Unified Framework"
 * @since v18.54.0
 */
const VALUE_DEMAND_MODULATION: Array<{
  value: string;
  trait: string;
  coefficient: number; // positive = amplifies demand, negative = dampens
  layer: string;       // which layer this modulation applies to
}> = [
  // ── Saliency Layer Modulations ──
  // Stimulation → reduces changeBlindness threshold (novelty-seekers notice changes more)
  { value: 'stimulation', trait: 'changeBlindness', coefficient: -0.20, layer: 'saliency' },
  // Stimulation → amplifies attentionPattern demand (drawn to novel visual elements)
  { value: 'stimulation', trait: 'attentionPattern', coefficient: 0.20, layer: 'saliency' },
  // Security → amplifies changeBlindness demand (vigilant scanners notice more changes)
  { value: 'security', trait: 'changeBlindness', coefficient: -0.15, layer: 'saliency' },
  // Conformity → dampens attentionPattern (follows expected scan patterns, less exploratory)
  { value: 'conformity', trait: 'attentionPattern', coefficient: -0.15, layer: 'saliency' },

  // ── Frustration Layer ──
  // Security → amplifies trust demand (Fogg 2003: high-security users need more trust signals)
  { value: 'security', trait: 'trustCalibration', coefficient: 0.25, layer: 'frustration' },

  // Achievement → reduces satisficing demand (optimizers don't settle for "good enough")
  { value: 'achievement', trait: 'satisficing', coefficient: -0.20, layer: 'decision' },
  // Achievement → increases riskTolerance capacity (confident decision-makers)
  { value: 'achievement', trait: 'riskTolerance', coefficient: -0.15, layer: 'decision' },

  // Conformity → amplifies social proof demand (Cialdini 2001: need validation from others)
  { value: 'conformity', trait: 'socialProofSensitivity', coefficient: 0.30, layer: 'decision' },
  // Conformity → amplifies anchoring (defer to first/default option)
  { value: 'conformity', trait: 'anchoringBias', coefficient: 0.20, layer: 'decision' },

  // Stimulation → amplifies curiosity demand (explore more, bored faster)
  { value: 'stimulation', trait: 'curiosity', coefficient: 0.25, layer: 'cognitiveLoad' },
  // Stimulation → depletes patience (novelty-seekers abandon monotonous pages)
  { value: 'stimulation', trait: 'patience', coefficient: 0.20, layer: 'motor' },

  // Self-Direction → reduces conformity-related demand (independent thinkers)
  { value: 'selfDirection', trait: 'socialProofSensitivity', coefficient: -0.20, layer: 'decision' },
  // Self-Direction → amplifies metacognitive planning (plan their own path)
  { value: 'selfDirection', trait: 'metacognitivePlanning', coefficient: -0.15, layer: 'cognitiveLoad' },

  // Tradition → amplifies mentalModelFlexibility (resist new UI patterns)
  { value: 'tradition', trait: 'mentalModelFlexibility', coefficient: 0.25, layer: 'cognitiveLoad' },

  // Benevolence → reduces emotionalContagion cost (emotionally regulated)
  { value: 'benevolence', trait: 'emotionalContagion', coefficient: -0.15, layer: 'frustration' },

  // Power → reduces fear of missing out (confident, not swayed by urgency)
  { value: 'power', trait: 'fearOfMissingOut', coefficient: -0.20, layer: 'decision' },

  // Universalism → amplifies readingTendency (reads everything, values completeness)
  { value: 'universalism', trait: 'readingTendency', coefficient: 0.15, layer: 'readability' },
];

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
 * 1. Applies Schwartz value modulation to demand (v18.54.0)
 * 2. Computes asymmetric transport cost (deficit is expensive, surplus is cheap)
 * 3. Depletes residual capacity proportional to cost incurred
 * 4. Records the remaining capacity for downstream layers
 *
 * @param persona - OTCognitiveProfile with trait values
 * @param demand - 26D demand distribution from page analysis
 * @param options - Enable/disable asymmetric costs, interaction terms, and value modulation
 * @returns Complete sequential transport result with per-layer breakdown
 */
export function computeSequentialCTC(
  persona: OTCognitiveProfile,
  demand: DemandDistribution,
  options?: { asymmetric?: boolean; interactions?: boolean; schwartzValues?: Record<string, number> },
): SequentialTransportResult {
  const useAsymmetric = options?.asymmetric !== false; // default true
  const useInteractions = options?.interactions !== false; // default true
  const values = options?.schwartzValues;

  // Apply Schwartz value modulation to demand distribution (v18.54.0)
  // Values amplify or dampen demands on specific traits, changing what the page "asks" of the user
  const modulatedDemand: DemandDistribution = {
    demands: { ...demand.demands },
    variance: { ...demand.variance },
  };

  // readingTendency modulates DEMAND, not capacity.
  //
  // It was in the readability layer as a capacity and inverted it: an ADHD
  // persona who skims (0.2) scored a large capacity deficit against text
  // demand, so a text-dense page cost them MORE than a dyslexic reader at 0.4,
  // while the same run reported the dyslexic reader at 157 WPM against 204.
  //
  // The trait is not an ability, it is a STRATEGY -- its own criteria are
  // "skims, reads carefully, scans for buttons" -- and skimming is how someone
  // spends less effort on text, not evidence they cannot decode it. On the
  // demand side that reads correctly: a skimmer engages less of the page's text,
  // a careful reader engages more.
  //
  // Bounded to +/-25% around neutral, for two reasons. A skimmer still has to
  // find the content, so demand cannot fall toward zero. And an unbounded
  // modulator would recreate the very inversion this fixes by letting strategy
  // outweigh decoding ability -- verified it does not: dyslexic still costs more
  // than ADHD on a text-dense page after this. (2026-08-02)
  const readingTendency = persona.traits?.readingTendency;
  if (typeof readingTendency === "number") {
    const engagement = 0.75 + readingTendency * 0.5; // 0.75 at pure skim, 1.25 at careful
    // ATTENTIONAL demand only. Applied to `readingCapacity` as well for one
    // commit, and that was wrong on the merits as well as breaking a contract.
    //
    // Engagement is how much of the page you read. That scales how long you
    // must hold the line -- genuinely an attentional quantity -- but it does
    // not change how hard the words you do read are to decode. Skimming reduces
    // exposure, not difficulty.
    //
    // It also made decoding demand persona-specific, which silently voided the
    // `legibilityQuality` contract the readability layer prints in its own
    // output: measured, `distracted-user` at legibility 0.619 paid 0.000 while
    // `careful-reader` at 0.724 paid 0.016 -- lower legibility, lower cost --
    // purely because the skimmer's demand had been scaled down. A contract
    // stated cross-persona has to be computed against a demand that does not
    // vary by persona. (2026-08-02)
    if (modulatedDemand.demands.sustainedAttention) {
      modulatedDemand.demands.sustainedAttention = Math.max(0, Math.min(1,
        modulatedDemand.demands.sustainedAttention * engagement));
    }
  }

  if (values && Object.keys(values).length > 0) {
    for (const mod of VALUE_DEMAND_MODULATION) {
      const valueScore = values[mod.value];
      if (valueScore === undefined || valueScore === null) continue;

      const currentDemand = modulatedDemand.demands[mod.trait] ?? 0;
      // Modulation: demand += coefficient * valueScore * currentDemand
      // High value score amplifies the modulation effect
      // Multiplicative on current demand — no effect on zero-demand traits
      const modulation = mod.coefficient * valueScore * Math.max(0.1, currentDemand);
      modulatedDemand.demands[mod.trait] = Math.max(0, Math.min(1, currentDemand + modulation));
    }
  }

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

    // Compute transport cost for this layer's traits (using modulated demands)
    for (const trait of layerDef.traits) {
      const d = modulatedDemand.demands[trait] ?? 0;
      const c = residualCapacity[trait] ?? 0.5;
      const gap = d - c;

      let cost: number;
      if (gap > 0) {
        // Deficit: demand exceeds capacity — expensive
        cost = (useAsymmetric ? WEIGHT_DEFICIT : 1.0) * gap * gap;
        layerDeficit += cost;
      } else {
        // Surplus: capacity exceeds demand — cheap
        const surplusWeight = SURPLUS_FREE_DIMENSIONS.has(trait) ? 0 : WEIGHT_SURPLUS;
        cost = (useAsymmetric ? surplusWeight : 1.0) * gap * gap;
        layerSurplus += cost;
      }

      layerCost += cost;
      traitCosts[trait] = (traitCosts[trait] ?? 0) + cost;
    }

    // Scale layer cost by demand presence — empty pages shouldn't produce high costs
    const layerDemandMagnitude = layerDef.traits.reduce(
      (sum, t) => sum + (modulatedDemand.demands[t] ?? 0), 0
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
  const rawCTC = layers.reduce((sum, l) => sum + l.transportCost, 0) + interactionTotal;

  // Normalize CTC to a 0-1 scale that maps to human-interpretable difficulty
  // Calibration: raw CTC from the W₂ formula tends to be 0.3-3.0 for real pages.
  // We normalize using a sigmoid so: 0.5 raw → 0.2, 1.0 → 0.4, 2.0 → 0.7, 3.0 → 0.9
  // This ensures "easy" pages (simple layout, clear content) land below 0.3
  const totalCTC = 1 / (1 + Math.exp(-2.5 * (rawCTC - 1.2)));

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
  // Based on deficit relative to patience capacity
  // deficit < 0.5 → risk < 30%, deficit ≈ patience → risk ≈ 50%, deficit >> patience → risk → 100%
  const patienceCapacity = traitValue(persona.traits, 'patience');
  const resilienceCapacity = traitValue(persona.traits, 'resilience');
  const effectivePatience = patienceCapacity * 0.7 + resilienceCapacity * 0.3; // blended tolerance
  const adjustedCost = totalDeficit - totalSurplus * 0.3; // surplus comfort (30%)
  const riskInput = Math.max(0, adjustedCost) - effectivePatience * 1.5; // center at 1.5x patience
  const abandonmentRisk = Math.max(0, Math.min(1,
    1 / (1 + Math.exp(-riskInput / 0.6)) // wider sigmoid scale
  ));

  return {
    totalCTC,
    // The un-normalized cost, exposed because totalCTC is a SIGMOID of it and
    // the two are not interchangeable. Every ratio against additiveCTC has to
    // use this one: additiveCTC is a raw sum, totalCTC is squashed to 0-1, and
    // dividing one by the other compares different units. (2026-08-02)
    rawCTC,
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
 * Returns rawCTC / additiveCTC -- both in layer-cost units.
 *
 * NAMED FOR WHAT IT DOES, NOT WHAT IT WAS EXPECTED TO DO. The old name,
 * `sequentialAmplification`, promised a value above 1.0 — depletion and
 * interactions pushing total cost past what independent layers would predict.
 * Measured across five real runs it was 0.30, 0.31 and 0.39: the chain
 * ATTENUATES the additive sum by 61-70%, and has never been observed above 1.
 *
 * The transform is saturating rather than corrupting: the coefficient rises
 * monotonically with the additive sum (0.30 -> 0.31 -> 0.39), so rank ordering
 * across personas and pages is preserved and comparative claims built on CTC
 * hold. What does not hold is any reading of an ABSOLUTE cost, which carries an
 * undocumented compression of roughly 3x.
 *
 * "Amplification" for a term that only ever shrinks actively misleads anyone
 * reading the JSON without the source, which is most readers. (2026-08-02)
 */
export function chainCoefficient(result: SequentialTransportResult): number {
  if (result.additiveCTC === 0) return 1.0;
  // rawCTC, NOT totalCTC. Both are in layer-cost units, so their ratio is the
  // actual contribution of interactions and sequential depletion. Measured
  // 1.002-1.019 across page densities: the chain does amplify, by 0.2-2%.
  //
  // The old form divided totalCTC (a sigmoid, 0-1) by additiveCTC (a raw,
  // unbounded sum) and reported 0.30-0.56 as if the chain were dampening by
  // 60%. It was not measuring the chain at all, it was measuring the sigmoid --
  // and it was not even monotonic across density (0.329, 0.399, 0.556, 0.313,
  // 0.425), so it could not be used for ranking either.
  return result.rawCTC / result.additiveCTC;
}

/** @deprecated Misleading name — it has never exceeded 1. Use `chainCoefficient`. */
export const sequentialAmplification = chainCoefficient;

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
