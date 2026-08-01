/**
 * Big Five -> Schwartz values.
 *
 * Why this exists alongside the cognitive-trait correlations: the published
 * literature relates VALUES to the Big Five, not to patience or satisficing or
 * information foraging. Deriving a value from a cognitive trait therefore
 * always crosses a gap the research does not cover -- the direction may be
 * reasonable, but the bridge is ours. Deriving it from the Big Five does not
 * cross that gap, because the Big Five is the construct the studies measured.
 *
 * This also fills the four axes no cognitive trait reaches. hedonism and power
 * are Extraversion territory; universalism is Openness and Agreeableness;
 * relatedness is the weakest of the four and is labelled accordingly.
 *
 * WHAT IS ESTABLISHED AND WHAT IS NOT
 *
 * The DIRECTION of each link below is reported consistently across Roccas,
 * Sagiv, Schwartz & Knafo (2002, N=246), Fischer & Boer's three-level
 * meta-analysis (2015, N=9,935 across 14 countries), and Parks-Leduc, Feldman
 * & Bardi's meta-analysis of 60 studies. Those three agree on sign for every
 * pairing used here.
 *
 * The MAGNITUDES are ours. The published correlations are modest -- the
 * meta-analyses stress that traits and values are distinct constructs and the
 * relationships "are not generally large" -- and none of the sources reachable
 * for this work published a full r-value table. So every weight here is a
 * modelling choice scaled to the reported relative strength, not a coefficient
 * copied from a paper. `evidence` on each row says which half you are reading.
 *
 * Anyone recalibrating this should change the weights freely and the signs only
 * with a citation.
 *
 * @since 2026-08-01
 */

export type BigFiveFactor = 'openness' | 'conscientiousness' | 'extraversion' | 'agreeableness' | 'neuroticism';

export interface BigFiveScores {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
}

export interface BigFiveValueLink {
  factor: BigFiveFactor;
  value: string;
  /** Ours. Scaled to reported relative strength, not a published coefficient. */
  weight: number;
  direction: 'positive' | 'negative';
  /**
   * `direction-established` — sign agreed by the three sources named above;
   * weight is a modelling choice.
   * `direction-inferred` — sign follows from theory or from a weaker/adjacent
   * finding, and should be treated as a hypothesis.
   */
  evidence: 'direction-established' | 'direction-inferred';
  source: string;
}

export const BIG_FIVE_VALUE_LINKS: BigFiveValueLink[] = [
  // ── Openness ──
  { factor: 'openness', value: 'selfDirection', weight: 0.7, direction: 'positive',
    evidence: 'direction-established',
    source: 'Roccas et al. (2002); Fischer & Boer (2015) — Openness is the strongest correlate of self-direction' },
  { factor: 'openness', value: 'universalism', weight: 0.6, direction: 'positive',
    evidence: 'direction-established',
    source: 'Roccas et al. (2002); Parks-Leduc et al. (2015) — Openness correlates with universalism' },
  { factor: 'openness', value: 'stimulation', weight: 0.6, direction: 'positive',
    evidence: 'direction-established',
    source: 'Roccas et al. (2002) — Openness associated with stimulation' },
  { factor: 'openness', value: 'tradition', weight: 0.5, direction: 'negative',
    evidence: 'direction-established',
    source: 'Fischer & Boer (2015) — Openness–Conservation is among the strongest reported relationships, negative' },
  { factor: 'openness', value: 'conformity', weight: 0.4, direction: 'negative',
    evidence: 'direction-established',
    source: 'Fischer & Boer (2015) — Openness opposes the Conservation dimension' },

  // ── Extraversion ──
  { factor: 'extraversion', value: 'hedonism', weight: 0.6, direction: 'positive',
    evidence: 'direction-established',
    source: 'Roccas et al. (2002); Parks-Leduc et al. (2015) — Extraversion correlates positively with hedonism' },
  { factor: 'extraversion', value: 'power', weight: 0.5, direction: 'positive',
    evidence: 'direction-established',
    source: 'Parks-Leduc et al. (2015) — Extraversion correlates most positively with stimulation, hedonism, achievement and power' },
  { factor: 'extraversion', value: 'achievement', weight: 0.5, direction: 'positive',
    evidence: 'direction-established',
    source: 'Roccas et al. (2002) — Extraversion associated with achievement' },
  { factor: 'extraversion', value: 'stimulation', weight: 0.5, direction: 'positive',
    evidence: 'direction-established',
    source: 'Roccas et al. (2002) — Extraversion associated with stimulation' },
  { factor: 'extraversion', value: 'tradition', weight: 0.3, direction: 'negative',
    evidence: 'direction-established',
    source: 'Parks-Leduc et al. (2015) — Extraversion correlates most negatively with tradition' },

  // ── Agreeableness ──
  { factor: 'agreeableness', value: 'benevolence', weight: 0.7, direction: 'positive',
    evidence: 'direction-established',
    source: 'Roccas et al. (2002); Fischer & Boer (2015) — Agreeableness–Transcendence is among the strongest reported' },
  { factor: 'agreeableness', value: 'universalism', weight: 0.5, direction: 'positive',
    evidence: 'direction-established',
    source: 'Parks-Leduc et al. (2015) — Agreeableness correlates positively with universalism' },
  { factor: 'agreeableness', value: 'conformity', weight: 0.4, direction: 'positive',
    evidence: 'direction-established',
    source: 'Roccas et al. (2002) — Agreeableness associated with conformity' },
  { factor: 'agreeableness', value: 'tradition', weight: 0.4, direction: 'positive',
    evidence: 'direction-established',
    source: 'Roccas et al. (2002) — Agreeableness associated with tradition' },
  { factor: 'agreeableness', value: 'power', weight: 0.5, direction: 'negative',
    evidence: 'direction-established',
    source: 'Parks-Leduc et al. (2015) — Agreeableness correlates most negatively with power and achievement' },
  { factor: 'agreeableness', value: 'achievement', weight: 0.3, direction: 'negative',
    evidence: 'direction-established',
    source: 'Parks-Leduc et al. (2015) — Agreeableness correlates negatively with achievement' },

  // ── Conscientiousness ──
  { factor: 'conscientiousness', value: 'achievement', weight: 0.6, direction: 'positive',
    evidence: 'direction-established',
    source: 'Roccas et al. (2002) — Conscientiousness associated with achievement' },
  { factor: 'conscientiousness', value: 'conformity', weight: 0.5, direction: 'positive',
    evidence: 'direction-established',
    source: 'Roccas et al. (2002) — Conscientiousness associated with conformity' },
  { factor: 'conscientiousness', value: 'security', weight: 0.4, direction: 'positive',
    evidence: 'direction-inferred',
    source: 'HYPOTHESIS. Conscientiousness sits on the Conservation side of the circumplex with conformity, and security is the third Conservation value. No source reachable for this work reported the pairing directly.' },
  { factor: 'conscientiousness', value: 'hedonism', weight: 0.4, direction: 'negative',
    evidence: 'direction-inferred',
    source: 'HYPOTHESIS. Hedonism opposes Conservation on the circumplex, so a Conscientiousness–hedonism negative follows from the structure rather than from a reported coefficient.' },

  // ── Neuroticism ──
  { factor: 'neuroticism', value: 'security', weight: 0.4, direction: 'positive',
    evidence: 'direction-inferred',
    source: 'HYPOTHESIS. Threat sensitivity plausibly raises the priority of safety and stability. Reported Neuroticism–value correlations are the weakest of the five factors, so this is the least confident row here.' },

  // ── Relatedness need (SDT, not Schwartz) ──
  { factor: 'agreeableness', value: 'relatednessNeed', weight: 0.5, direction: 'positive',
    evidence: 'direction-inferred',
    source: 'HYPOTHESIS. Need-support research reports that people experiencing relatedness satisfaction tend to be more agreeable and extroverted, which is a correlate of satisfaction rather than of the need itself. Treated as the weakest link in this table.' },
  { factor: 'extraversion', value: 'relatednessNeed', weight: 0.4, direction: 'positive',
    evidence: 'direction-inferred',
    source: 'HYPOTHESIS. Same basis and same caveat as the Agreeableness link above.' },

  // ── Autonomy and competence needs ──
  { factor: 'openness', value: 'autonomyNeed', weight: 0.4, direction: 'positive',
    evidence: 'direction-inferred',
    source: 'HYPOTHESIS. Openness predicts self-direction, and autonomy is the SDT construct nearest to it. An inference across two frameworks, not a reported pairing.' },
  { factor: 'conscientiousness', value: 'competenceNeed', weight: 0.4, direction: 'positive',
    evidence: 'direction-inferred',
    source: 'HYPOTHESIS. Conscientiousness predicts achievement, and competence is the SDT construct nearest to it. Same cross-framework caveat.' },
];

/**
 * Values from a Big Five profile, same squash as the trait derivation so the
 * two paths produce comparable numbers.
 */
export function deriveValuesFromBigFive(scores: Partial<BigFiveScores>): {
  values: Record<string, number>;
  contributions: Array<{ factor: string; value: string; contribution: number; evidence: string }>;
  /** Axes with at least one link whose direction is a hypothesis, not a finding. */
  hypothesisAxes: string[];
} {
  const AXES = ['selfDirection', 'stimulation', 'hedonism', 'achievement', 'power', 'security',
    'conformity', 'tradition', 'benevolence', 'universalism',
    'autonomyNeed', 'competenceNeed', 'relatednessNeed'];

  const raw: Record<string, number> = {};
  AXES.forEach((a) => { raw[a] = 0; });
  const contributions: Array<{ factor: string; value: string; contribution: number; evidence: string }> = [];
  const hypothesis = new Set<string>();

  for (const link of BIG_FIVE_VALUE_LINKS) {
    const s = scores[link.factor];
    if (typeof s !== 'number') continue;
    const c = (s - 0.5) * link.weight * (link.direction === 'positive' ? 1 : -1);
    raw[link.value] = (raw[link.value] ?? 0) + c;
    if (Math.abs(c) > 0.02) {
      contributions.push({ factor: link.factor, value: link.value,
        contribution: Math.round(c * 100) / 100, evidence: link.evidence });
    }
    if (link.evidence === 'direction-inferred') hypothesis.add(link.value);
  }

  const values: Record<string, number> = {};
  AXES.forEach((a) => { values[a] = Math.round((0.5 + 0.5 * Math.tanh(raw[a])) * 100) / 100; });

  return { values, contributions, hypothesisAxes: [...hypothesis] };
}

/** Axes this table can reach — all thirteen, which is the point of adding it. */
export function bigFiveReachableAxes(): string[] {
  return [...new Set(BIG_FIVE_VALUE_LINKS.map((l) => l.value))];
}
