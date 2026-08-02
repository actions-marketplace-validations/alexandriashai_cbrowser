/**
 * Inferring Big Five scores from a free-text persona description.
 *
 * WHY THIS ROUTE EXISTS
 *
 * A persona's thirteen motivational values come from one of three routes, and
 * they are not equally trustworthy: answers someone gave, then published Big
 * Five correlations, then our own bridge from cognitive traits. The third route
 * cannot reach four of the thirteen axes at all — hedonism, power, universalism
 * and the relatedness need have no cognitive trait pointing at them — so a
 * persona that falls to it gets four placeholders.
 *
 * In practice almost every persona falls to it, because personas are usually
 * written as a sentence of description and nobody answers a questionnaire. The
 * four unreachable axes are therefore not an edge case; they are the normal
 * outcome.
 *
 * This route closes that, and it does so by moving the inference to where the
 * evidence is better rather than by inventing links. A description like "a
 * cautious retiree who double-checks everything before buying" is much closer to
 * what a personality instrument actually measures than `patience: 0.4` is. Once
 * a Big Five profile exists, all thirteen axes derive through correlations three
 * independent bodies of research agree on.
 *
 * WHY IT IS LABELLED SEPARATELY, AND BELOW STATED BIG FIVE
 *
 * The estimate is a model reading prose. That is a real error source with no
 * published calibration behind it, and it is NOT the same evidential object as
 * five numbers a human supplied. Merging the two under one `big_five` label
 * would hide exactly the distinction the route ordering exists to express — so
 * this is its own route, `bigfive_inferred`, ranked below `big_five` and above
 * `cognitive_traits`.
 *
 * The ranking is a claim about where the uncertainty sits, not about accuracy.
 * Inferred Big Five has weak INPUTS and a strong BRIDGE (published correlations
 * to values). The cognitive-trait route has stronger inputs — the persona's
 * stated traits — and a weak bridge our own table invents. Those are different
 * failure modes, and the honest reason to prefer this one is coverage: it
 * reaches thirteen axes instead of nine, and it says out loud that it guessed.
 *
 * @since 2026-08-01
 */

export interface BigFiveInferenceEvidence {
  /** The factor being scored. */
  factor: string;
  /** 0-1. */
  score: number;
  /** The words in the description that justify it. Required — see below. */
  quote: string;
}

/**
 * Anchors for each factor, written as OBSERVABLE BEHAVIOUR rather than as trait
 * adjectives.
 *
 * Asking a model "how open is this person, 0 to 1?" invites it to pattern-match
 * on the word rather than on the description, and the failure is invisible
 * because any number in range looks like an answer. Anchoring each end in
 * something a description could actually say makes the estimate checkable
 * against the text.
 */
export const BIG_FIVE_INFERENCE_ANCHORS: Record<string, { low: string; high: string; doNotConfuse: string }> = {
  openness: {
    low: "Prefers the familiar; sticks to what already works; describes routine, tradition, or 'the way I have always done it'.",
    high: "Seeks novelty and variety; curious about unfamiliar things; described as imaginative, exploratory, interested in ideas.",
    doNotConfuse: "Not the same as intelligence or competence. A highly skilled person who dislikes change is LOW openness.",
  },
  conscientiousness: {
    low: "Improvises, leaves things half-finished, decides quickly on partial information, describes themselves as disorganised or spontaneous.",
    high: "Plans, checks, finishes; keeps lists; described as careful, thorough, reliable, detail-oriented.",
    doNotConfuse: "Not the same as slow. Someone fast AND thorough is high conscientiousness with high processing speed.",
  },
  extraversion: {
    low: "Drained by interaction; prefers solitary work; described as reserved, private, quiet.",
    high: "Energised by people; seeks stimulation and social contact; described as outgoing, talkative, assertive.",
    doNotConfuse: "Not the same as social skill or confidence. A capable, confident person who finds people tiring is LOW extraversion.",
  },
  agreeableness: {
    low: "Blunt, sceptical of others' motives, competitive, willing to argue; described as demanding or hard to please.",
    high: "Cooperative, trusting, accommodating; avoids conflict; described as warm, helpful, considerate.",
    doNotConfuse: "Not the same as being nice under duress. Someone who complies to avoid conflict but resents it is not high agreeableness.",
  },
  neuroticism: {
    low: "Even-tempered under pressure; recovers quickly from setbacks; described as calm, steady, unflappable.",
    high: "Worries, anticipates problems, rattled by uncertainty; described as anxious, stressed, easily frustrated.",
    doNotConfuse: "Not the same as being careful. A calm person who double-checks is conscientious, NOT neurotic.",
  },
};

/**
 * Validate an inferred profile before it is stored.
 *
 * Two things are rejected, both because they are the shapes a guess takes when
 * a model had nothing to go on:
 *
 *   - A score with no supporting quote. The quote is the audit trail; without it
 *     nobody can tell an estimate grounded in the text from one produced to fill
 *     the field. A required quote is also the cheapest brake on inventing a
 *     number the description does not support.
 *   - All five landing at 0.5. That is the shape of "no signal" wearing the
 *     shape of "measured average", which is the same 0.5 ambiguity this whole
 *     values layer went to some length to remove elsewhere.
 */
export function validateInferredBigFive(
  scores: Record<string, number>,
  evidence: BigFiveInferenceEvidence[] | undefined,
  /**
   * The description the scores were inferred from.
   *
   * Without it the quote requirement is cosmetic: any string satisfies "a quote
   * is present", including the string "NO SUPPORTING TEXT". Checked against the
   * source, a quote is evidence; unchecked, it is a field someone filled in.
   * (2026-08-01)
   */
  description?: string,
): { ok: true } | { ok: false; reason: string } {
  const FACTORS = Object.keys(BIG_FIVE_INFERENCE_ANCHORS);
  const missing = FACTORS.filter((f) => typeof scores[f] !== "number");
  if (missing.length) {
    return { ok: false, reason: `missing scores for ${missing.join(", ")} — all five factors are required, because deriving values from a partial profile silently leaves axes at baseline` };
  }
  const outOfRange = FACTORS.filter((f) => scores[f] < 0 || scores[f] > 1);
  if (outOfRange.length) {
    return { ok: false, reason: `out of range: ${outOfRange.join(", ")} (expected 0-1)` };
  }
  const quoted = new Set((evidence ?? []).filter((e) => e.quote?.trim()).map((e) => e.factor));
  const unquoted = FACTORS.filter((f) => !quoted.has(f));
  if (unquoted.length) {
    return { ok: false, reason: `no supporting quote for ${unquoted.join(", ")} — every factor must cite the words in the description that justify its score, so a reader can check the estimate against the text rather than trusting it` };
  }

  // The quote must actually BE in the description.
  //
  // Comparison is on letters and digits only, so punctuation, case and
  // whitespace differences do not reject an honest quote -- but a phrase that
  // is not in the text at all cannot pass, which is the whole point. A quote
  // reading "NO SUPPORTING TEXT" was accepted verbatim before this.
  if (description) {
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const haystack = norm(description);
    const fabricated = (evidence ?? [])
      .filter((e) => e.quote?.trim() && !haystack.includes(norm(e.quote)))
      .map((e) => `${e.factor} ("${e.quote.slice(0, 40)}")`);
    if (fabricated.length) {
      return { ok: false, reason: `these quotes do not appear in the description: ${fabricated.join("; ")}. A quote nobody can find in the source is not evidence. If the description does not speak to a factor, omit the whole profile rather than filling the field — see the note below.` };
    }
  }
  if (FACTORS.every((f) => scores[f] === 0.5)) {
    return { ok: false, reason: "all five factors are exactly 0.5, which is what 'no signal' looks like wearing the shape of 'measured average'. If the description genuinely does not support an estimate, omit the profile and let the persona use the cognitive-trait route, which reports its own gaps" };
  }
  return { ok: true };
}

/** The block handed to the inferring model. Behavioural anchors, not adjectives. */
export function bigFiveInferenceReference(): Record<string, unknown> {
  return {
    instruction:
      "Estimate this persona's Big Five personality profile from the description, 0-1 per factor. "
      + "For EACH factor, quote the words in the description that justify the score — the quote is checked against the description and a phrase that is not in it is rejected. "
      // The previous wording told callers to decline individual factors while
      // the schema required all five, which are not both satisfiable. The
      // profile is all-or-nothing on purpose: a partial one silently leaves
      // axes at baseline, which is the ambiguity this whole layer exists to
      // remove. So the honest out is omitting the profile, not part of it.
      + "It is ALL FIVE OR NONE: if the description does not support estimating every factor, omit bigFive entirely rather than filling the weak ones. "
      + "A persona with no Big Five profile derives its values from cognitive traits and reports its own gaps; a persona with an invented one does not.",
    why:
      "Big Five scores unlock all thirteen motivational values through published correlations. "
      + "Without them the persona falls back to deriving values from cognitive traits, which cannot reach "
      + "hedonism, power, universalism or the relatedness need at all — those four stay at the 0.5 baseline.",
    factors: BIG_FIVE_INFERENCE_ANCHORS,
    output_shape: {
      bigFive: { openness: 0.7, conscientiousness: 0.3, extraversion: 0.8, agreeableness: 0.6, neuroticism: 0.2 },
      bigFiveEvidence: [
        { factor: "openness", score: 0.7, quote: "curious about unfamiliar tools" },
        { factor: "conscientiousness", score: 0.3, quote: "skims content, decides fast" },
      ],
    },
  };
}
