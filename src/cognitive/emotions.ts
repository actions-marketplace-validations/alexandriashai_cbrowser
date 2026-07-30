/**
 * CBrowser - Cognitive Browser Automation
 * Copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com
 * Learn more at https://cbrowser.ai - MIT License
 */

/**
 * Emotional State Engine for Cognitive Browser Automation
 *
 * Implements emotional state modeling based on:
 * - Scherer's Component Process Model of Emotion (2001)
 * - Russell's Circumplex Model of Affect (1980)
 * - Ortony, Clore & Collins (OCC) Model (1988)
 *
 * Emotions affect:
 * - Abandonment thresholds
 * - Exploration behavior
 * - Decision-making speed
 * - Error recovery
 */

import type {
  EmotionalState,
  EmotionalEvent,
  EmotionalTrigger,
  EmotionalConfig,
  EmotionType,
  CognitiveTraits,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

/** Default decay rate per step (emotions decay toward baseline) */
const DEFAULT_DECAY_RATE = 0.15;

/** Default sensitivity to emotional events */
const DEFAULT_SENSITIVITY = 1.0;

/** Minimum change to register as an event */
const DEFAULT_CHANGE_THRESHOLD = 0.05;

/** Emotion valence values (-1 to +1) */
const EMOTION_VALENCE: Record<EmotionType, number> = {
  anxiety: -0.7,
  frustration: -0.8,
  boredom: -0.4,
  confusion: -0.5,
  satisfaction: 0.7,
  excitement: 0.8,
  relief: 0.5,
  neutral: 0,
};

/** Emotion arousal values (0 to 1) */
const EMOTION_AROUSAL: Record<EmotionType, number> = {
  anxiety: 0.8,
  frustration: 0.7,
  boredom: 0.2,
  confusion: 0.5,
  satisfaction: 0.5,
  excitement: 0.9,
  relief: 0.3,
  neutral: 0.3,
};

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an initial emotional state based on persona traits.
 *
 * - Low patience → higher baseline anxiety
 * - High curiosity → higher baseline excitement
 * - Low resilience → higher sensitivity to frustration
 */
export function createInitialEmotionalState(
  traits?: Partial<CognitiveTraits>
): EmotionalState {
  const patience = traits?.patience ?? 0.5;
  const curiosity = traits?.curiosity ?? 0.5;
  const resilience = traits?.resilience ?? 0.5;
  const selfEfficacy = traits?.selfEfficacy ?? 0.5;

  // Baseline emotions influenced by traits
  const baseAnxiety = Math.max(0, 0.1 + (1 - patience) * 0.2 + (1 - selfEfficacy) * 0.15);
  const baseExcitement = Math.max(0, curiosity * 0.2);
  const baseBoredom = Math.max(0, (1 - curiosity) * 0.1);

  const state: EmotionalState = {
    anxiety: Math.min(1, baseAnxiety),
    frustration: 0,
    boredom: Math.min(1, baseBoredom),
    confusion: 0,
    satisfaction: 0.1, // Slight initial optimism
    excitement: Math.min(1, baseExcitement),
    relief: 0,
    dominant: "neutral",
    valence: 0,
    arousal: 0.3,
  };

  // Calculate derived values
  updateDerivedValues(state);

  return state;
}

/**
 * Create emotional configuration based on persona traits.
 */
export function createEmotionalConfig(
  traits?: Partial<CognitiveTraits>
): EmotionalConfig {
  const resilience = traits?.resilience ?? 0.5;
  const patience = traits?.patience ?? 0.5;

  return {
    baseline: createInitialEmotionalState(traits),
    // High resilience = faster emotional recovery
    decayRate: DEFAULT_DECAY_RATE * (0.5 + resilience * 0.5),
    // Low patience = higher emotional sensitivity
    sensitivity: DEFAULT_SENSITIVITY * (1.5 - patience * 0.5),
    changeThreshold: DEFAULT_CHANGE_THRESHOLD,
  };
}

// ============================================================================
// Emotion Updates
// ============================================================================

/**
 * Apply an emotional trigger event to the current state.
 * Returns the new state and the event record.
 */
export function applyEmotionalTrigger(
  state: EmotionalState,
  trigger: EmotionalTrigger,
  config: EmotionalConfig,
  stepNumber: number,
  context?: { severity?: number; description?: string }
): { state: EmotionalState; event: EmotionalEvent } {
  const severity = context?.severity ?? 1.0;
  const sensitivity = config.sensitivity * severity;

  // Calculate emotion changes based on trigger
  const changes = calculateTriggerEffects(trigger, sensitivity);

  // Apply changes to state
  const newState = { ...state };
  for (const [emotion, delta] of Object.entries(changes)) {
    const key = emotion as keyof EmotionalState;
    if (typeof newState[key] === "number") {
      newState[key as keyof Omit<EmotionalState, "dominant" | "valence" | "arousal">] = Math.max(
        0,
        Math.min(1, (newState[key] as number) + delta)
      );
    }
  }

  // Update derived values
  updateDerivedValues(newState);

  // Create event record
  const event: EmotionalEvent = {
    timestamp: Date.now(),
    trigger,
    changes,
    description: context?.description ?? getDefaultTriggerDescription(trigger),
    stepNumber,
  };

  return { state: newState, event };
}

/**
 * Decay emotions toward baseline over time.
 * Should be called each step.
 */
export function decayEmotions(
  state: EmotionalState,
  config: EmotionalConfig
): EmotionalState {
  const baseline = config.baseline;
  const decayRate = config.decayRate;

  const newState = { ...state };

  // Decay each emotion toward its baseline
  const emotions: (keyof EmotionalState)[] = [
    "anxiety",
    "frustration",
    "boredom",
    "confusion",
    "satisfaction",
    "excitement",
    "relief",
  ];

  for (const emotion of emotions) {
    const current = newState[emotion] as number;
    const base = (baseline[emotion] as number | undefined) ?? 0;
    const diff = base - current;

    // Move toward baseline by decay rate
    newState[emotion as keyof Omit<EmotionalState, "dominant" | "valence" | "arousal">] =
      current + diff * decayRate;
  }

  updateDerivedValues(newState);

  return newState;
}

// ============================================================================
// Trigger Effect Calculations
// ============================================================================

/**
 * Calculate emotion changes for a given trigger.
 */
function calculateTriggerEffects(
  trigger: EmotionalTrigger,
  sensitivity: number
): Partial<Record<EmotionType, number>> {
  const s = sensitivity;

  switch (trigger) {
    case "success":
      return {
        satisfaction: 0.2 * s,
        excitement: 0.1 * s,
        frustration: -0.15 * s,
        anxiety: -0.1 * s,
        confusion: -0.1 * s,
      };

    case "failure":
      return {
        frustration: 0.25 * s,
        anxiety: 0.15 * s,
        satisfaction: -0.1 * s,
        excitement: -0.05 * s,
      };

    case "error":
      return {
        anxiety: 0.3 * s,
        frustration: 0.2 * s,
        confusion: 0.15 * s,
        satisfaction: -0.15 * s,
      };

    case "progress":
      return {
        satisfaction: 0.15 * s,
        excitement: 0.1 * s,
        boredom: -0.1 * s,
        frustration: -0.05 * s,
      };

    case "setback":
      return {
        frustration: 0.2 * s,
        anxiety: 0.1 * s,
        satisfaction: -0.15 * s,
        excitement: -0.1 * s,
      };

    case "waiting":
      return {
        boredom: 0.15 * s,
        frustration: 0.05 * s,
        excitement: -0.05 * s,
      };

    case "discovery":
      return {
        excitement: 0.25 * s,
        satisfaction: 0.1 * s,
        boredom: -0.2 * s,
      };

    case "completion":
      return {
        satisfaction: 0.3 * s,
        relief: 0.2 * s,
        excitement: 0.05 * s,
        frustration: -0.2 * s,
        anxiety: -0.15 * s,
      };

    case "confusion_onset":
      return {
        confusion: 0.25 * s,
        anxiety: 0.1 * s,
        frustration: 0.1 * s,
        satisfaction: -0.1 * s,
      };

    case "clarity":
      return {
        confusion: -0.2 * s,
        relief: 0.15 * s,
        satisfaction: 0.1 * s,
        anxiety: -0.1 * s,
      };

    case "time_pressure":
      return {
        anxiety: 0.25 * s,
        frustration: 0.1 * s,
        boredom: -0.1 * s,
      };

    case "recovery":
      return {
        relief: 0.25 * s,
        satisfaction: 0.1 * s,
        frustration: -0.15 * s,
        anxiety: -0.2 * s,
      };

    default:
      return {};
  }
}

/**
 * Get default description for a trigger.
 */
function getDefaultTriggerDescription(trigger: EmotionalTrigger): string {
  const descriptions: Record<EmotionalTrigger, string> = {
    success: "Action completed successfully",
    failure: "Action failed to complete",
    error: "System error occurred",
    progress: "Made progress toward goal",
    setback: "Lost progress or took wrong path",
    waiting: "Waited for page or element",
    discovery: "Discovered something interesting",
    completion: "Completed a sub-goal",
    confusion_onset: "Became confused by UI",
    clarity: "UI became clearer",
    time_pressure: "Running low on patience",
    recovery: "Recovered from error or setback",
  };
  return descriptions[trigger];
}

// ============================================================================
// Derived Value Calculations
// ============================================================================

/** Emotions that have numeric values on EmotionalState (excludes 'neutral') */
type NumericEmotionType = Exclude<EmotionType, "neutral">;

/**
 * Update derived values (dominant, valence, arousal) based on emotion intensities.
 */
function updateDerivedValues(state: EmotionalState): void {
  const emotions: NumericEmotionType[] = [
    "anxiety",
    "frustration",
    "boredom",
    "confusion",
    "satisfaction",
    "excitement",
    "relief",
  ];

  // Find dominant emotion
  let maxIntensity = 0;
  let dominant: EmotionType = "neutral";

  for (const emotion of emotions) {
    const intensity = state[emotion];
    if (intensity > maxIntensity) {
      maxIntensity = intensity;
      dominant = emotion;
    }
  }

  // If no emotion is significant, default to neutral
  if (maxIntensity < 0.15) {
    dominant = "neutral";
  }

  state.dominant = dominant;

  // Calculate weighted valence and arousal
  let totalWeight = 0;
  let weightedValence = 0;
  let weightedArousal = 0;

  for (const emotion of emotions) {
    const intensity = state[emotion];
    if (intensity > 0.05) {
      totalWeight += intensity;
      weightedValence += intensity * EMOTION_VALENCE[emotion];
      weightedArousal += intensity * EMOTION_AROUSAL[emotion];
    }
  }

  if (totalWeight > 0) {
    state.valence = weightedValence / totalWeight;
    state.arousal = weightedArousal / totalWeight;
  } else {
    state.valence = 0;
    state.arousal = 0.3;
  }
}

// ============================================================================
// Behavioral Effects
// ============================================================================

/**
 * Calculate abandonment risk modifier based on emotional state.
 *
 * Returns a multiplier:
 * - < 1.0 = less likely to abandon (positive emotions)
 * - > 1.0 = more likely to abandon (negative emotions)
 */
export function calculateAbandonmentModifier(state: EmotionalState): number {
  // Negative emotions increase abandonment risk
  const negativeLoad =
    state.anxiety * 0.3 +
    state.frustration * 0.35 +
    state.boredom * 0.25 +
    state.confusion * 0.2;

  // Positive emotions decrease abandonment risk
  const positiveLoad =
    state.satisfaction * 0.3 +
    state.excitement * 0.25 +
    state.relief * 0.15;

  // Base modifier is 1.0 (no change)
  // Negative emotions increase it, positive emotions decrease it
  const modifier = 1.0 + negativeLoad - positiveLoad * 0.7;

  // Clamp to reasonable range
  return Math.max(0.5, Math.min(2.0, modifier));
}

/**
 * Calculate exploration tendency based on emotional state.
 *
 * Returns 0-1:
 * - Low = stays on current path
 * - High = willing to explore
 */
export function calculateExplorationTendency(state: EmotionalState): number {
  // Excitement and satisfaction encourage exploration
  const positive = state.excitement * 0.4 + state.satisfaction * 0.3 + state.relief * 0.1;

  // Anxiety and frustration discourage exploration
  const negative = state.anxiety * 0.4 + state.frustration * 0.3 + state.confusion * 0.2;

  // Boredom can go either way - might explore out of boredom or give up
  const boredomEffect = state.boredom > 0.5 ? state.boredom * 0.2 : 0;

  const tendency = 0.5 + positive - negative + boredomEffect;

  return Math.max(0, Math.min(1, tendency));
}

/**
 * Calculate decision speed modifier based on emotional state.
 *
 * Returns a multiplier for decision time:
 * - < 1.0 = faster decisions (excitement, impatience from frustration)
 * - > 1.0 = slower decisions (anxiety, confusion)
 */
export function calculateDecisionSpeedModifier(state: EmotionalState): number {
  // Anxiety and confusion slow decisions
  const slowingFactors = state.anxiety * 0.3 + state.confusion * 0.4;

  // High frustration can lead to impulsive fast decisions
  const impulsiveFactor = state.frustration > 0.6 ? (state.frustration - 0.6) * 0.5 : 0;

  // Excitement slightly speeds up decisions
  const speedingFactor = state.excitement * 0.2 + impulsiveFactor;

  const modifier = 1.0 + slowingFactors - speedingFactor;

  return Math.max(0.5, Math.min(2.0, modifier));
}

/**
 * Get a human-readable description of the current emotional state.
 */
export function describeEmotionalState(state: EmotionalState): string {
  const dominant = state.dominant;
  const intensity = state[dominant as keyof EmotionalState] as number;

  if (dominant === "neutral" || intensity < 0.15) {
    return "Feeling neutral and calm";
  }

  const intensityWord =
    intensity > 0.7 ? "very" : intensity > 0.4 ? "somewhat" : "slightly";

  const emotionDescriptions: Record<EmotionType, string> = {
    anxiety: "anxious about completing this task",
    frustration: "frustrated with the experience",
    boredom: "bored and losing interest",
    confusion: "confused about what to do",
    satisfaction: "satisfied with progress",
    excitement: "excited and engaged",
    relief: "relieved after overcoming obstacles",
    neutral: "neutral and calm",
  };

  let description = `Feeling ${intensityWord} ${emotionDescriptions[dominant]}`;

  // Add secondary emotion if significant
  const emotions: NumericEmotionType[] = [
    "anxiety",
    "frustration",
    "boredom",
    "confusion",
    "satisfaction",
    "excitement",
    "relief",
  ];

  for (const emotion of emotions) {
    if (emotion !== dominant) {
      const secondaryIntensity = state[emotion];
      if (secondaryIntensity > 0.3) {
        description += `, with some ${emotion}`;
        break;
      }
    }
  }

  return description;
}

/**
 * Determine if the emotional state should trigger abandonment consideration.
 */
export function shouldConsiderAbandonment(state: EmotionalState): {
  shouldConsider: boolean;
  reason?: string;
} {
  // High frustration is a strong abandonment signal
  if (state.frustration > 0.8) {
    return { shouldConsider: true, reason: "Extreme frustration" };
  }

  // High anxiety + low satisfaction
  if (state.anxiety > 0.7 && state.satisfaction < 0.2) {
    return { shouldConsider: true, reason: "High anxiety with no satisfaction" };
  }

  // Boredom + frustration combo
  if (state.boredom > 0.6 && state.frustration > 0.5) {
    return { shouldConsider: true, reason: "Bored and frustrated" };
  }

  // Confusion without relief
  if (state.confusion > 0.7 && state.relief < 0.2) {
    return { shouldConsider: true, reason: "Persistently confused" };
  }

  // Very negative valence
  if (state.valence < -0.6 && state.arousal > 0.6) {
    return { shouldConsider: true, reason: "Strong negative emotional state" };
  }

  return { shouldConsider: false };
}

// ============================================================================
// Single Source of Truth — derived simplified-state view
// ============================================================================
//
// The simulator and its consumers (worker, dashboard, MCP tools) read three
// "simple" fields off the journey state: patienceRemaining, confusionLevel,
// and frustrationLevel. Historically those were maintained INDEPENDENTLY of
// the Scherer EmotionalState, producing two emotional truths that drifted
// every step. These helpers make the simple fields *derived views* of the
// canonical EmotionalState, so there's only one source of truth.
//
// Persona traits modulate update rates here, not just thresholds:
//   - patience trait → drainMultiplier applied to negative-emotion contribution
//   - comprehension → confusion decay rate
//   - resilience    → frustration decay rate
//   - curiosity     → boredom decay rate
//
// Net effect: an impatient user (patience=0.2) burns through patience meaningfully
// faster than a patient user (0.9) given the same emotional trajectory, instead
// of burning the same and only differing in the cutoff threshold.

/**
 * Compute the simulator's gating-layer view of patience/confusion/frustration
 * from the canonical EmotionalState. Persona traits modulate the patience
 * derivation so the same emotional trajectory drains different personas at
 * different rates.
 *
 * Confusion and frustration are direct mappings (the EmotionalState fields
 * are the ground truth). Patience is computed: high frustration / boredom /
 * anxiety drain it; satisfaction and excitement buffer it; the persona's
 * `patience` trait scales the drain.
 */
export function deriveSimplifiedState(
  emotional: EmotionalState,
  traits?: Partial<CognitiveTraits>,
): { patienceRemaining: number; confusionLevel: number; frustrationLevel: number } {
  const confusionLevel = emotional.confusion;
  const frustrationLevel = emotional.frustration;

  // Negative-emotion drain: take the dominant negative emotion (frustration
  // weighs full, boredom weighs less because it's lower-arousal, anxiety lies
  // between).
  const negativeFactor = Math.max(
    emotional.frustration,
    emotional.boredom * 0.6,
    emotional.anxiety * 0.5,
  );

  // Persona patience trait scales the burn rate.
  // patience=1.0 → drainMultiplier ≈ 0.77 (slow burn)
  // patience=0.5 → drainMultiplier ≈ 1.54 (1x baseline)
  // patience=0.2 → drainMultiplier ≈ 3.85 (impatient burns through fast)
  // Floor at 0.2 prevents division-by-zero for malformed traits.
  const patienceTrait = Math.max(0.2, traits?.patience ?? 0.5);
  const drainMultiplier = 1 / (patienceTrait * 1.3);

  // Positive emotions buffer the drain — a satisfied / excited persona is
  // more willing to keep trying through friction.
  const positiveBuffer = (emotional.satisfaction + emotional.excitement * 0.7) * 0.3;

  const patienceRemaining = Math.max(
    0,
    Math.min(1, 1 - negativeFactor * drainMultiplier + positiveBuffer),
  );

  return { patienceRemaining, confusionLevel, frustrationLevel };
}

/**
 * Decay emotions toward their baseline, with persona-trait-modulated rates.
 * Replaces the legacy uniform `decayEmotions` for the journey simulator —
 * trait-aware decay means a persona with high comprehension forgets confusion
 * faster than one with low comprehension, instead of both decaying at the
 * same uniform rate.
 *
 * Decay multipliers per emotion:
 *   confusion   ← comprehension trait (forgets confusion when they "get it")
 *   frustration ← resilience trait (recovers from setbacks faster)
 *   boredom     ← curiosity trait (curious users tolerate slow flows)
 *   anxiety     ← uniform (no single trait clearly maps; intentional)
 *   satisfaction, excitement, relief ← decay slowly (positive states are sticky)
 */
export function decayEmotionsWithTraits(
  state: EmotionalState,
  config: EmotionalConfig,
  traits?: Partial<CognitiveTraits>,
): EmotionalState {
  const newState = { ...state };
  const baseDecay = config.decayRate;

  // Trait values default to 0.5 (moderate) when absent
  const comprehension = traits?.comprehension ?? 0.5;
  const resilience = traits?.resilience ?? 0.5;
  const curiosity = traits?.curiosity ?? 0.5;

  // Decay rate multipliers — 0.5x at trait=0, 2.0x at trait=1
  const decayMultipliers: Record<EmotionType, number> = {
    confusion: 0.5 + comprehension * 1.5,
    frustration: 0.5 + resilience * 1.5,
    boredom: 0.5 + curiosity * 1.5,
    anxiety: 1.0,
    satisfaction: 0.5,
    excitement: 0.7,
    relief: 1.0,
    neutral: 0,
  };

  const emotions: (keyof Omit<EmotionalState, "dominant" | "valence" | "arousal">)[] = [
    "anxiety",
    "frustration",
    "boredom",
    "confusion",
    "satisfaction",
    "excitement",
    "relief",
  ];

  for (const emotion of emotions) {
    const baseline = (config.baseline[emotion] as number | undefined) ?? 0;
    const current = newState[emotion];
    const rate = baseDecay * decayMultipliers[emotion];
    // Move toward baseline by `rate` fraction of the gap each step.
    newState[emotion] = current + (baseline - current) * rate;
  }

  // Re-derive dominant + valence + arousal from new emotion intensities.
  // Use the existing helper if it's exported, otherwise inline the math.
  // Find max-intensity emotion as dominant.
  const intensities: { type: EmotionType; value: number }[] = emotions.map((e) => ({
    type: e as EmotionType,
    value: newState[e],
  }));
  intensities.sort((a, b) => b.value - a.value);
  newState.dominant = intensities[0].value > 0.1 ? intensities[0].type : "neutral";

  // Weighted valence/arousal from the same constants the trigger system uses.
  let totalIntensity = 0;
  let weightedValence = 0;
  let weightedArousal = 0;
  for (const { type, value } of intensities) {
    if (value <= 0) continue;
    totalIntensity += value;
    weightedValence += value * EMOTION_VALENCE[type];
    weightedArousal += value * EMOTION_AROUSAL[type];
  }
  if (totalIntensity > 0) {
    newState.valence = weightedValence / totalIntensity;
    newState.arousal = weightedArousal / totalIntensity;
  } else {
    newState.valence = 0;
    newState.arousal = 0.3;
  }

  return newState;
}
