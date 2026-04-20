/**
 * CIF -- Cognitive Interface Fitness
 *
 * 5-category scoring system measuring whether a website actually works
 * for people with specific disabilities. Scores 0-100 per category.
 *
 * Categories:
 * 1. Motor Fitness (20%)  -- can they physically interact?
 * 2. Visual Fitness (20%) -- can they see and distinguish?
 * 3. Cognitive Fitness (25%) -- can they understand and decide?
 * 4. Sensory Fitness (15%) -- can they process without overload?
 * 5. Navigation Fitness (20%) -- can they get around?
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 * @since v19.0.0
 */

// ============================================================================
// Types
// ============================================================================

export interface CIFComponentScore {
  score: number;
  details: string;
}

export interface CIFScore {
  composite: number;
  grade: string;
  certification: string;

  motor: {
    score: number;
    components: {
      touchTargetCompliance: CIFComponentScore;
      hitProbability: CIFComponentScore;
      interactionCount: CIFComponentScore;
      spacingAdequacy: CIFComponentScore;
      dragFreeAlternatives: CIFComponentScore;
    };
  };

  visual: {
    score: number;
    components: {
      contrastCompliance: CIFComponentScore;
      textScalability: CIFComponentScore;
      colorIndependence: CIFComponentScore;
      focusVisibility: CIFComponentScore;
      spacingDensity: CIFComponentScore;
    };
  };

  cognitive: {
    score: number;
    components: {
      decisionComplexity: CIFComponentScore;
      readability: CIFComponentScore;
      informationDensity: CIFComponentScore;
      attentionClarity: CIFComponentScore;
      predictability: CIFComponentScore;
    };
  };

  sensory: {
    score: number;
    components: {
      animationControl: CIFComponentScore;
      sensoryIndependence: CIFComponentScore;
      visualCalm: CIFComponentScore;
      layoutConsistency: CIFComponentScore;
      overloadThreshold: CIFComponentScore;
    };
  };

  navigation: {
    score: number;
    components: {
      semanticStructure: CIFComponentScore;
      keyboardOperability: CIFComponentScore;
      skipMechanisms: CIFComponentScore;
      linkButtonClarity: CIFComponentScore;
      formAccessibility: CIFComponentScore;
    };
  };

  topIssues: Array<{
    category: string;
    component: string;
    score: number;
    fix: string;
  }>;
  url: string;
  timestamp: string;
}

export interface CIFInput {
  // From empathy_audit
  barriers?: Array<{
    type: string;
    severity: string;
    element?: string;
    description?: string;
    wcagCriteria?: string[];
  }>;
  touchTargets?: Array<{
    width: number;
    height: number;
    exempt?: boolean;
  }>;
  contrastIssues?: Array<{
    ratio: number;
    isLargeText: boolean;
    element?: string;
  }>;

  // From agent_ready_audit
  agentReadyScore?: number;
  semanticScore?: number;
  ariaScore?: number;
  landmarkScore?: number;
  headingScore?: number;
  formLabelScore?: number;

  // From cognitive_effort CTC
  totalCTC?: number;
  layers?: Array<{ name: string; cost: number }>;
  abandonmentRisk?: number;

  // From page_understand
  pageType?: string;
  elementCount?: number;
  interactiveCount?: number;
  formFieldCount?: number;
  navItemCount?: number;
  linkCount?: number;
  imageCount?: number;
  animationCount?: number;
  hasReducedMotionSupport?: boolean;

  // From attention_analysis
  ctaCaptureRate?: number;
  distractorRatio?: number;
  attentionQualityScore?: number;

  // Text metrics
  avgSentenceLength?: number;
  fleschScore?: number;
  technicalDensity?: number;
  informationDensity?: number;

  url: string;
}

// ============================================================================
// Utility functions
// ============================================================================

/** Clamp value between 0 and 100 */
function clamp(val: number): number {
  return Math.max(0, Math.min(100, val));
}

/** Sigmoid function centered at 0, scaled to [0, 1] */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Weighted average of component scores */
function weightedAvg(components: Array<{ score: number; weight: number }>): number {
  let totalWeight = 0;
  let totalScore = 0;
  for (const c of components) {
    totalScore += c.score * c.weight;
    totalWeight += c.weight;
  }
  return totalWeight > 0 ? totalScore / totalWeight : 50;
}

/** Safe number that defaults if input is null/undefined/NaN */
function safe(val: number | undefined | null, fallback: number): number {
  if (val == null || isNaN(val)) return fallback;
  return val;
}

/** Count barriers of a given type */
function countBarriersByType(
  barriers: CIFInput["barriers"],
  type: string,
): number {
  if (!barriers) return 0;
  return barriers.filter((b) => b.type === type).length;
}

/** Count barriers matching a substring in type or description */
function countBarriersMatching(
  barriers: CIFInput["barriers"],
  pattern: string,
): number {
  if (!barriers) return 0;
  const p = pattern.toLowerCase();
  return barriers.filter(
    (b) =>
      b.type.toLowerCase().includes(p) ||
      (b.description || "").toLowerCase().includes(p),
  ).length;
}

// ============================================================================
// Category Scorers
// ============================================================================

function computeMotorFitness(data: CIFInput): CIFScore["motor"] {
  // --- touchTargetCompliance (30%) ---
  let touchTargetCompliance: CIFComponentScore;
  if (data.touchTargets && data.touchTargets.length > 0) {
    const nonExempt = data.touchTargets.filter((t) => !t.exempt);
    if (nonExempt.length === 0) {
      touchTargetCompliance = { score: 100, details: "All interactive elements are exempt from size requirements" };
    } else {
      const compliant = nonExempt.filter(
        (t) => Math.min(t.width, t.height) >= 44,
      ).length;
      const pct = (compliant / nonExempt.length) * 100;
      touchTargetCompliance = {
        score: clamp(Math.round(pct)),
        details: `${compliant}/${nonExempt.length} interactive elements meet 44px minimum (${Math.round(pct)}%)`,
      };
    }
  } else {
    // Fall back to barrier count as proxy
    const touchBarriers = countBarriersByType(data.barriers, "touch_target");
    touchTargetCompliance = {
      score: clamp(Math.max(30, 100 - touchBarriers * 15)),
      details: touchBarriers > 0
        ? `${touchBarriers} touch target barriers detected (no size data available)`
        : "No touch target data available -- estimated from barriers",
    };
  }

  // --- hitProbability (25%) ---
  let hitProbability: CIFComponentScore;
  if (data.touchTargets && data.touchTargets.length > 0) {
    const nonExempt = data.touchTargets.filter((t) => !t.exempt);
    if (nonExempt.length === 0) {
      hitProbability = { score: 100, details: "No non-exempt interactive elements" };
    } else {
      const avgMinDim =
        nonExempt.reduce((sum, t) => sum + Math.min(t.width, t.height), 0) /
        nonExempt.length;
      const score = sigmoid((avgMinDim - 20) / 10) * 100;
      hitProbability = {
        score: clamp(Math.round(score)),
        details: `Average minimum dimension: ${Math.round(avgMinDim)}px (sigmoid-scored)`,
      };
    }
  } else {
    hitProbability = {
      score: 100,
      details: "No touch target barriers detected",
    };
  }

  // --- interactionCount (20%) ---
  // Under 20 interactive elements is fine; penalize progressively above that
  const interactiveCount = safe(data.interactiveCount, 15);
  const interactionCountScore = interactiveCount <= 20 ? 100
    : interactiveCount <= 40 ? clamp(Math.round(100 - (interactiveCount - 20) * 2.5))
    : clamp(Math.round(50 - (interactiveCount - 40) * 1));
  const interactionCount: CIFComponentScore = {
    score: interactionCountScore,
    details: interactiveCount <= 20
      ? `${interactiveCount} interactive elements — manageable for motor impairments`
      : `${interactiveCount} interactive elements on page (fewer is easier for motor impairments)`,
  };

  // --- spacingAdequacy (15%) ---
  const touchTargetBarriers = countBarriersByType(data.barriers, "touch_target");
  const spacingScore = clamp(Math.round(100 - touchTargetBarriers * 15));
  const spacingAdequacy: CIFComponentScore = {
    score: spacingScore,
    details: touchTargetBarriers > 0
      ? `${touchTargetBarriers} touch target/spacing barriers detected`
      : "No spacing barriers detected",
  };

  // --- dragFreeAlternatives (10%) ---
  const dragBarriers = countBarriersMatching(data.barriers, "drag");
  const dragScore = clamp(100 - dragBarriers * 25);
  const dragFreeAlternatives: CIFComponentScore = {
    score: dragScore,
    details: dragBarriers > 0
      ? `${dragBarriers} drag-dependent interactions found without alternatives`
      : "No drag-dependent interactions detected",
  };

  const components = {
    touchTargetCompliance,
    hitProbability,
    interactionCount,
    spacingAdequacy,
    dragFreeAlternatives,
  };

  const score = clamp(
    Math.round(
      weightedAvg([
        { score: touchTargetCompliance.score, weight: 0.30 },
        { score: hitProbability.score, weight: 0.25 },
        { score: interactionCount.score, weight: 0.20 },
        { score: spacingAdequacy.score, weight: 0.15 },
        { score: dragFreeAlternatives.score, weight: 0.10 },
      ]),
    ),
  );

  return { score, components };
}

function computeVisualFitness(data: CIFInput): CIFScore["visual"] {
  // --- contrastCompliance (30%) ---
  let contrastCompliance: CIFComponentScore;
  if (data.contrastIssues && data.contrastIssues.length > 0) {
    // Use element count as proxy for total text elements
    const totalTextEstimate = Math.max(
      safe(data.elementCount, 50),
      data.contrastIssues.length,
    );
    const failRatio = data.contrastIssues.length / totalTextEstimate;
    const score = clamp(Math.round(100 - failRatio * 100));
    const failingBelow45 = data.contrastIssues.filter(
      (c) => !c.isLargeText && c.ratio < 4.5,
    ).length;
    const failingBelow3 = data.contrastIssues.filter(
      (c) => c.isLargeText && c.ratio < 3,
    ).length;
    contrastCompliance = {
      score,
      details: `${data.contrastIssues.length} contrast issues (${failingBelow45} normal text below 4.5:1, ${failingBelow3} large text below 3:1)`,
    };
  } else {
    // Fall back to contrast barriers
    const contrastBarriers = countBarriersByType(data.barriers, "contrast");
    if (contrastBarriers > 0) {
      contrastCompliance = {
        score: clamp(100 - contrastBarriers * 10),
        details: `${contrastBarriers} contrast barriers detected`,
      };
    } else {
      // Use agent_ready accessibility subscore as proxy
      const accessibilityProxy = safe(data.agentReadyScore, 60);
      contrastCompliance = {
        score: clamp(Math.round(accessibilityProxy * 0.8 + 20)),
        details: "No contrast data -- estimated from agent-ready accessibility score",
      };
    }
  }

  // --- textScalability (20%) ---
  // Assume text scales correctly unless density is very high (which breaks at zoom)
  const density = safe(data.informationDensity, 0.5);
  const scalabilityDeduction = density > 0.6 ? (density - 0.6) * 80 : 0;
  const textScalability: CIFComponentScore = {
    score: clamp(Math.round(100 - scalabilityDeduction)),
    details: scalabilityDeduction > 0
      ? `High density (${(density * 100).toFixed(0)}%) may cause overlap at 200% zoom (-${Math.round(scalabilityDeduction)})`
      : "Text content can scale to 200% without loss of functionality",
  };

  // --- colorIndependence (20%) ---
  const colorOnlyBarriers = countBarriersMatching(data.barriers, "color");
  const colorScore = clamp(100 - colorOnlyBarriers * 20);
  const colorIndependence: CIFComponentScore = {
    score: colorScore,
    details: colorOnlyBarriers > 0
      ? `${colorOnlyBarriers} color-only information barriers detected`
      : "No color-only information barriers detected",
  };

  // --- focusVisibility (15%) ---
  const semanticProxy = safe(data.semanticScore, safe(data.agentReadyScore, 50));
  const focusScore = clamp(Math.round((semanticProxy / 100) * 100));
  const focusVisibility: CIFComponentScore = {
    score: focusScore,
    details: `Estimated from semantic score (${Math.round(semanticProxy)}/100)`,
  };

  // --- spacingDensity (15%) ---
  const spacingDensityScore = clamp(Math.round(100 - density * 100));
  const spacingDensity: CIFComponentScore = {
    score: spacingDensityScore,
    details: `Information density: ${(density * 100).toFixed(0)}% (lower is better for visual processing)`,
  };

  const components = {
    contrastCompliance,
    textScalability,
    colorIndependence,
    focusVisibility,
    spacingDensity,
  };

  const score = clamp(
    Math.round(
      weightedAvg([
        { score: contrastCompliance.score, weight: 0.30 },
        { score: textScalability.score, weight: 0.20 },
        { score: colorIndependence.score, weight: 0.20 },
        { score: focusVisibility.score, weight: 0.15 },
        { score: spacingDensity.score, weight: 0.15 },
      ]),
    ),
  );

  return { score, components };
}

function computeCognitiveFitness(data: CIFInput): CIFScore["cognitive"] {
  // --- decisionComplexity (25%) ---
  let decisionCost = 0;
  if (data.layers && data.layers.length > 0) {
    const decisionLayer = data.layers.find(
      (l) => l.name.toLowerCase().includes("decision") || l.name.toLowerCase().includes("choice"),
    );
    decisionCost = decisionLayer ? decisionLayer.cost : 0;
  }
  const decisionScore = clamp(Math.round(100 - decisionCost * 200));
  const decisionComplexity: CIFComponentScore = {
    score: decisionScore,
    details: decisionCost > 0
      ? `Decision layer cost: ${decisionCost.toFixed(3)} (lower is better)`
      : "No CTC decision layer data available",
  };

  // --- readability (20%) ---
  const flesch = data.fleschScore;
  const readabilityScore = flesch != null
    ? clamp(Math.round(Math.min(100, flesch * 1.2)))
    : 85; // No data = assume reasonable readability
  const readability: CIFComponentScore = {
    score: readabilityScore,
    details: flesch != null
      ? `Flesch readability score: ${Math.round(flesch)} (higher = more readable)`
      : "No readability data available — estimated 85",
  };

  // --- informationDensity (20%) ---
  // A well-structured page can have many elements without being overwhelming.
  // Only penalize when element count is extremely high relative to viewport.
  // Threshold: 200 elements is fine, 500+ starts getting dense, 2000+ is overwhelming.
  const elemCount = safe(data.elementCount, 100);
  const infoScore = elemCount <= 200 ? 100
    : elemCount <= 500 ? clamp(Math.round(100 - (elemCount - 200) / 6))
    : clamp(Math.round(50 - (elemCount - 500) / 30));
  const informationDensity: CIFComponentScore = {
    score: infoScore,
    details: elemCount <= 200
      ? `${elemCount} elements — well within cognitive limits`
      : `${elemCount} elements on page (progressive penalty above 200)`,
  };

  // --- attentionClarity (20%) ---
  const captureRate = data.ctaCaptureRate;
  const attentionScore = captureRate != null
    ? clamp(Math.round(Math.min(100, captureRate * 200)))
    : 80; // No data = assume reasonable CTA clarity
  const attentionClarity: CIFComponentScore = {
    score: attentionScore,
    details: captureRate != null
      ? `CTA capture rate: ${(captureRate * 100).toFixed(1)}% (higher = clearer attention guidance)`
      : "No attention data available — estimated 80",
  };

  // --- predictability (15%) ---
  const navItems = safe(data.navItemCount, 5);
  let predictScore: number;
  if (navItems <= 7) {
    predictScore = 100;
  } else if (navItems <= 12) {
    predictScore = clamp(Math.round(100 - (navItems - 7) * 5));
  } else {
    predictScore = clamp(Math.round(75 - (navItems - 12) * 5));
  }
  const predictability: CIFComponentScore = {
    score: predictScore,
    details: navItems <= 7
      ? `${navItems} navigation items — clear, predictable structure`
      : `${navItems} navigation items (7 or fewer is optimal for cognitive predictability)`,
  };

  const components = {
    decisionComplexity,
    readability,
    informationDensity,
    attentionClarity,
    predictability,
  };

  const score = clamp(
    Math.round(
      weightedAvg([
        { score: decisionComplexity.score, weight: 0.25 },
        { score: readability.score, weight: 0.20 },
        { score: informationDensity.score, weight: 0.20 },
        { score: attentionClarity.score, weight: 0.20 },
        { score: predictability.score, weight: 0.15 },
      ]),
    ),
  );

  return { score, components };
}

function computeSensoryFitness(data: CIFInput): CIFScore["sensory"] {
  // --- animationControl (30%) ---
  const animCount = safe(data.animationCount, 0);
  const hasMotionSupport = !!data.hasReducedMotionSupport;
  // If prefers-reduced-motion is supported, animations are user-controllable → score 95 (not 100, small tax for having them at all)
  // Without support, each animation is a hard penalty
  const animScore = hasMotionSupport
    ? clamp(Math.max(90, 100 - animCount))  // 90-100 range — minor tax for quantity
    : animCount === 0 ? 100 : clamp(Math.round(100 - animCount * 20));
  const animationControl: CIFComponentScore = {
    score: animScore,
    details: animCount === 0
      ? "No animations detected"
      : hasMotionSupport
        ? `${animCount} animations detected — prefers-reduced-motion supported (user can disable)`
        : `${animCount} animations detected without motion preference support (each deducts 20 points)`,
  };

  // --- sensoryIndependence (25%) ---
  const captionBarriers = countBarriersMatching(data.barriers, "caption");
  const audioBarriers = countBarriersMatching(data.barriers, "audio");
  const sensoryDeductions = (captionBarriers + audioBarriers) * 15;
  const sensoryScore = clamp(100 - sensoryDeductions);
  const sensoryIndependence: CIFComponentScore = {
    score: sensoryScore,
    details: sensoryDeductions > 0
      ? `${captionBarriers + audioBarriers} audio/caption barriers (each deducts 15)`
      : "No audio/caption accessibility barriers detected",
  };

  // --- visualCalm (20%) ---
  const density = safe(data.informationDensity, 0.5);
  // If animations are user-controllable, they don't contribute to visual noise
  const animCalmPenalty = hasMotionSupport ? 0 : animCount * 15;
  const calmScore = clamp(Math.round(100 - density * 50 - animCalmPenalty));
  const visualCalm: CIFComponentScore = {
    score: calmScore,
    details: hasMotionSupport
      ? `Information density: ${(density * 100).toFixed(0)}% (animations controllable via prefers-reduced-motion)`
      : `Information density: ${(density * 100).toFixed(0)}%, ${animCount} uncontrolled animations`,
  };

  // --- layoutConsistency (15%) ---
  const agentReady = safe(data.agentReadyScore, 70);
  const consistencyScore = clamp(Math.round(agentReady));
  const layoutConsistency: CIFComponentScore = {
    score: consistencyScore,
    details: `Layout consistency derived from structural score (${Math.round(agentReady)}/100)`,
  };

  // --- overloadThreshold (10%) ---
  // CTC ≤ 0.3 is "easy" per our scale, 0.3-0.6 moderate, 0.6-1.0 hard, >1.0 very hard
  const totalCTC = safe(data.totalCTC, 0.3);
  const overloadScore = totalCTC <= 0.3 ? 100
    : totalCTC <= 0.6 ? clamp(Math.round(100 - (totalCTC - 0.3) * 130))
    : clamp(Math.round(60 - (totalCTC - 0.6) * 100));
  const overloadThreshold: CIFComponentScore = {
    score: overloadScore,
    details: totalCTC <= 0.3 ? `Total CTC: ${totalCTC.toFixed(3)} — within easy range`
      : `Total CTC: ${totalCTC.toFixed(3)} (lower = less cognitive overload risk)`,
  };

  const components = {
    animationControl,
    sensoryIndependence,
    visualCalm,
    layoutConsistency,
    overloadThreshold,
  };

  const score = clamp(
    Math.round(
      weightedAvg([
        { score: animationControl.score, weight: 0.30 },
        { score: sensoryIndependence.score, weight: 0.25 },
        { score: visualCalm.score, weight: 0.20 },
        { score: layoutConsistency.score, weight: 0.15 },
        { score: overloadThreshold.score, weight: 0.10 },
      ]),
    ),
  );

  return { score, components };
}

function computeNavigationFitness(data: CIFInput): CIFScore["navigation"] {
  // --- semanticStructure (25%) ---
  const subScores: number[] = [];
  if (data.semanticScore != null) subScores.push(data.semanticScore);
  if (data.headingScore != null) subScores.push(data.headingScore);
  if (data.landmarkScore != null) subScores.push(data.landmarkScore);
  const semanticAvg =
    subScores.length > 0
      ? subScores.reduce((a, b) => a + b, 0) / subScores.length
      : safe(data.agentReadyScore, 50);
  const semanticStructure: CIFComponentScore = {
    score: clamp(Math.round(semanticAvg)),
    details: subScores.length > 0
      ? `Average of ${subScores.length} semantic sub-scores: ${Math.round(semanticAvg)}/100`
      : `Estimated from agent-ready score: ${Math.round(semanticAvg)}/100`,
  };

  // --- keyboardOperability (25%) ---
  const keyboardBarriers = countBarriersMatching(data.barriers, "keyboard");
  const motorPrecision = countBarriersByType(data.barriers, "motor_precision");
  const kbDeductions = (keyboardBarriers + motorPrecision) * 15;
  const kbScore = clamp(100 - kbDeductions);
  const keyboardOperability: CIFComponentScore = {
    score: kbScore,
    details: kbDeductions > 0
      ? `${keyboardBarriers + motorPrecision} keyboard/motor barriers detected`
      : "No keyboard accessibility barriers detected",
  };

  // --- skipMechanisms (15%) ---
  const skipBarriers = countBarriersMatching(data.barriers, "skip");
  const skipScore = clamp(100 - skipBarriers * 25);
  const skipMechanisms: CIFComponentScore = {
    score: skipScore,
    details: skipBarriers > 0
      ? `${skipBarriers} skip mechanism issues detected`
      : "No skip navigation issues detected",
  };

  // --- linkButtonClarity (15%) ---
  const ariaProxy = safe(data.ariaScore, 50);
  const linkButtonClarity: CIFComponentScore = {
    score: clamp(Math.round(ariaProxy)),
    details: `ARIA label score: ${Math.round(ariaProxy)}/100`,
  };

  // --- formAccessibility (20%) ---
  let formScore = safe(data.formLabelScore, 60);
  const formBarriers = countBarriersMatching(data.barriers, "form");
  formScore = clamp(formScore - formBarriers * 10);
  const formAccessibility: CIFComponentScore = {
    score: clamp(Math.round(formScore)),
    details: formBarriers > 0
      ? `Form label score: ${Math.round(safe(data.formLabelScore, 60))}/100, ${formBarriers} form barriers`
      : `Form label score: ${Math.round(safe(data.formLabelScore, 60))}/100`,
  };

  const components = {
    semanticStructure,
    keyboardOperability,
    skipMechanisms,
    linkButtonClarity,
    formAccessibility,
  };

  const score = clamp(
    Math.round(
      weightedAvg([
        { score: semanticStructure.score, weight: 0.25 },
        { score: keyboardOperability.score, weight: 0.25 },
        { score: skipMechanisms.score, weight: 0.15 },
        { score: linkButtonClarity.score, weight: 0.15 },
        { score: formAccessibility.score, weight: 0.20 },
      ]),
    ),
  );

  return { score, components };
}

// ============================================================================
// Grading & Certification
// ============================================================================

function computeGrade(composite: number): string {
  if (composite >= 95) return "A+";
  if (composite >= 85) return "A";
  if (composite >= 70) return "B";
  if (composite >= 50) return "C";
  if (composite >= 30) return "D";
  return "F";
}

function computeCertification(
  motor: number,
  visual: number,
  cognitive: number,
  sensory: number,
  navigation: number,
): string {
  const all = [motor, visual, cognitive, sensory, navigation];
  const minScore = Math.min(...all);
  if (minScore >= 95) return "platinum";
  if (minScore >= 85) return "gold";
  if (minScore >= 70) return "silver";
  if (minScore >= 50) return "bronze";
  return "none";
}

// ============================================================================
// Fix Recommendations
// ============================================================================

function generateFixRecommendation(
  category: string,
  component: string,
  score: number,
  data: CIFInput,
): string {
  const key = `${category}.${component}`;
  switch (key) {
    case "motor.touchTargetCompliance": {
      const count = data.touchTargets
        ? data.touchTargets.filter((t) => !t.exempt && Math.min(t.width, t.height) < 44).length
        : countBarriersByType(data.barriers, "touch_target");
      return `Increase ${count || "undersized"} interactive element sizes to at least 44x44px (WCAG 2.5.5 AAA)`;
    }
    case "motor.hitProbability":
      return "Increase average interactive element dimensions -- target 48px minimum for reliable motor access";
    case "motor.interactionCount":
      return `Reduce interactive elements from ${safe(data.interactiveCount, 0)} to under 30 on a single view`;
    case "motor.spacingAdequacy":
      return "Add at least 8px spacing between adjacent interactive elements to prevent mis-taps";
    case "motor.dragFreeAlternatives":
      return "Provide keyboard/click alternatives for all drag-and-drop interactions";

    case "visual.contrastCompliance": {
      const count = data.contrastIssues?.length || countBarriersByType(data.barriers, "contrast");
      return `Fix ${count} elements with contrast ratios below 4.5:1 for normal text or 3:1 for large text`;
    }
    case "visual.textScalability":
      return "Ensure text scales to 200% without loss of content or functionality (WCAG 1.4.4)";
    case "visual.colorIndependence":
      return "Add non-color indicators (icons, patterns, text labels) wherever color conveys meaning";
    case "visual.focusVisibility":
      return "Ensure all interactive elements have visible focus indicators with at least 3:1 contrast";
    case "visual.spacingDensity":
      return "Increase whitespace between content blocks -- reduce information density below 60%";

    case "cognitive.decisionComplexity": {
      const choices = safe(data.interactiveCount, 0);
      if (choices > 10) {
        return `Reduce choices from ${choices} to 5-7 options per decision point (Hick's Law)`;
      }
      return "Simplify decision points -- group related options, provide defaults, reduce choices per step";
    }
    case "cognitive.readability":
      return `Simplify text to 8th-grade reading level (current Flesch: ${Math.round(safe(data.fleschScore, 0))})`;
    case "cognitive.informationDensity":
      return `Reduce visible elements from ${safe(data.elementCount, 0)} -- use progressive disclosure to reveal content incrementally`;
    case "cognitive.attentionClarity":
      return "Make primary CTA visually dominant -- increase size, contrast, and whitespace around conversion elements";
    case "cognitive.predictability":
      return `Reduce navigation items from ${safe(data.navItemCount, 0)} to 7 or fewer -- group secondary items in submenus`;

    case "sensory.animationControl":
      return `Add prefers-reduced-motion support for ${safe(data.animationCount, 0)} animations and provide pause controls`;
    case "sensory.sensoryIndependence":
      return "Add captions/transcripts for all audio and video content";
    case "sensory.visualCalm":
      return "Reduce visual noise -- fewer animations, lower information density, more whitespace";
    case "sensory.layoutConsistency":
      return "Standardize layout patterns -- consistent nav placement, predictable content regions";
    case "sensory.overloadThreshold":
      return "Reduce total cognitive load -- simplify page structure, reduce simultaneous information streams";

    case "navigation.semanticStructure":
      return "Add proper heading hierarchy (h1-h6), landmark roles, and semantic HTML elements";
    case "navigation.keyboardOperability":
      return "Ensure all interactive elements are keyboard-accessible with logical tab order";
    case "navigation.skipMechanisms":
      return "Add skip-to-content links at the top of the page for keyboard/screen reader users";
    case "navigation.linkButtonClarity":
      return "Add descriptive ARIA labels to all links and buttons -- avoid 'click here' or icon-only controls";
    case "navigation.formAccessibility":
      return "Associate every form field with a visible label using <label for> or aria-labelledby";

    default:
      return `Improve ${component} in ${category} category (current score: ${score}/100)`;
  }
}

// ============================================================================
// Top Issues
// ============================================================================

function buildTopIssues(
  motor: CIFScore["motor"],
  visual: CIFScore["visual"],
  cognitive: CIFScore["cognitive"],
  sensory: CIFScore["sensory"],
  navigation: CIFScore["navigation"],
  data: CIFInput,
): CIFScore["topIssues"] {
  const allComponents: Array<{
    category: string;
    component: string;
    score: number;
  }> = [];

  for (const [name, val] of Object.entries(motor.components)) {
    allComponents.push({ category: "motor", component: name, score: val.score });
  }
  for (const [name, val] of Object.entries(visual.components)) {
    allComponents.push({ category: "visual", component: name, score: val.score });
  }
  for (const [name, val] of Object.entries(cognitive.components)) {
    allComponents.push({ category: "cognitive", component: name, score: val.score });
  }
  for (const [name, val] of Object.entries(sensory.components)) {
    allComponents.push({ category: "sensory", component: name, score: val.score });
  }
  for (const [name, val] of Object.entries(navigation.components)) {
    allComponents.push({ category: "navigation", component: name, score: val.score });
  }

  // Sort by score ascending (worst first)
  allComponents.sort((a, b) => a.score - b.score);

  // Return top 5
  return allComponents.slice(0, 5).map((c) => ({
    category: c.category,
    component: c.component,
    score: c.score,
    fix: generateFixRecommendation(c.category, c.component, c.score, data),
  }));
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Compute the CIF (Cognitive Interface Fitness) score from raw tool data.
 *
 * Accepts data from empathy_audit, agent_ready_audit, cognitive_effort CTC,
 * page_understand, and attention_analysis. All fields are optional --
 * missing data produces conservative estimates with lower confidence.
 */
export function computeCIFScore(data: CIFInput): CIFScore {
  const motor = computeMotorFitness(data);
  const visual = computeVisualFitness(data);
  const cognitive = computeCognitiveFitness(data);
  const sensory = computeSensoryFitness(data);
  const navigation = computeNavigationFitness(data);

  const composite = clamp(
    Math.round(
      0.20 * motor.score +
        0.20 * visual.score +
        0.25 * cognitive.score +
        0.15 * sensory.score +
        0.20 * navigation.score,
    ),
  );

  const grade = computeGrade(composite);
  const certification = computeCertification(
    motor.score,
    visual.score,
    cognitive.score,
    sensory.score,
    navigation.score,
  );

  const topIssues = buildTopIssues(motor, visual, cognitive, sensory, navigation, data);

  return {
    composite,
    grade,
    certification,
    motor,
    visual,
    cognitive,
    sensory,
    navigation,
    topIssues,
    url: data.url,
    timestamp: new Date().toISOString(),
  };
}
