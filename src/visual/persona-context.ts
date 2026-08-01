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
}

/**
 * Never throws. An unresolvable persona yields an empty context and the judge
 * falls back to reasoning from name and goal, which is what it did before.
 */
export async function resolvePersonaContext(name: string): Promise<ResolvedPersonaContext> {
  try {
    const { getAnyPersona, getCognitiveProfile } = await import("../personas.js");
    const { getPersonaValues } = await import("../values/index.js");
    const resolved = getAnyPersona(name);
    if (!resolved) return {};
    const profile = getCognitiveProfile(resolved as never);
    const v = getPersonaValues((resolved as { name: string }).name);
    const description = (resolved as { description?: string }).description;
    return {
      ...(description ? { personaDescription: description } : {}),
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
