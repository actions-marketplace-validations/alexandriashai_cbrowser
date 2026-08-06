/**
 * Resolve a persona name into the context the relevance judge reasons from.
 *
 * Shared because both call sites had the same bug independently: each passed
 * only personaName, so the model received a bare string like "anxious-user"
 * and inferred what that implied. The trait numbers are the entire reason this
 * layer beats keyword matching -- without them it is an LLM guessing at a
 * persona it was never shown.
 *
 * One function rather than two copies, so a fix to one cannot leave the other
 * behind, which is exactly how they diverged in the first place.
 */

export interface ResolvedPersonaContext {
  personaDescription?: string;
  traits?: Record<string, number>;
  values?: Record<string, number>;
  /**
   * Sensory, motor and executive-function traits.
   *
   * A SEPARATE vector from `traits`, and it was reaching nothing. The judge got
   * the 25 cognitive traits and none of these -- the wrong half to drop for a
   * layer whose entire job is deciding what a person attends to and reads. This
   * codebase already names `accessibility_traits.attentionSpan` the AUTHORITATIVE
   * source for attention (persona-comparison-tools.ts), with
   * `traits.interruptRecovery` only a fallback, and the decoding traits
   * authoritative for reading.
   *
   * Measured on the persona that models an ADHD user: the three values that
   * define her -- attentionSpan 0.30, processingSpeed 0.40, fatigueSusceptibility
   * 0.30 -- were exactly the ones the judge never saw. It was told she has high
   * curiosity and comprehension, and not told she cannot hold a line of text.
   * (2026-08-05)
   */
  accessibilityTraits?: Record<string, number | boolean>;
}

/**
 * Never throws. An unresolvable persona yields an empty context and the judge
 * falls back to reasoning from name and goal, which is what it did before.
 */
export async function resolvePersonaContext(name: string): Promise<ResolvedPersonaContext> {
  try {
    const { getAnyPersona, getCognitiveProfile } = await import("../personas.js");
    const { resolveValuesForPersona } = await import("../values/index.js");
    const resolved = getAnyPersona(name);
    if (!resolved) return {};
    const profile = getCognitiveProfile(resolved as never);
    const v = resolveValuesForPersona((resolved as { name: string }).name);
    const description = (resolved as { description?: string }).description;
    // Read off the persona directly: these live beside `cognitiveTraits` on the
    // stored object and are NOT part of the cognitive profile, so
    // getCognitiveProfile never surfaced them.
    const a11y = (resolved as { accessibilityTraits?: Record<string, number | boolean> })
      .accessibilityTraits;
    return {
      ...(description ? { personaDescription: description } : {}),
      ...(a11y && Object.keys(a11y).length > 0 ? { accessibilityTraits: a11y } : {}),
      ...(profile?.traits
        ? { traits: profile.traits as unknown as Record<string, number> }
        : {}),
      ...(v ? { values: {
        selfDirection: v.selfDirection, stimulation: v.stimulation,
        hedonism: v.hedonism, achievement: v.achievement, power: v.power,
        security: v.security, conformity: v.conformity, tradition: v.tradition,
        benevolence: v.benevolence, universalism: v.universalism,
      } } : {}),
    };
  } catch {
    return {};
  }
}
