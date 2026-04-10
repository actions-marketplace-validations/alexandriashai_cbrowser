/**
 * Perceptual Transport — Persona-aware visual analysis via optimal transport
 *
 * Models how different personas PERCEIVE the same page differently by
 * transforming the visual distribution through persona-specific filters,
 * then measuring the transport cost (information loss, attention mismatch,
 * motor accessibility cost) using Wasserstein distance.
 *
 * This produces meaningfully different scores per persona from the same page.
 *
 * @version 1.0.0
 * @since v18.26.0
 * @see https://github.com/alexandriashai/cbrowser/issues/158
 */

import { computeWassersteinDistance, type WassersteinConfig } from './distance-metrics.js';

// ── Types ──

export interface PerceptualProfile {
  /** Persona identifier */
  persona: string;
  /** Category for selecting filter */
  category: 'motor' | 'vision' | 'cognitive' | 'hearing' | 'general';
  /** Per-barrier-type severity multipliers (1.0 = normal, 3.0 = 3x worse for this persona) */
  barrierWeights: Record<string, number>;
  /** Visual filter to simulate perception */
  visualFilter: PerceptualFilter;
}

export interface PerceptualFilter {
  /** Minimum contrast ratio this persona can perceive (lower = worse vision) */
  contrastThreshold: number;
  /** Blur radius to simulate reduced acuity (0 = perfect vision) */
  blurRadius: number;
  /** Color channel attenuation [r, g, b] — 1.0 = full, 0.0 = blind to channel */
  colorAttenuation: [number, number, number];
  /** Attention distribution: how visual weight is distributed */
  attentionMode: 'uniform' | 'center-heavy' | 'motion-attracted' | 'text-focused' | 'large-elements';
  /** Interactive element reach cost multiplier (1.0 = normal, 3.0 = hard to reach) */
  motorCostMultiplier: number;
  /** Cognitive processing speed (1.0 = normal, 0.5 = needs 2x time) */
  processingSpeed: number;
  /** Visual noise tolerance (0-1, lower = more easily overwhelmed) */
  noiseTolerance: number;
}

export interface PerceptualAnalysis {
  persona: string;
  category: string;
  /** Information loss: how much visual information this persona loses (0 = none, 1 = total) */
  informationLoss: number;
  /** Attention mismatch: how far persona's attention diverges from intended design (0 = aligned, 1 = opposite) */
  attentionMismatch: number;
  /** Motor accessibility cost: how hard interactive elements are to reach (0 = easy, 1 = impossible) */
  motorCost: number;
  /** Cognitive load: how overwhelming the visual complexity is (0 = simple, 1 = overwhelming) */
  cognitiveLoad: number;
  /** Composite perceptual score (0-100, higher = more accessible for this persona) */
  perceptualScore: number;
  /** Per-barrier-type weighted deductions */
  weightedDeductions: Record<string, number>;
  /** Comparison to baseline (unfiltered) Wasserstein distance */
  transportDistance: number;
  computeTimeMs: number;
}

// ── Persona Perceptual Profiles ──

const PERCEPTUAL_PROFILES: Record<string, PerceptualProfile> = {
  'motor-impairment-tremor': {
    persona: 'motor-impairment-tremor',
    category: 'motor',
    barrierWeights: {
      touch_target: 3.0,      // Critical — small targets + tremor = impossible
      hover_dependent: 2.5,    // Can't hover precisely
      timing: 2.0,             // Need more time due to imprecise movement
      form_complexity: 1.5,    // Each field is a motor challenge
      cognitive_load: 0.8,     // Cognitive is less affected
      low_contrast: 0.5,       // Vision is fine
      color_only: 0.3,         // Can see colors fine
      missing_alt: 0.2,        // Not relevant
      missing_label: 1.5,      // Labels help target the right field
    },
    visualFilter: {
      contrastThreshold: 0,    // Vision is fine
      blurRadius: 0,
      colorAttenuation: [1, 1, 1],
      attentionMode: 'center-heavy',  // Attention narrows to avoid accidental clicks
      motorCostMultiplier: 3.0,       // Everything is 3x harder to click
      processingSpeed: 0.8,
      noiseTolerance: 0.7,
    },
  },

  'low-vision-magnified': {
    persona: 'low-vision-magnified',
    category: 'vision',
    barrierWeights: {
      low_contrast: 3.0,       // Critical — can't see low contrast at all
      touch_target: 1.5,       // Magnified so targets appear larger, but still relevant
      color_only: 2.0,         // May not distinguish subtle color differences
      missing_alt: 2.5,        // Relies heavily on alt text
      missing_label: 2.0,      // Relies on labels
      cognitive_load: 1.0,
      timing: 1.5,             // Needs more time to scan magnified view
      hover_dependent: 1.0,
      form_complexity: 1.2,
    },
    visualFilter: {
      contrastThreshold: 7.0,   // Needs very high contrast
      blurRadius: 2.0,          // Reduced acuity
      colorAttenuation: [0.7, 0.7, 0.7],  // Reduced color perception
      attentionMode: 'large-elements',     // Only sees large things
      motorCostMultiplier: 1.2,
      processingSpeed: 0.6,     // Slow visual processing
      noiseTolerance: 0.4,      // Easily overwhelmed
    },
  },

  'cognitive-adhd': {
    persona: 'cognitive-adhd',
    category: 'cognitive',
    barrierWeights: {
      cognitive_load: 3.0,     // Critical — overwhelmed by complexity
      timing: 2.5,             // Time pressure causes panic
      form_complexity: 2.5,    // Long forms = abandonment
      touch_target: 0.5,       // Motor is fine
      low_contrast: 0.8,       // Vision is fine
      color_only: 0.5,
      missing_alt: 0.3,
      hover_dependent: 1.0,
      missing_label: 1.5,      // Needs clear labels to stay focused
    },
    visualFilter: {
      contrastThreshold: 0,
      blurRadius: 0,
      colorAttenuation: [1, 1, 1],
      attentionMode: 'motion-attracted',  // Attention hijacked by movement
      motorCostMultiplier: 1.0,
      processingSpeed: 0.5,    // Slow sustained attention
      noiseTolerance: 0.3,     // Very easily overwhelmed
    },
  },

  'dyslexic-user': {
    persona: 'dyslexic-user',
    category: 'cognitive',
    barrierWeights: {
      cognitive_load: 2.5,     // Text-heavy pages are exhausting
      form_complexity: 2.0,    // Reading labels is hard
      low_contrast: 1.5,       // Low contrast makes text harder
      timing: 1.5,             // Need more time to read
      missing_label: 2.0,      // Relies on clear labels
      touch_target: 0.5,
      color_only: 0.8,
      missing_alt: 1.0,
      hover_dependent: 0.8,
    },
    visualFilter: {
      contrastThreshold: 0,
      blurRadius: 0,
      colorAttenuation: [1, 1, 1],
      attentionMode: 'text-focused',  // Attention locked on text, struggling
      motorCostMultiplier: 1.0,
      processingSpeed: 0.4,    // Very slow text processing
      noiseTolerance: 0.5,
    },
  },

  'color-blind-deuteranopia': {
    persona: 'color-blind-deuteranopia',
    category: 'vision',
    barrierWeights: {
      color_only: 3.0,         // Critical — can't see color differences
      low_contrast: 2.0,       // Some contrasts disappear
      missing_alt: 1.0,
      missing_label: 1.0,
      cognitive_load: 0.8,
      touch_target: 0.5,
      timing: 0.5,
      hover_dependent: 0.5,
      form_complexity: 0.8,
    },
    visualFilter: {
      contrastThreshold: 0,
      blurRadius: 0,
      colorAttenuation: [1.0, 0.0, 0.7],  // No green channel (deuteranopia)
      attentionMode: 'uniform',
      motorCostMultiplier: 1.0,
      processingSpeed: 0.9,
      noiseTolerance: 0.8,
    },
  },

  'deaf-user': {
    persona: 'deaf-user',
    category: 'hearing',
    barrierWeights: {
      // Most visual barriers are less relevant
      touch_target: 0.5,
      low_contrast: 0.5,
      color_only: 0.5,
      cognitive_load: 0.8,
      timing: 1.5,            // Can't hear audio cues for time limits
      missing_alt: 1.0,
      missing_label: 1.0,
      hover_dependent: 0.5,
      form_complexity: 0.8,
    },
    visualFilter: {
      contrastThreshold: 0,
      blurRadius: 0,
      colorAttenuation: [1, 1, 1],
      attentionMode: 'uniform',
      motorCostMultiplier: 1.0,
      processingSpeed: 1.0,
      noiseTolerance: 0.9,
    },
  },

  'elderly-low-vision': {
    persona: 'elderly-low-vision',
    category: 'vision',
    barrierWeights: {
      touch_target: 2.0,      // Reduced dexterity
      low_contrast: 2.5,      // Aging eyes need high contrast
      timing: 2.0,            // Slower processing
      form_complexity: 2.0,   // Cognitive decline
      cognitive_load: 2.0,    // Easily confused
      color_only: 1.5,
      missing_alt: 1.5,
      missing_label: 2.0,
      hover_dependent: 1.5,
    },
    visualFilter: {
      contrastThreshold: 5.0,
      blurRadius: 1.5,
      colorAttenuation: [0.8, 0.8, 0.7],  // Yellowing lens
      attentionMode: 'text-focused',
      motorCostMultiplier: 1.8,
      processingSpeed: 0.5,
      noiseTolerance: 0.4,
    },
  },
};

// Default profile for unknown personas
const DEFAULT_PROFILE: PerceptualProfile = {
  persona: 'default',
  category: 'general',
  barrierWeights: {
    touch_target: 1.0, low_contrast: 1.0, cognitive_load: 1.0,
    timing: 1.0, color_only: 1.0, missing_alt: 1.0,
    missing_label: 1.0, hover_dependent: 1.0, form_complexity: 1.0,
  },
  visualFilter: {
    contrastThreshold: 0, blurRadius: 0, colorAttenuation: [1, 1, 1],
    attentionMode: 'uniform', motorCostMultiplier: 1.0,
    processingSpeed: 1.0, noiseTolerance: 1.0,
  },
};

// ── Public API ──

/**
 * Get the perceptual profile for a persona.
 */
export function getPerceptualProfile(personaName: string): PerceptualProfile {
  return PERCEPTUAL_PROFILES[personaName] || DEFAULT_PROFILE;
}

/**
 * Apply persona-weighted barrier scoring.
 *
 * Instead of flat deductions per barrier type, multiplies each deduction
 * by the persona's sensitivity to that barrier type. This produces
 * meaningfully different scores per persona from the same set of barriers.
 *
 * @param barriers - Detected barriers (same for all personas on same page)
 * @param frictionPoints - Detected friction points
 * @param goalAchieved - Whether the persona achieved their goal
 * @param personaName - Persona to score for
 * @returns Weighted score and breakdown
 */
export function calculatePerceptualScore(
  barriers: Array<{ type: string; severity: string; element?: string }>,
  frictionPoints: Array<{ impact: string }>,
  goalAchieved: boolean,
  personaName: string,
): {
  score: number;
  deductions: Record<string, number>;
  informationLoss: number;
  cognitiveLoad: number;
  motorCost: number;
  explanation: string;
} {
  const profile = getPerceptualProfile(personaName);
  const filter = profile.visualFilter;
  let score = 100;
  const deductions: Record<string, number> = {};

  // Group barriers by type
  const byType = new Map<string, Array<{ severity: string }>>();
  for (const b of barriers) {
    const existing = byType.get(b.type) || [];
    existing.push(b);
    byType.set(b.type, existing);
  }

  // Apply persona-weighted deductions
  for (const [type, typeBarriers] of byType) {
    const weight = profile.barrierWeights[type] ?? 1.0;

    const critical = typeBarriers.filter(b => b.severity === 'critical').length;
    const major = typeBarriers.filter(b => b.severity === 'major').length;
    const minor = typeBarriers.filter(b => b.severity === 'minor').length;

    // Base deductions (same formula as before)
    const criticalBase = Math.min(25, critical > 0 ? 15 + Math.min(critical - 1, 2) * 5 : 0);
    const majorBase = Math.min(15, major > 0 ? 8 + Math.min(major - 1, 2) * 3 : 0);
    const minorBase = Math.min(8, minor > 0 ? 3 + Math.min(minor - 1, 3) * 1.5 : 0);

    // Apply persona weight — this is the key differentiator
    const weighted = (criticalBase + majorBase + minorBase) * weight;
    // Cap per-type deduction at 35 (even 3x multiplier shouldn't zero out from one type)
    const capped = Math.min(35, weighted);

    if (capped > 0) {
      deductions[type] = -Math.round(capped * 10) / 10;
      score -= capped;
    }
  }

  // Friction deduction scaled by processing speed
  // Slower processors are more affected by friction
  let rawFriction = 0;
  for (const fp of frictionPoints) {
    switch (fp.impact) {
      case 'high': rawFriction += 8; break;
      case 'medium': rawFriction += 4; break;
      case 'low': rawFriction += 2; break;
    }
  }
  const frictionDeduction = Math.min(25, rawFriction / filter.processingSpeed);
  score -= frictionDeduction;

  // Goal penalty scaled by motor cost (harder to reach = harder to achieve)
  const goalDeduction = goalAchieved ? 0 : 15 * filter.motorCostMultiplier;
  score -= Math.min(25, goalDeduction);

  // Cognitive load penalty based on noise tolerance
  const cognitiveLoad = 1 - filter.noiseTolerance;
  const cognitiveOverloadPenalty = cognitiveLoad * 10; // Up to 10 point penalty
  score -= cognitiveOverloadPenalty;

  // Information loss estimate from filter properties
  const channelLoss = 1 - (filter.colorAttenuation[0] + filter.colorAttenuation[1] + filter.colorAttenuation[2]) / 3;
  const acuityLoss = Math.min(1, filter.blurRadius / 5);
  const informationLoss = (channelLoss + acuityLoss) / 2;

  // Motor cost from filter
  const motorCost = Math.min(1, (filter.motorCostMultiplier - 1) / 2);

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Build explanation
  const topDeductions = Object.entries(deductions)
    .sort(([, a], [, b]) => a - b)
    .slice(0, 3)
    .map(([type, d]) => `${type.replace(/_/g, ' ')} (${d})`)
    .join(', ');

  const explanation = [
    topDeductions ? `Weighted barrier deductions: ${topDeductions}` : '',
    frictionDeduction > 0 ? `Friction (${filter.processingSpeed}x speed): -${frictionDeduction.toFixed(1)}` : '',
    goalDeduction > 0 ? `Goal penalty (${filter.motorCostMultiplier}x motor): -${goalDeduction.toFixed(1)}` : '',
    cognitiveOverloadPenalty > 0 ? `Cognitive overload (${filter.noiseTolerance} tolerance): -${cognitiveOverloadPenalty.toFixed(1)}` : '',
    informationLoss > 0.05 ? `Visual info loss: ${(informationLoss * 100).toFixed(0)}%` : '',
  ].filter(Boolean).join('. ');

  return {
    score,
    deductions,
    informationLoss,
    cognitiveLoad,
    motorCost,
    explanation,
  };
}

/**
 * Compute visual perception analysis for a persona using a screenshot.
 *
 * Applies the persona's visual filter to the image and measures
 * the Wasserstein distance between original and filtered versions —
 * quantifying how much visual information this persona loses.
 *
 * @param screenshotPath - Path to page screenshot
 * @param personaName - Persona to analyze for
 * @returns Perceptual analysis with transport-based metrics
 */
export async function analyzePerceptualTransport(
  screenshotPath: string,
  personaName: string,
): Promise<PerceptualAnalysis> {
  const startTime = performance.now();
  const profile = getPerceptualProfile(personaName);
  const filter = profile.visualFilter;

  // Load and apply perceptual filter to create "what this persona sees"
  const sharpModule: any = await import('sharp');
  const sharp = sharpModule.default ?? sharpModule;

  const original = sharp(screenshotPath);
  const metadata = await original.metadata();
  const width = Math.round((metadata.width || 800) * 0.5);
  const height = Math.round((metadata.height || 600) * 0.5);

  // Build the filtered version
  let filtered = sharp(screenshotPath).resize(width, height);

  // Apply blur for reduced acuity
  if (filter.blurRadius > 0) {
    filtered = filtered.blur(Math.max(0.3, filter.blurRadius));
  }

  // Apply color attenuation (simulate color blindness / reduced color perception)
  const [rAtt, gAtt, bAtt] = filter.colorAttenuation;
  if (rAtt < 1 || gAtt < 1 || bAtt < 1) {
    // Use recomb matrix to attenuate channels
    // For deuteranopia: shift green into red/blue
    filtered = filtered.recomb([
      [rAtt, (1 - rAtt) * 0.5, (1 - rAtt) * 0.5],
      [(1 - gAtt) * 0.5, gAtt, (1 - gAtt) * 0.5],
      [(1 - bAtt) * 0.3, (1 - bAtt) * 0.3, bAtt + (1 - bAtt) * 0.4],
    ]);
  }

  // Apply contrast reduction for low-vision
  if (filter.contrastThreshold > 3) {
    const factor = Math.max(0.3, 1 - (filter.contrastThreshold - 3) / 10);
    filtered = filtered.modulate({ brightness: factor });
  }

  // Save filtered version to temp file
  const { join } = await import('path');
  const { tmpdir } = await import('os');
  const filteredPath = join(tmpdir(), `perceptual-${personaName}-${Date.now()}.png`);
  await filtered.png().toFile(filteredPath);

  // Also save downscaled original for comparison
  const originalPath = join(tmpdir(), `perceptual-original-${Date.now()}.png`);
  await sharp(screenshotPath).resize(width, height).png().toFile(originalPath);

  // Compute Wasserstein distance between original and filtered
  const transportResult = await computeWassersteinDistance(originalPath, filteredPath, {
    compareMode: 'combined',
    numProjections: 32,
    downscale: 1.0, // Already downscaled
  });

  // Clean up temp files
  const { unlinkSync } = await import('fs');
  try { unlinkSync(filteredPath); } catch {}
  try { unlinkSync(originalPath); } catch {}

  // Derive metrics
  const informationLoss = Math.min(1, transportResult.distance * 3);
  const channelDistances = transportResult.details.channelDistances;

  // Attention mismatch based on attention mode
  let attentionMismatch = 0;
  switch (filter.attentionMode) {
    case 'motion-attracted': attentionMismatch = 0.6; break;  // ADHD: attention goes to wrong places
    case 'center-heavy': attentionMismatch = 0.3; break;       // Motor: narrow focus
    case 'large-elements': attentionMismatch = 0.4; break;     // Low-vision: misses small elements
    case 'text-focused': attentionMismatch = 0.2; break;       // Dyslexia: focused but slow
    case 'uniform': attentionMismatch = 0.1; break;            // Default
  }

  // Motor cost
  const motorCost = Math.min(1, (filter.motorCostMultiplier - 1) / 2);

  // Cognitive load
  const cognitiveLoad = 1 - filter.noiseTolerance;

  // Composite perceptual score
  const perceptualScore = Math.max(0, Math.min(100, Math.round(
    100
    - informationLoss * 30         // Up to 30 points for information loss
    - attentionMismatch * 20       // Up to 20 points for attention mismatch
    - motorCost * 25               // Up to 25 points for motor difficulty
    - cognitiveLoad * 25           // Up to 25 points for cognitive overload
  )));

  return {
    persona: personaName,
    category: profile.category,
    informationLoss,
    attentionMismatch,
    motorCost,
    cognitiveLoad,
    perceptualScore,
    weightedDeductions: {},
    transportDistance: transportResult.distance,
    computeTimeMs: performance.now() - startTime,
  };
}

/**
 * List all available perceptual profiles.
 */
export function listPerceptualProfiles(): string[] {
  return Object.keys(PERCEPTUAL_PROFILES);
}
