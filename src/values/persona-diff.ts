/**
 * What changed about a persona, and whether its description still describes it.
 *
 * WHY THE DESCRIPTION MATTERS HERE
 *
 * A persona is prose plus numbers, and only the numbers get updated. Change
 * `patience` from 0.8 to 0.15 and the trait vector now says "impatient" while
 * the description still says "patient with complex regulatory content" — both
 * stored, both authoritative-looking, disagreeing.
 *
 * That is not hypothetical. `sofia-mobile-navigator` carried attentionPattern
 * "thorough" against a description that says "short attention, skims", and
 * nothing anywhere noticed for as long as the persona existed.
 *
 * The description is NOT rewritten. Someone wrote it, it carries intent the
 * numbers cannot, and silently regenerating prose from a trait vector is the
 * same overreach as overwriting stated values with a derivation. What happens
 * instead is that a change reports which description claims its own numbers now
 * contradict, and leaves the decision where it belongs.
 *
 * @since 2026-08-01
 */

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
  delta?: number;
}

/**
 * Words a description uses that make a claim about a trait, and the direction.
 *
 * Deliberately small and literal. A description says "impatient" or it does
 * not; inferring a patience claim from tone would produce drift warnings nobody
 * can check against the text, which is the failure mode this is meant to catch
 * rather than commit.
 */
const DESCRIPTION_CLAIMS: Array<{ trait: string; high: string[]; low: string[] }> = [
  { trait: "patience", high: ["patient", "takes their time", "waits"], low: ["impatient", "time-pressured", "in a hurry", "abandons quickly"] },
  { trait: "readingTendency", high: ["reads carefully", "reads everything", "careful reader", "high reading"], low: ["skims", "skim", "scans", "low tolerance for dense"] },
  { trait: "selfEfficacy", high: ["high self-efficacy", "confident", "capable"], low: ["low confidence", "limited confidence", "self-blaming", "low digital confidence"] },
  { trait: "satisficing", high: ["good enough", "settles", "first adequate"], low: ["maximizer", "seeks optimal", "thorough", "won't settle"] },
  { trait: "curiosity", high: ["curious", "exploratory", "explores"], low: ["focused only", "sticks to"] },
  { trait: "riskTolerance", high: ["risk-tolerant", "dives in", "experiments"], low: ["cautious", "risk-averse", "careful with"] },
  { trait: "comprehension", high: ["technically expert", "expert", "fluent", "power user"], low: ["unfamiliar with", "doesn't know", "first time", "novice"] },
  { trait: "resilience", high: ["resilient", "recovers", "unflappable"], low: ["prone to frustration", "rattled", "fatigues quickly"] },
  { trait: "trustCalibration", high: ["trusting"], low: ["skeptical", "sceptical", "cautious with personal", "verifies"] },
  { trait: "workingMemory", high: ["high working memory", "remembers"], low: ["weak working memory", "loses place", "loses track"] },
];

export interface DescriptionDrift {
  trait: string;
  phrase: string;
  claims: "high" | "low";
  nowIs: number;
  note: string;
}

/**
 * Description claims the new trait values contradict.
 *
 * A claim counts as contradicted only when the trait lands clearly on the other
 * side of the midpoint — 0.35/0.65 rather than 0.5 — so a value that merely
 * drifted toward neutral does not generate noise. The threshold is deliberately
 * loose: a warning that fires on every edit gets ignored, and an ignored
 * warning is the same as no warning.
 */
export function describeDrift(
  description: string | undefined,
  traits: Record<string, number> | undefined,
): DescriptionDrift[] {
  if (!description || !traits) return [];
  const text = description.toLowerCase();
  const out: DescriptionDrift[] = [];
  for (const { trait, high, low } of DESCRIPTION_CLAIMS) {
    const v = traits[trait];
    if (typeof v !== "number") continue;
    // One finding per trait per direction. The phrase lists contain overlapping
    // stems on purpose ("skim" and "skims" both appear in real descriptions),
    // and reporting each match separately turns one contradiction into three,
    // which reads as three problems.
    const longest = (phrases: string[]) =>
      phrases.filter((ph) => text.includes(ph)).sort((a, b) => b.length - a.length)[0];
    const hiHit = v < 0.35 ? longest(high) : undefined;
    if (hiHit) {
      out.push({ trait, phrase: hiHit, claims: "high", nowIs: v,
        note: `the description says "${hiHit}" but ${trait} is now ${v}` });
    }
    const loHit = v > 0.65 ? longest(low) : undefined;
    if (loHit) {
      out.push({ trait, phrase: loHit, claims: "low", nowIs: v,
        note: `the description says "${loHit}" but ${trait} is now ${v}` });
    }
  }
  return out;
}

/** A one-line summary of what the trait vector says, for comparison with the prose. */
export function summariseTraits(traits: Record<string, number> | undefined): string {
  if (!traits) return "no traits";
  const strong: string[] = [];
  const pick = (t: string, hi: string, lo: string) => {
    const v = traits[t];
    if (typeof v !== "number") return;
    if (v >= 0.7) strong.push(hi);
    else if (v <= 0.3) strong.push(lo);
  };
  pick("patience", "patient", "impatient");
  pick("readingTendency", "reads thoroughly", "skims");
  pick("comprehension", "fluent with interfaces", "unfamiliar with interfaces");
  pick("selfEfficacy", "confident", "low confidence");
  pick("satisficing", "settles quickly", "seeks the optimal option");
  pick("riskTolerance", "risk-tolerant", "cautious");
  pick("resilience", "recovers easily", "rattled by setbacks");
  return strong.length ? strong.join(", ") : "no trait sits far enough from the midpoint to characterise";
}

/** Field-level diff between two persona snapshots. */
export function diffPersona(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  const bt = (before.cognitiveTraits ?? {}) as Record<string, number>;
  const at = (after.cognitiveTraits ?? {}) as Record<string, number>;
  for (const k of new Set([...Object.keys(bt), ...Object.keys(at)])) {
    if (bt[k] !== at[k]) {
      changes.push({ field: `traits.${k}`, before: bt[k] ?? null, after: at[k] ?? null,
        ...(typeof bt[k] === "number" && typeof at[k] === "number"
          ? { delta: Math.round((at[k] - bt[k]) * 1000) / 1000 } : {}) });
    }
  }
  for (const k of ["description", "schwartzValues", "bigFive", "accessibilityTraits", "demographics"]) {
    const b = JSON.stringify(before[k] ?? null);
    const a = JSON.stringify(after[k] ?? null);
    if (b !== a) changes.push({ field: k, before: before[k] ?? null, after: after[k] ?? null });
  }
  const bp = ((before.humanBehavior as Record<string, Record<string, unknown>>)?.attention?.pattern) ?? null;
  const ap = ((after.humanBehavior as Record<string, Record<string, unknown>>)?.attention?.pattern) ?? null;
  if (bp !== ap) changes.push({ field: "attentionPattern", before: bp, after: ap });
  return changes;
}
