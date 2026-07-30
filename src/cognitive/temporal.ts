/**
 * Circadian + temporal context for cognitive journeys.
 *
 * The same person behaves differently at 9am vs 11pm vs Sunday morning vs
 * Monday at deadline. This module gives the journey runner a time-of-day
 * lens so a persona's cognitive traits, distractibility, and emotional
 * baseline shift naturally with the hour.
 *
 * Core curves:
 *   • Circadian energy — cosine model peaking ~10am, dipping ~3am and
 *     ~3pm, declining after 9pm. Range 0..1.
 *   • Day-of-week intensity — workdays (Mon-Fri) lift task focus, weekends
 *     lift exploration. Friday evening drops focus (already winding down).
 *   • Distraction probability — inverse of energy (low energy = more
 *     micro-interruptions like phone buzzes, family asks, etc.)
 *
 * Trait modulations are applied DELTA-style: traits shift by an amount
 * proportional to how far from "ideal" the time is. A high-energy persona
 * at 10am Monday is barely modified; a low-energy persona at 11pm Friday
 * is heavily affected.
 *
 * All math uses local time (caller passes hour/minute) so a single Date
 * works correctly regardless of server timezone.
 */

export interface TemporalContext {
  /** ISO timestamp or Date object representing the persona's "now". */
  now: Date | string;
  /** IANA timezone string (e.g. "America/New_York"). Defaults to UTC. */
  timezone?: string;
}

export interface TemporalState {
  hour: number;          // 0-23 local hour
  dayOfWeek: number;     // 0=Sun, 6=Sat
  isWeekend: boolean;
  energy: number;        // 0..1 circadian energy
  focusContext: "morning" | "midday" | "afternoon" | "evening" | "night";
  description: string;   // human-readable, for system prompt
}

export interface TemporalModulators {
  // Additive deltas applied to the persona's base cognitive traits.
  // Positive = boost, negative = penalty. All clamped to [-0.4, 0.4] so
  // no single time-of-day swing dominates the persona's identity.
  patienceDelta: number;
  workingMemoryDelta: number;
  curiosityDelta: number;
  metacognitiveDelta: number;
  // Probability per step that a distraction (5-30s pause) fires.
  distractionRate: number;
  // Multiplier on emotional satisfaction baseline (lower at night, higher
  // weekend morning) — captures "the same UI feels worse when I'm tired".
  satisfactionMultiplier: number;
}

/**
 * Decompose a Date into the relevant local-time fields. Uses Intl with
 * timezone if provided; falls back to system local time.
 */
export function getTemporalState(ctx: TemporalContext): TemporalState {
  const date = typeof ctx.now === "string" ? new Date(ctx.now) : ctx.now;
  const tz = ctx.timezone || "UTC";

  // Get hour + day in target timezone
  let hour: number;
  let dayOfWeek: number;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
      weekday: "short",
    }).formatToParts(date);
    hour = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
    if (hour === 24) hour = 0; // Intl edge case
    const wd = parts.find(p => p.type === "weekday")?.value || "Mon";
    dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  } catch {
    hour = date.getHours();
    dayOfWeek = date.getDay();
  }

  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const energy = circadianEnergy(hour);
  const focusContext = phaseOfDay(hour);
  const description = describeTemporal(hour, dayOfWeek, focusContext);

  return { hour, dayOfWeek, isWeekend, energy, focusContext, description };
}

/**
 * Circadian alertness on 0..1 scale. Two-cycle cosine model from chronobiology
 * literature: dominant ~24h rhythm + secondary post-lunch dip ~12h.
 *
 * References: Borbély's two-process model; Folkard & Tucker (2003) on
 * post-prandial alertness dip.
 *
 * Key features of the curve:
 *   • Trough ~3am (energy ≈ 0.05)
 *   • Rapid rise 6-10am
 *   • Morning peak ~10-11am (energy ≈ 0.95)
 *   • Post-lunch dip 13-15h (energy ≈ 0.55)
 *   • Late afternoon recovery ~16-18h (energy ≈ 0.80)
 *   • Evening decline after 21h
 *   • Late-night low after 23h (energy ≈ 0.20)
 */
export function circadianEnergy(hour: number): number {
  // Primary 24h cosine: peak at ~14h offset for the normal awake cycle
  const primary = 0.5 + 0.45 * Math.cos((hour - 14) * 2 * Math.PI / 24);
  // Secondary post-lunch dip: cosine peaking at 14h but inverted (so it dips)
  const lunchDip = 0.10 * Math.cos((hour - 14) * 2 * Math.PI / 6);
  // Sleep penalty: between 23h and 6h, suppress further
  const sleepPenalty = (hour >= 23 || hour < 6) ? 0.2 : 0;
  return Math.max(0.05, Math.min(1, primary - lunchDip - sleepPenalty));
}

function phaseOfDay(hour: number): TemporalState["focusContext"] {
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 17) return "midday";
  if (hour < 21) return "evening";
  return "night";
}

function describeTemporal(hour: number, dow: number, phase: string): string {
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const day = dayNames[dow];
  const isWeekend = dow === 0 || dow === 6;
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const ampm = hour < 12 ? "am" : "pm";
  const time = `${h12}${ampm}`;

  if (phase === "night" && hour >= 23) return `late ${day} night (${time}) — tired, winding down, want quick answers`;
  if (phase === "night") return `early ${day} morning (${time}) — pre-coffee, slow processing`;
  if (phase === "morning" && hour < 9) return `${day} ${time} — easing into the day`;
  if (phase === "morning") return `${day} ${time} — peak focus${isWeekend ? ", relaxed weekend energy" : ", workday momentum"}`;
  if (phase === "midday" && hour < 14) return `${day} lunchtime (${time})${isWeekend ? ", weekend pace" : ""}`;
  if (phase === "midday") return `${day} ${time} — post-lunch, energy ebbing${isWeekend ? "" : ", afternoon work session"}`;
  if (phase === "evening" && isWeekend) return `${day} evening (${time}) — leisure time, exploring`;
  if (phase === "evening") return `${day} ${time} — winding down workday, less patience`;
  return `${day} ${time}`;
}

/**
 * Compute trait deltas from a temporal state. The deltas are MEANT to be
 * added to the persona's base cognitive traits — they're effects layered
 * ON TOP of who the persona fundamentally is.
 */
export function computeTemporalModulators(state: TemporalState): TemporalModulators {
  const e = state.energy;
  // Energy → traits. Centered such that energy=0.7 (typical waking) gives ~0.
  const eShift = (e - 0.7); // range roughly [-0.65, +0.30]

  // Patience drops sharply when tired or stressed (low energy or peak
  // workday hours). Friday evening: less patient (winding down).
  let patienceDelta = eShift * 0.30;
  if (state.dayOfWeek === 5 && state.hour >= 16) patienceDelta -= 0.10;
  // Late night patience cliff
  if (state.hour >= 22 || state.hour < 6) patienceDelta -= 0.15;

  // Working memory tracks energy directly
  const workingMemoryDelta = eShift * 0.30;

  // Curiosity: lower during peak work focus, higher in leisure windows
  let curiosityDelta = 0;
  if (state.focusContext === "evening" && state.isWeekend) curiosityDelta += 0.12;
  if (state.focusContext === "evening" && !state.isWeekend) curiosityDelta -= 0.05;
  if (state.focusContext === "morning" && !state.isWeekend) curiosityDelta -= 0.10; // workday focus

  // Metacognitive planning collapses when very tired
  const metacognitiveDelta = e < 0.4 ? -0.20 : eShift * 0.20;

  // Distraction rate: ~3% per step at peak energy, up to ~25% at low energy
  const distractionRate = Math.max(0.03, 0.30 - e * 0.30);

  // Satisfaction baseline: same UI feels worse when tired
  const satisfactionMultiplier = 0.7 + e * 0.4; // [0.7..1.1]

  // Clamp deltas to [-0.4, 0.4]
  const clamp = (v: number) => Math.max(-0.4, Math.min(0.4, v));

  return {
    patienceDelta: clamp(patienceDelta),
    workingMemoryDelta: clamp(workingMemoryDelta),
    curiosityDelta: clamp(curiosityDelta),
    metacognitiveDelta: clamp(metacognitiveDelta),
    distractionRate,
    satisfactionMultiplier,
  };
}

/**
 * Should this step trigger a distraction (phone buzz, kid asks question,
 * etc.)? Returns the duration in ms if yes, 0 if no.
 */
export function rollDistraction(modulators: TemporalModulators): number {
  if (Math.random() >= modulators.distractionRate) return 0;
  // Distraction durations follow a long-tailed distribution: most are
  // 3-10s glances, occasional 30-60s genuine interruptions
  const r = Math.random();
  if (r < 0.7) return 3000 + Math.random() * 7000;     // short glance
  if (r < 0.95) return 10000 + Math.random() * 20000;  // medium chat
  return 30000 + Math.random() * 30000;                // long detour
}
