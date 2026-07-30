/**
 * Attention Transport — Saliency modeling via optimal transport
 *
 * Generates persona-specific saliency maps showing WHERE each persona's
 * attention goes on a page, using W₂ distance on CIE-Lab color distributions
 * for center-surround contrast detection.
 *
 * Based on:
 * - Klein & Frintrop (DAGM 2012): W₂ saliency on multivariate normals
 * - Bylinskii et al. (IEEE TPAMI 2019): EMD for saliency evaluation
 * - Mialon et al. (ICLR 2021): attention as optimal transport plan
 * - Sun & Li (JEI 2018): multi-scale aggregated Wasserstein saliency
 *
 * The transport plan between persona's attention prior and page's
 * saliency map reveals WHERE attention flows — richer than saliency
 * alone because it shows the mapping, not just the destination.
 *
 * @version 1.0.0
 * @since v18.28.0
 * @see https://github.com/alexandriashai/cbrowser/issues/159
 */

import { getPerceptualProfile, type PerceptualFilter } from './perceptual-transport.js';

// ── Types ──

export interface SaliencyMap {
  /**
   * Which model produced `cells`.
   *
   * "visual+semantic" — 35% centre-surround CIE-Lab saliency blended with 65%
   * DOM-semantic attention (element type x persona priority).
   * "visual-only" — the bottom-up layer alone: local colour-contrast pop-out.
   * Useful, but NOT a model of where a person looks. The fallback was silent
   * until 2026-07-29 and two of three production callers take it.
   */
  attentionModel?: "visual+semantic" | "visual-only";
  /** Saliency values per grid cell (0-1, higher = more salient) */
  cells: Float64Array;
  /** Grid dimensions */
  rows: number;
  cols: number;
  /** Image dimensions */
  width: number;
  height: number;
  /** Cell size in pixels */
  cellSize: number;
  /** Top N most salient regions */
  hotspots: Array<{
    row: number;
    col: number;
    x: number;
    y: number;
    saliency: number;
  }>;
}

export interface AttentionAnalysis {
  /** Persona name */
  persona: string;
  /** Persona-specific saliency map */
  saliencyMap: SaliencyMap;
  /** Attention alignment: how well persona's attention matches the page's intended hierarchy */
  alignmentScore: number;
  /** Attention entropy: how dispersed the persona's attention is (0=focused, 1=scattered) */
  entropy: number;
  /** Attention concentration: what fraction of attention goes to top 20% of regions */
  concentration: number;
  /** Top elements competing for attention */
  attentionCompetitors: Array<{ region: string; saliency: number }>;
  /** Transport cost from persona's attention prior to actual saliency */
  transportCost: number;
  computeTimeMs: number;
}

export interface AttentionComparisonResult {
  /** Persona A's attention analysis */
  personaA: AttentionAnalysis;
  /** Persona B's attention analysis */
  personaB: AttentionAnalysis;
  /** Wasserstein distance between the two saliency maps */
  attentionDivergence: number;
  /** Regions where attention differs most */
  divergentRegions: Array<{
    row: number;
    col: number;
    x: number;
    y: number;
    saliencyA: number;
    saliencyB: number;
    divergence: number;
  }>;
}

// ── CIE-Lab Color Space Conversion ──

function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  // sRGB to linear
  const toLinear = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const rl = toLinear(r), gl = toLinear(g), bl = toLinear(b);

  // Linear RGB to XYZ (D65)
  const x = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl;
  const z = 0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl;

  // XYZ to Lab (D65 reference)
  const xn = 0.95047, yn = 1.0, zn = 1.08883;
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(x / xn), fy = f(y / yn), fz = f(z / zn);

  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bLab = 200 * (fy - fz);

  return [L, a, bLab];
}

// ── Core: Center-Surround Saliency via W₂ ──

/**
 * Compute saliency map using Wasserstein-2 distance on CIE-Lab distributions.
 *
 * For each grid cell, computes the mean and variance of the Lab color distribution.
 * Saliency = W₂ distance between the cell's distribution and its surround's
 * distribution (center-surround contrast, Klein & Frintrop method).
 *
 * For Gaussian measures, W₂ has a closed-form solution:
 * BW²(N(μ₁,σ₁²), N(μ₂,σ₂²)) = ||μ₁-μ₂||² + (σ₁-σ₂)²
 */
/**
 * Exported so calibration work can obtain the PRE-filter saliency once per
 * image and then sweep persona parameters over it cheaply. Recomputing the
 * Lab pass for every parameter combination would make a grid search
 * impractical, and re-deriving it in a separate script is how the Study 1
 * Python port drifted from shipped code. (2026-07-29)
 */
export async function computeLabSaliency(
  imagePath: string,
  cellSize: number = 16,
  surroundRadius: number = 3,
): Promise<{ cells: Float64Array; rows: number; cols: number; width: number; height: number }> {
  const sharpModule: any = await import('sharp');
  const sharp = sharpModule.default ?? sharpModule;

  // Load and downscale
  const scale = 0.5;
  const img = sharp(imagePath);
  const metadata = await img.metadata();
  const width = Math.round((metadata.width || 800) * scale);
  const height = Math.round((metadata.height || 600) * scale);

  const { data } = await img
    .resize(width, height)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  const rows = Math.ceil(height / cellSize);
  const cols = Math.ceil(width / cellSize);
  const numCells = rows * cols;

  // Compute per-cell Lab statistics (mean L, a, b and variance)
  const cellStats: Array<{ meanL: number; meanA: number; meanB: number; varL: number; varA: number; varB: number; count: number }> = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let sumL = 0, sumA = 0, sumB = 0;
      let sumL2 = 0, sumA2 = 0, sumB2 = 0;
      let count = 0;

      const yStart = row * cellSize;
      const xStart = col * cellSize;
      const yEnd = Math.min(yStart + cellSize, height);
      const xEnd = Math.min(xStart + cellSize, width);

      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          const idx = (y * width + x) * 4;
          if (pixels[idx + 3] < 25) continue; // Skip transparent

          const [L, a, b] = srgbToLab(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
          sumL += L; sumA += a; sumB += b;
          sumL2 += L * L; sumA2 += a * a; sumB2 += b * b;
          count++;
        }
      }

      if (count > 0) {
        const mL = sumL / count, mA = sumA / count, mB = sumB / count;
        cellStats.push({
          meanL: mL, meanA: mA, meanB: mB,
          varL: Math.max(0.01, sumL2 / count - mL * mL),
          varA: Math.max(0.01, sumA2 / count - mA * mA),
          varB: Math.max(0.01, sumB2 / count - mB * mB),
          count,
        });
      } else {
        cellStats.push({ meanL: 0, meanA: 0, meanB: 0, varL: 0.01, varA: 0.01, varB: 0.01, count: 0 });
      }
    }
  }

  // Compute center-surround W₂ saliency for each cell
  const saliency = new Float64Array(numCells);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const center = cellStats[idx];
      if (center.count === 0) continue;

      // Compute surround statistics (average of surrounding cells)
      let sCount = 0;
      let sMeanL = 0, sMeanA = 0, sMeanB = 0;
      let sVarL = 0, sVarA = 0, sVarB = 0;

      for (let dr = -surroundRadius; dr <= surroundRadius; dr++) {
        for (let dc = -surroundRadius; dc <= surroundRadius; dc++) {
          if (dr === 0 && dc === 0) continue; // Skip center
          const sr = row + dr, sc = col + dc;
          if (sr < 0 || sr >= rows || sc < 0 || sc >= cols) continue;
          const si = sr * cols + sc;
          const s = cellStats[si];
          if (s.count === 0) continue;

          sMeanL += s.meanL; sMeanA += s.meanA; sMeanB += s.meanB;
          sVarL += s.varL; sVarA += s.varA; sVarB += s.varB;
          sCount++;
        }
      }

      if (sCount === 0) continue;
      sMeanL /= sCount; sMeanA /= sCount; sMeanB /= sCount;
      sVarL /= sCount; sVarA /= sCount; sVarB /= sCount;

      // Bures-Wasserstein distance for 3D Gaussians (diagonal covariance)
      // BW² = w_L||ΔL||² + w_a||Δa||² + w_b||Δb||² + variance terms
      //
      // Chrominance boost: a/b channels weighted 3x relative to L.
      // This captures the preattentive "pop-out effect" where a uniquely-colored
      // item captures attention even when its luminance is similar to surroundings.
      // Without this, teal text on white scores LOWER than black text on white
      // because teal has less luminance contrast — the opposite of perceptual reality.
      const wL = 1.0;  // luminance weight
      const wA = 3.0;  // chrominance a* weight (red-green axis)
      const wB = 3.0;  // chrominance b* weight (blue-yellow axis)

      const meanDist = wL * (center.meanL - sMeanL) ** 2 +
                       wA * (center.meanA - sMeanA) ** 2 +
                       wB * (center.meanB - sMeanB) ** 2;
      const varDist = wL * (Math.sqrt(center.varL) - Math.sqrt(sVarL)) ** 2 +
                      wA * (Math.sqrt(center.varA) - Math.sqrt(sVarA)) ** 2 +
                      wB * (Math.sqrt(center.varB) - Math.sqrt(sVarB)) ** 2;

      saliency[idx] = Math.sqrt(meanDist + varDist);
    }
  }

  // Normalize to 0-1
  const maxSal = Math.max(...Array.from(saliency), 0.001);
  for (let i = 0; i < numCells; i++) saliency[i] /= maxSal;

  return { cells: saliency, rows, cols, width: width / scale, height: height / scale };
}

// ── Persona-Filtered Saliency (v18.54.0: value-driven attention) ──

/**
 * Schwartz value → saliency modulation parameters.
 *
 * Values don't just change how you process — they change WHERE you look.
 * Research basis:
 * - Motivated attention (Pessoa 2009): emotional/motivational state biases visual attention
 * - Value-driven attentional capture (Anderson 2013): reward-associated stimuli capture attention
 * - Need states alter perception (Balcetis & Dunning 2006): what you value changes what you see
 *
 * Each value modulates the saliency power curve:
 * filtered[i] = saliency[i]^exponent × (1 + bias)
 *
 * High exponent → concentrated attention (only strongest signals register)
 * Low exponent → dispersed attention (more things capture attention)
 * Positive bias → global boost (vigilant, scanning everything)
 * Negative bias → selective suppression (focused, ignoring distractors)
 */
interface ValueAttentionParams {
  /** Saliency power exponent: <1 = dispersed (notices more), >1 = concentrated (fewer things) */
  exponent: number;
  /** Global saliency bias: +boost/-suppress */
  bias: number;
  /** Center-bias strength: 0 = none, 1 = strong center focus */
  centerBias: number;
  /** Threshold floor: below this, saliency is suppressed */
  threshold: number;
}

function computeValueAttentionParams(
  filter: PerceptualFilter,
  schwartzValues?: Record<string, number>,
): ValueAttentionParams {
  // Start with the base attention mode
  let exponent = 1.0;
  let bias = 0.0;
  let centerBias = 0.0;
  let threshold = 0.0;

  // Apply categorical attention mode (legacy — still used for accessibility personas)
  switch (filter.attentionMode) {
    case 'center-heavy':
      centerBias = 0.7;
      break;
    case 'motion-attracted':
      exponent = 0.5; // square root = more things register
      break;
    case 'text-focused':
      threshold = 0.2; // suppress low-saliency distractors
      bias = -0.1;     // slightly suppress overall
      break;
    case 'large-elements':
      threshold = 0.3;
      break;
  }

  // Apply value-driven modulation (v18.54.0)
  if (schwartzValues) {
    const v = (key: string) => schwartzValues[key] ?? 0.5;

    // Stimulation: high → dispersed attention (notices novelty everywhere)
    // Anderson (2013): reward-seeking broadens attentional spotlight
    exponent -= (v('stimulation') - 0.5) * 0.4; // 0.9 stim → exponent -0.16

    // Security: high → vigilant scanning (boost everything slightly, lower threshold)
    // Pessoa (2009): threat-sensitive individuals show broadened attention
    bias += (v('security') - 0.5) * 0.15;
    threshold -= (v('security') - 0.5) * 0.1;

    // Achievement: high → focused on high-value targets (increase exponent)
    // Concentrate attention on the most salient elements, ignore distractors
    exponent += (v('achievement') - 0.5) * 0.3;

    // Conformity: high → center-biased (follows expected layout patterns)
    // F-pattern and Z-pattern readers look where convention says to look
    centerBias += (v('conformity') - 0.5) * 0.3;

    // Self-direction: high → less center-biased (explores periphery)
    centerBias -= (v('selfDirection') - 0.5) * 0.2;

    // Tradition: high → suppresses novel elements (sticks to familiar patterns)
    threshold += (v('tradition') - 0.5) * 0.1;
  }

  // Clamp values to sane ranges
  exponent = Math.max(0.3, Math.min(2.0, exponent));
  bias = Math.max(-0.3, Math.min(0.3, bias));
  centerBias = Math.max(0, Math.min(1.0, centerBias));
  threshold = Math.max(0, Math.min(0.5, threshold));

  return { exponent, bias, centerBias, threshold };
}

/**
 * Apply persona's perceptual filter + value-driven attention modulation.
 *
 * The saliency map is modified by both the persona's physical perceptual
 * constraints (attention mode) and their motivational values (what they
 * care about changes what they notice).
 */
function applyPersonaFilter(
  saliency: Float64Array,
  rows: number,
  cols: number,
  filter: PerceptualFilter,
  schwartzValues?: Record<string, number>,
): Float64Array {
  const params = computeValueAttentionParams(filter, schwartzValues);
  const filtered = new Float64Array(saliency.length);

  const centerRow = rows / 2;
  const centerCol = cols / 2;
  const maxDist = Math.sqrt(centerRow ** 2 + centerCol ** 2);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      let s = saliency[idx];

      // Apply threshold floor
      if (s < params.threshold) {
        s *= 0.2;
      }

      // Apply power curve (exponent controls attention concentration)
      s = Math.pow(Math.max(0, s), params.exponent);

      // Apply center bias
      if (params.centerBias > 0) {
        const dist = Math.sqrt((r - centerRow) ** 2 + (c - centerCol) ** 2) / maxDist;
        s *= 1 - dist * params.centerBias;
      }

      // Apply global bias
      s *= (1 + params.bias);

      filtered[idx] = Math.max(0, s);
    }
  }

  // Apply processing speed
  if (filter.processingSpeed < 0.8) {
    const speedThreshold = 0.3 + (1 - filter.processingSpeed) * 0.3;
    for (let i = 0; i < filtered.length; i++) {
      if (filtered[i] < speedThreshold) filtered[i] *= filter.processingSpeed;
    }
  }

  // Renormalize
  const max = Math.max(...Array.from(filtered), 0.001);
  for (let i = 0; i < filtered.length; i++) filtered[i] /= max;

  return filtered;
}

// ── DOM-Based Semantic Attention Layer ──

/**
 * Element type → base attention weight.
 * These represent how inherently attention-grabbing each element type is,
 * independent of visual appearance. A search bar is visually subtle but
 * a power user looks there first.
 */
const ELEMENT_TYPE_WEIGHTS: Record<string, number> = {
  cta: 1.0,           // Calls to action — highest inherent draw
  heading: 0.8,       // Headings — structural anchors
  form: 0.7,          // Form fields — interactive, task-relevant
  search: 0.7,        // Search bars — navigation entry point
  image: 0.5,         // Images — visual anchors
  navigation: 0.4,    // Nav elements — wayfinding
  link: 0.3,          // Regular links
  content: 0.2,       // Body text
  decorative: 0.1,    // Decorative images, spacers
  price: 0.9,         // Prices — high commercial relevance
  error: 0.9,         // Error messages — demand immediate attention
};

/**
 * Persona trait → element type weight modifiers.
 * Each persona amplifies or suppresses attention to certain element types
 * based on their cognitive traits and goals.
 */
const PERSONA_ELEMENT_MODIFIERS: Record<string, Record<string, number>> = {
  "first-timer": {
    cta: 1.2, heading: 1.3, navigation: 1.2, search: 1.0, content: 0.6, decorative: 0.4,
  },
  "power-user": {
    cta: 0.6, heading: 0.5, navigation: 1.4, search: 1.5, content: 0.3, form: 1.2, decorative: 0.1,
  },
  "impatient-user": {
    cta: 1.5, heading: 1.0, navigation: 0.8, search: 1.3, content: 0.2, decorative: 0.1, price: 1.3,
  },
  "elderly-user": {
    cta: 1.0, heading: 1.4, navigation: 1.3, search: 0.8, content: 0.8, form: 0.9, decorative: 0.3,
  },
  "cognitive-adhd": {
    cta: 0.8, heading: 0.7, navigation: 0.5, image: 1.5, decorative: 1.2, content: 0.3, search: 0.6,
  },
  "anxious-user": {
    cta: 0.7, heading: 1.0, price: 1.5, error: 1.5, form: 0.8, decorative: 0.3,
  },
  "motor-impairment-tremor": {
    cta: 1.0, heading: 0.8, navigation: 0.6, form: 0.7, search: 0.9, content: 0.5,
  },
  "dyslexic-user": {
    cta: 1.1, heading: 1.3, image: 1.3, content: 0.4, navigation: 0.9, decorative: 0.5,
  },
  "low-vision-magnified": {
    cta: 1.2, heading: 1.5, navigation: 1.0, content: 0.5, image: 0.8, decorative: 0.2,
  },
  "mobile-user": {
    cta: 1.3, heading: 1.0, search: 1.2, navigation: 0.7, content: 0.4, decorative: 0.2,
  },
  "confident-user": {
    cta: 0.7, heading: 0.5, navigation: 1.3, search: 1.4, form: 1.2, content: 0.3, decorative: 0.1,
  },
};

/** DOM element with bounding rect for semantic attention mapping */
export interface DOMAttentionElement {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  isCTA?: boolean;
  isHeading?: boolean;
  isNav?: boolean;
  isDecorative?: boolean;
  /**
   * Per-word boxes for this element's text.
   *
   * When present the semantic map paints THESE instead of the element rect, so
   * heat lands on glyphs rather than on the whitespace a text box spans. A
   * 400x44 heading is mostly empty pixels; painting the box puts attention where
   * there is nothing to attend to.
   */
  words?: Array<{ text: string; x: number; y: number; width: number; height: number }>;
}

/**
 * Compute trait-driven element modifiers from cognitive traits.
 * Generalizes the static PERSONA_ELEMENT_MODIFIERS table to work with
 * ANY persona's trait values, not just the 11 hardcoded ones.
 */
function computeTraitModifiers(traits: Record<string, number>): Record<string, number> {
  const t = (key: string) => traits[key] ?? 0.5;
  return {
    // Low patience → fixate on CTAs and search, skip content
    cta: 1.0 + (1.0 - t("patience")) * 0.5,
    search: 0.7 + (1.0 - t("patience")) * 0.6,
    content: 0.2 + t("patience") * 0.4,
    // High curiosity → explore headings, images, more elements
    heading: 0.8 + t("curiosity") * 0.4,
    image: 0.5 + t("curiosity") * 0.5,
    // Low siteFamiliarity → navigation, headings are important
    navigation: 0.4 + (1.0 - t("siteFamiliarity")) * 0.6,
    // High readingTendency → content draws attention
    // (overrides patience for reading-heavy personas)
    ...(t("readingTendency") > 0.6 ? { content: 0.4 + t("readingTendency") * 0.4 } : {}),
    // Low selfEfficacy → error messages, help text draw attention
    error: 0.5 + (1.0 - t("selfEfficacy")) * 0.5,
    // High riskTolerance → prices don't scare, CTAs are natural
    price: 0.5 + (1.0 - t("riskTolerance")) * 0.5,
    // Decorative: ADHD-like attention (low metacognitivePlanning = distracted by visuals)
    decorative: 0.1 + (1.0 - t("metacognitivePlanning")) * 0.4,
    form: 0.5 + t("proceduralFluency") * 0.3,
  };
}

/**
 * Compute goal relevance boost for an element.
 * If the element's text matches the user's goal, massively boost its weight.
 * This is the "task-driven attention" component (Yarbus 1967).
 */
function computeGoalRelevance(elementText: string, goal: string): number {
  if (!goal || !elementText) return 0;
  const goalLower = goal.toLowerCase();
  const textLower = elementText.toLowerCase();

  // Extract goal keywords (remove stop words)
  const stopWords = new Set(["the", "a", "an", "to", "for", "of", "in", "on", "at", "is", "it", "my", "i", "me", "and", "or", "how", "do", "can"]);
  const goalWords = goalLower.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));

  if (goalWords.length === 0) return 0;

  // Score based on keyword matches
  let matches = 0;
  for (const word of goalWords) {
    if (textLower.includes(word)) matches++;
  }

  if (matches === 0) return 0;
  // Partial match: some keywords found
  const matchRatio = matches / goalWords.length;
  // 2.0x boost for full match, proportional for partial
  return matchRatio * 2.0;
}

/**
 * Build a semantic attention map from DOM elements.
 *
 * Three layers of element weighting:
 * 1. Base weight by element type (CTA=1.0, heading=0.8, etc.)
 * 2. Persona modifiers from cognitive traits (patience, curiosity, familiarity)
 * 3. Goal relevance — elements matching the user's goal get massive boost
 *
 * Also applies Schwartz value relevance (trust signals for security-oriented,
 * novelty badges for stimulation-seeking, etc.)
 */
function buildSemanticMap(
  elements: DOMAttentionElement[],
  rows: number,
  cols: number,
  cellSize: number,
  imageWidth: number,
  imageHeight: number,
  personaName: string,
  goal?: string,
  cognitiveTraits?: Record<string, number>,
  schwartzValues?: Record<string, number>,
  /**
   * Per-element relevance, keyed by index into `elements`, 0-1.
   *
   * Supplied by the LLM judge when available. Kept as a PARAMETER rather than
   * computed here so this function stays synchronous — the judge is one network
   * call per page, and the caller is where it can be cached, tier-gated and
   * reused across the frames of a recording.
   */
  relevanceScores?: Record<number, number>,
): Float64Array {
  const map = new Float64Array(rows * cols);

  // Use trait-driven modifiers if traits available, else fall back to static table
  const modifiers = cognitiveTraits
    ? computeTraitModifiers(cognitiveTraits)
    : (PERSONA_ELEMENT_MODIFIERS[personaName] || {});

  // Value-driven semantic patterns (imported from attention-quality)
  const VALUE_PATTERNS: Record<string, { pattern: RegExp; values: Record<string, number> }> = {
    trust: { pattern: /secur|trust|verif|guarant|privacy|encrypt|safe|protect/i, values: { security: 1.0, conformity: 0.5 } },
    social: { pattern: /review|rating|star|trusted.?by|\d+[kK]?\+?\s*users|testimonial/i, values: { conformity: 1.0, security: 0.6 } },
    novelty: { pattern: /\bnew\b|beta|launch|updat|just.?added|latest|early.?access/i, values: { stimulation: 1.0, selfDirection: 0.5 } },
    metrics: { pattern: /\d+%|\d+x\s|roi|faster|improv|performance|\$\d/i, values: { achievement: 1.0, power: 0.4 } },
    urgency: { pattern: /limited|only\s*\d|hurry|expire|last.?chance|act.?now/i, values: { stimulation: 0.5, achievement: 0.4 } },
    community: { pattern: /community|join|forum|together|open.?source|contrib/i, values: { benevolence: 0.8, universalism: 0.6 } },
  };

  for (const [elementIndex, el] of elements.entries()) {
    // Determine element type
    let elType = el.type || "content";
    if (el.isCTA) elType = "cta";
    else if (el.isHeading) elType = "heading";
    else if (el.isNav) elType = "navigation";
    else if (el.isDecorative) elType = "decorative";

    // Layer 1: Base weight by element type
    let weight = ELEMENT_TYPE_WEIGHTS[elType] ?? 0.2;

    // Layer 2: Persona modifier (trait-driven or static lookup)
    const modifier = modifiers[elType] ?? 1.0;
    weight *= modifier;

    // Layer 3: Relevance — how much THIS persona should attend to this element.
    //
    // Prefers the LLM judge's score when the caller supplied one. The keyword
    // scorer below is the fallback and is kept deliberately: for the goal "buy a
    // subscription" it scores "Checkout", "Get Started" and "Upgrade to Pro" at
    // zero while giving a footer link "Subscription terms" the full boost, so it
    // is a floor to degrade to, never the intended path.
    const judged = relevanceScores?.[elementIndex];
    if (judged !== undefined && judged > 0) {
      weight *= (1.0 + judged * 2.0); // same 3x ceiling as the keyword path
    } else if (goal && el.text) {
      const goalBoost = computeGoalRelevance(el.text, goal);
      if (goalBoost > 0) {
        weight *= (1.0 + goalBoost);
      }
    }

    // Layer 4: Schwartz value relevance — elements matching persona values get boost
    if (schwartzValues && el.text) {
      for (const [, pattern] of Object.entries(VALUE_PATTERNS)) {
        if (pattern.pattern.test(el.text)) {
          let valueBoost = 0;
          for (const [valueName, valueWeight] of Object.entries(pattern.values)) {
            const personaValue = schwartzValues[valueName] ?? 0.5;
            valueBoost += (personaValue - 0.5) * valueWeight;
          }
          weight *= (1.0 + Math.max(0, valueBoost));
        }
      }
    }

    // Map element bounds to grid cells, weighted by how much of each cell the
    // element actually covers.
    //
    // Whole-cell assignment bled an element's full weight into every cell it
    // merely touched: a button at x=540 with 16px cells lit the cell starting at
    // x=528, so 12px of heat sat outside the button, and a 1px underline lit a
    // full 16px row. Fractional coverage keeps the heat on the element, which is
    // what makes an overlay point at something a designer can go and fix.
    //
    // This is a rendering-fidelity fix, not an accuracy one — no attention claim
    // at 16px is verifiable against human gaze, where the foveal limit alone is
    // 35-60px. It buys legibility, not truth.
    const pxPerCol = imageWidth / cols;
    const pxPerRow = imageHeight / rows;

    // Text elements paint their WORDS; everything else paints its box. A button
    // is a solid target and its whole rect is the thing you look at, but a
    // paragraph's box is mostly gaps between lines.
    const boxes = (el.words && el.words.length > 0)
      ? el.words.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height }))
      : [{ x: el.x, y: el.y, width: el.width, height: el.height }];

    for (const box of boxes) {
    const x0 = box.x, x1 = box.x + box.width;
    const y0 = box.y, y1 = box.y + box.height;
    const startCol = Math.max(0, Math.floor(x0 / pxPerCol));
    const endCol = Math.min(cols - 1, Math.floor((x1 - 1e-6) / pxPerCol));
    const startRow = Math.max(0, Math.floor(y0 / pxPerRow));
    const endRow = Math.min(rows - 1, Math.floor((y1 - 1e-6) / pxPerRow));

    for (let r = startRow; r <= endRow; r++) {
      const cellTop = r * pxPerRow;
      const overlapY = Math.max(0, Math.min(y1, cellTop + pxPerRow) - Math.max(y0, cellTop));
      if (overlapY <= 0) continue;
      for (let c = startCol; c <= endCol; c++) {
        const cellLeft = c * pxPerCol;
        const overlapX = Math.max(0, Math.min(x1, cellLeft + pxPerCol) - Math.max(x0, cellLeft));
        if (overlapX <= 0) continue;
        // Fraction of the CELL covered, so a sliver of element contributes a
        // sliver of heat instead of the whole cell's worth.
        const coverage = (overlapX * overlapY) / (pxPerCol * pxPerRow);
        const idx = r * cols + c;
        map[idx] = Math.max(map[idx], weight * coverage);
      }
    }
    }
  }

  // Normalize to 0-1
  const maxVal = Math.max(...Array.from(map), 0.001);
  for (let i = 0; i < map.length; i++) map[i] /= maxVal;

  return map;
}

/**
 * Blend visual saliency with semantic attention map.
 * visual: what POPS visually (color contrast)
 * semantic: what MATTERS structurally (element types × persona priorities)
 */
function blendSaliencyMaps(
  visual: Float64Array,
  semantic: Float64Array,
  visualWeight: number = 0.35,
  semanticWeight: number = 0.65,
): Float64Array {
  const blended = new Float64Array(visual.length);
  for (let i = 0; i < visual.length; i++) {
    blended[i] = visual[i] * visualWeight + semantic[i] * semanticWeight;
  }
  // Renormalize
  const max = Math.max(...Array.from(blended), 0.001);
  for (let i = 0; i < blended.length; i++) blended[i] /= max;
  return blended;
}

// ── Public API ──

/**
 * Compute persona-specific attention analysis for a screenshot.
 *
 * Two-layer attention model:
 * 1. Visual saliency — W₂ on CIE-Lab distributions (what POPS visually)
 * 2. Semantic attention — DOM element classification × persona priorities (what MATTERS)
 *
 * Blended at 35% visual / 65% semantic (research shows task-driven attention
 * dominates bottom-up saliency for goal-oriented users — Yarbus 1967,
 * Henderson 2003, Tatler et al. 2011).
 *
 * When DOM elements are not provided, falls back to visual-only mode.
 */
/**
 * Fast DOM-only attention analysis. Skips the slow CIE-Lab saliency pass
 * (which decodes the screenshot, downscales, and computes per-pixel Lab
 * variance — typically 1-3s). Uses the semantic saliency map alone, which
 * is plenty for live cognitive-journey overlays where the persona is
 * attending to elements (CTAs, headings, links), not raw color hotspots.
 *
 * Returns the same AttentionAnalysis shape as analyzeAttention so callers
 * are interchangeable. Typical runtime: 5-30ms vs 1500-3000ms for the full
 * version.
 */
export async function analyzeAttentionFromDOM(
  viewportWidth: number,
  viewportHeight: number,
  domElements: DOMAttentionElement[],
  personaName: string,
  cellSize: number = 16,
  schwartzValues?: Record<string, number>,
  goal?: string,
  cognitiveTraits?: Record<string, number>,
  relevanceScores?: Record<number, number>,
): Promise<AttentionAnalysis> {
  const startTime = performance.now();
  const profile = getPerceptualProfile(personaName);

  // Look up Schwartz values from built-in profiles if caller didn't pass any
  let values = schwartzValues;
  if (!values) {
    try {
      const { getPersonaValues } = await import('../values/index.js');
      const pv = getPersonaValues(personaName);
      if (pv) {
        values = {
          selfDirection: pv.selfDirection, stimulation: pv.stimulation,
          hedonism: pv.hedonism, achievement: pv.achievement, power: pv.power,
          security: pv.security, conformity: pv.conformity, tradition: pv.tradition,
          benevolence: pv.benevolence, universalism: pv.universalism,
        };
      }
    } catch { /* best-effort */ }
  }
  let traits = cognitiveTraits;
  if (!traits) {
    try {
      const { getAnyPersona, getCognitiveProfile } = await import('../personas.js');
      const p = getAnyPersona(personaName);
      if (p) traits = getCognitiveProfile(p as any).traits as unknown as Record<string, number>;
    } catch {}
  }

  // DOM elements come back in full viewport coordinates (getBoundingClientRect),
  // so the grid + image dimensions passed to buildSemanticMap MUST also be in
  // full viewport space. The screenshot-based path scaled by 0.5 because the
  // image was downsampled; without an image we don't downsample. Using half
  // dimensions here was the bug: elements with x > viewport/2 all clamped to
  // the right edge of the grid, producing the "random hotspots on right side"
  // artifact.
  const rows = Math.ceil(viewportHeight / cellSize);
  const cols = Math.ceil(viewportWidth / cellSize);

  const semanticMap = buildSemanticMap(
    domElements,
    rows, cols, cellSize,
    viewportWidth, viewportHeight,
    personaName, goal, traits, values, relevanceScores,
  );

  // Apply persona perceptual filter directly to the semantic map (no Lab blend)
  const filtered = applyPersonaFilter(semanticMap, rows, cols, profile.visualFilter, values);

  // Hotspots, entropy, concentration — same shape as analyzeAttention
  const indexed = Array.from(filtered).map((s, i) => ({ s, i }));
  indexed.sort((a, b) => b.s - a.s);
  const hotspots = indexed.slice(0, 10).map(({ s, i }) => ({
    row: Math.floor(i / cols),
    col: i % cols,
    x: (i % cols) * cellSize,
    y: Math.floor(i / cols) * cellSize,
    saliency: s,
  }));

  const totalSaliency = filtered.reduce((a, b) => a + b, 0) || 1;
  let entropy = 0;
  for (let i = 0; i < filtered.length; i++) {
    const p = filtered[i] / totalSaliency;
    if (p > 0) entropy -= p * Math.log2(p + 1e-10);
  }
  entropy = entropy / Math.log2(filtered.length || 1);

  const sorted = Array.from(filtered).sort((a, b) => b - a);
  const top20Count = Math.ceil(filtered.length * 0.2);
  const top20Sum = sorted.slice(0, top20Count).reduce((a, b) => a + b, 0);
  const concentration = top20Sum / totalSaliency;

  return {
    persona: personaName,
    saliencyMap: {
      cells: filtered,
      rows, cols,
      width: viewportWidth, height: viewportHeight,
      cellSize,
      hotspots,
    },
    alignmentScore: 1, // No base to compare against
    entropy: Math.round(entropy * 1000) / 1000,
    concentration: Math.round(concentration * 1000) / 1000,
    attentionCompetitors: hotspots.slice(0, 5).map((h) => ({
      region: `(${h.x}, ${h.y})`,
      saliency: Math.round(h.saliency * 100) / 100,
    })),
    transportCost: 0,
    computeTimeMs: performance.now() - startTime,
  };
}

export async function analyzeAttention(
  screenshotPath: string,
  personaName: string,
  cellSize: number = 16,
  schwartzValues?: Record<string, number>,
  domElements?: DOMAttentionElement[],
  goal?: string,
  cognitiveTraits?: Record<string, number>,
  relevanceScores?: Record<number, number>,
): Promise<AttentionAnalysis> {
  const startTime = performance.now();
  const profile = getPerceptualProfile(personaName);

  // v18.54.0: If no values passed, try to look them up from the built-in value profiles
  let values = schwartzValues;
  if (!values) {
    try {
      const { getPersonaValues } = await import('../values/index.js');
      const pv = getPersonaValues(personaName);
      if (pv) {
        values = {
          selfDirection: pv.selfDirection, stimulation: pv.stimulation,
          hedonism: pv.hedonism, achievement: pv.achievement, power: pv.power,
          security: pv.security, conformity: pv.conformity, tradition: pv.tradition,
          benevolence: pv.benevolence, universalism: pv.universalism,
        };
      }
    } catch { /* values not available — use filter-only mode */ }
  }

  // Layer 1: Visual saliency — W₂ on CIE-Lab distributions
  const baseSaliency = await computeLabSaliency(screenshotPath, cellSize);

  // Layer 2: Semantic attention — DOM element types × persona priorities
  let combinedSaliency: Float64Array;
  if (domElements && domElements.length > 0) {
    // Load cognitive traits if not provided
    let traits = cognitiveTraits;
    if (!traits) {
      try {
        const { getAnyPersona, getCognitiveProfile } = await import('../personas.js');
        const p = getAnyPersona(personaName);
        if (p) traits = getCognitiveProfile(p as any).traits as unknown as Record<string, number>;
      } catch {}
    }

    const semanticMap = buildSemanticMap(
      domElements,
      baseSaliency.rows, baseSaliency.cols,
      cellSize,
      baseSaliency.width, baseSaliency.height,
      personaName,
      goal,
      traits,
      values,
      relevanceScores,
    );
    // Blend: 35% visual (what pops) + 65% semantic (what matters)
    combinedSaliency = blendSaliencyMaps(baseSaliency.cells, semanticMap, 0.35, 0.65);
  } else {
    // No DOM data — fall back to visual-only.
    //
    // This fallback changes what the heatmap MEANS, and said so nowhere. With
    // DOM elements the map is 35% bottom-up saliency + 65% semantic (element
    // type x persona priority) — a model of attention. Without them it is the
    // bottom-up layer alone: centre-surround colour contrast in CIE-Lab. Those
    // are different quantities under one name, and two of the three production
    // callers take this branch (visual_cognitive_story and journey_heatmap_gif
    // both call analyzeAttention with three arguments), so most heatmaps this
    // product has shipped are contrast maps presented as attention maps.
    //
    // Not changing the fallback here — collecting DOM elements in those callers
    // is their change to make. But the caller must be able to tell which model
    // produced the number. (2026-07-29)
    combinedSaliency = baseSaliency.cells;
  }
  const attentionModel: "visual+semantic" | "visual-only" =
    domElements && domElements.length > 0 ? "visual+semantic" : "visual-only";

  // Apply persona perceptual filter + value-driven attention modulation
  const filtered = applyPersonaFilter(
    combinedSaliency, baseSaliency.rows, baseSaliency.cols,
    profile.visualFilter,
    values,
  );

  // Build saliency map with hotspots
  const indexed = Array.from(filtered).map((s, i) => ({ s, i }));
  indexed.sort((a, b) => b.s - a.s);
  const hotspots = indexed.slice(0, 10).map(({ s, i }) => ({
    row: Math.floor(i / baseSaliency.cols),
    col: i % baseSaliency.cols,
    x: (i % baseSaliency.cols) * cellSize * 2, // Scale back to original
    y: Math.floor(i / baseSaliency.cols) * cellSize * 2,
    saliency: s,
  }));

  const saliencyMap: SaliencyMap = {
    cells: filtered,
    /**
     * Which model produced `cells`.
     *
     * "visual+semantic" — 35% centre-surround CIE-Lab saliency blended with 65%
     * DOM-semantic attention (element type x persona priority).
     * "visual-only" — the bottom-up layer alone, i.e. local colour-contrast
     * pop-out. Useful, but NOT a model of where a person looks.
     */
    attentionModel,
    rows: baseSaliency.rows,
    cols: baseSaliency.cols,
    width: baseSaliency.width,
    height: baseSaliency.height,
    cellSize: cellSize * 2, // Scaled
    hotspots,
  };

  // Compute attention metrics
  const totalSaliency = filtered.reduce((a, b) => a + b, 0) || 1;

  // Entropy: -Σ p*log(p) where p = normalized saliency
  let entropy = 0;
  for (let i = 0; i < filtered.length; i++) {
    const p = filtered[i] / totalSaliency;
    if (p > 0) entropy -= p * Math.log2(p + 1e-10);
  }
  const maxEntropy = Math.log2(filtered.length);
  entropy = entropy / maxEntropy; // Normalize to 0-1

  // Concentration: fraction of total saliency in top 20% of cells
  const sorted = Array.from(filtered).sort((a, b) => b - a);
  const top20Count = Math.ceil(filtered.length * 0.2);
  const top20Sum = sorted.slice(0, top20Count).reduce((a, b) => a + b, 0);
  const concentration = top20Sum / totalSaliency;

  // Alignment: how well does the persona's saliency match the base (unfiltered) saliency?
  // Computed as correlation between filtered and base saliency
  let sumAB = 0, sumA2 = 0, sumB2 = 0;
  const meanA = baseSaliency.cells.reduce((a, b) => a + b, 0) / baseSaliency.cells.length;
  const meanB = filtered.reduce((a, b) => a + b, 0) / filtered.length;
  for (let i = 0; i < filtered.length; i++) {
    const da = baseSaliency.cells[i] - meanA;
    const db = filtered[i] - meanB;
    sumAB += da * db;
    sumA2 += da * da;
    sumB2 += db * db;
  }
  const alignmentScore = sumA2 > 0 && sumB2 > 0 ? sumAB / Math.sqrt(sumA2 * sumB2) : 1;

  // Transport cost: W₁ between base and filtered saliency (how much attention moved)
  let transportCost = 0;
  for (let i = 0; i < filtered.length; i++) {
    transportCost += Math.abs(baseSaliency.cells[i] / (totalSaliency || 1) - filtered[i] / (totalSaliency || 1));
  }

  // Attention competitors: group hotspots into regions
  const attentionCompetitors = hotspots.slice(0, 5).map((h, i) => ({
    region: `(${h.x}, ${h.y})`,
    saliency: Math.round(h.saliency * 100) / 100,
  }));

  return {
    persona: personaName,
    saliencyMap,
    alignmentScore: Math.round(alignmentScore * 1000) / 1000,
    entropy: Math.round(entropy * 1000) / 1000,
    concentration: Math.round(concentration * 1000) / 1000,
    attentionCompetitors,
    transportCost: Math.round(transportCost * 10000) / 10000,
    computeTimeMs: performance.now() - startTime,
  };
}

/**
 * Compare attention patterns between two personas on the same screenshot.
 * Returns the Wasserstein divergence between their saliency maps and
 * identifies regions where attention differs most.
 */
export async function compareAttention(
  screenshotPath: string,
  personaA: string,
  personaB: string,
  cellSize: number = 16,
  domElements?: DOMAttentionElement[],
  goal?: string,
): Promise<AttentionComparisonResult> {
  const [analysisA, analysisB] = await Promise.all([
    analyzeAttention(screenshotPath, personaA, cellSize, undefined, domElements, goal),
    analyzeAttention(screenshotPath, personaB, cellSize, undefined, domElements, goal),
  ]);

  const salA = analysisA.saliencyMap.cells;
  const salB = analysisB.saliencyMap.cells;
  const n = Math.min(salA.length, salB.length);

  // W₁ between the two saliency distributions
  let divergence = 0;
  const totalA = salA.reduce((a, b) => a + b, 0) || 1;
  const totalB = salB.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < n; i++) {
    divergence += Math.abs(salA[i] / totalA - salB[i] / totalB);
  }

  // Find the most divergent regions.
  //
  // The aggregate above is computed on NORMALIZED saliency (salA/totalA vs
  // salB/totalB); this loop used RAW values against a fixed 0.3 threshold. Two
  // different scales for one concept, so on any page whose per-cell saliency is
  // individually small — most pages, since the map is normalized across many
  // cells — nothing cleared 0.3 and the list came back EMPTY while
  // attentionDivergence read 0.2606 and the interpretation said "substantially
  // different attention patterns". The report was describing a difference it
  // then declined to locate.
  //
  // Ranking now uses the same normalized quantity the aggregate sums, so the
  // regions are literally the largest contributors to the number reported
  // beside them, and a non-zero divergence can no longer yield an empty list.
  // (2026-07-29)
  const contributions: Array<{ i: number; div: number }> = [];
  for (let i = 0; i < n; i++) {
    contributions.push({ i, div: Math.abs(salA[i] / totalA - salB[i] / totalB) });
  }
  contributions.sort((a, b) => b.div - a.div);

  // Keep cells carrying a real share of the total divergence, but never return
  // nothing when there IS divergence: at minimum the top contributors.
  const shareFloor = divergence > 0 ? divergence * 0.01 : Infinity;
  const significant = contributions.filter((c) => c.div > shareFloor);
  const selected = significant.length > 0 ? significant : contributions.filter((c) => c.div > 0);

  const divergentRegions: AttentionComparisonResult['divergentRegions'] = selected.map(({ i, div }) => {
    const row = Math.floor(i / analysisA.saliencyMap.cols);
    const col = i % analysisA.saliencyMap.cols;
    return {
      row, col,
      x: col * analysisA.saliencyMap.cellSize,
      y: row * analysisA.saliencyMap.cellSize,
      saliencyA: Math.round(salA[i] * 100) / 100,
      saliencyB: Math.round(salB[i] * 100) / 100,
      // Share of the reported attentionDivergence this cell accounts for.
      divergence: Math.round(div * 10000) / 10000,
    };
  });

  return {
    personaA: analysisA,
    personaB: analysisB,
    attentionDivergence: Math.round(divergence * 10000) / 10000,
    divergentRegions: divergentRegions.slice(0, 10),
  };
}
