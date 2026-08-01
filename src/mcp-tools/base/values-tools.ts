/**
 * CBrowser MCP Tools - Values System Tools
 * Schwartz's 10 Universal Values, Self-Determination Theory, Maslow
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import { PERSONA_CATEGORIES } from "../../persona-questionnaire.js";
import { getAnyPersona, getCognitiveProfile } from "../../personas.js";
import { valueAxisCorrelationCounts } from "../../persona-questionnaire.js";
import { widgetUri } from "../widget-kit.js";
import type { McpServer } from "../types.js";
import {
  getPersonaValues,
  PERSONA_VALUE_PROFILES,
  rankInfluencePatternsForProfile,
  INFLUENCE_PATTERNS,
} from "../../values/index.js";

/**
 * Register values system tools (7 tools)
 */
/**
 * The one place a persona's Schwartz values are resolved.
 *
 * Two tools answered this question and only one of them knew about the second
 * source: persona_lookup read the hand-authored registry AND the schwartzValues
 * block a custom persona carries on its own file, while persona_values_lookup
 * read the registry alone and hard-errored when it missed -- for a persona
 * whose values were sitting on disk. Same question, two answers, because there
 * were two implementations. (2026-07-31)
 */
export function resolvePersonaValues(name: string): {
  values: Record<string, number> | null;
  source: "registry" | "persona" | "derived" | "none";
  sdt?: Record<string, number>;
  sdtSource?: "derived" | "default";
  unpopulatedAxes?: string[];
  unpopulatedNote?: string;
  netZeroAxes?: string[];
  netZeroNote?: string;
  higherOrderContamination?: Record<string, string>;
  higherOrder?: Record<string, number>;
  maslowLevel?: string;
  maslowSource?: "stored" | "derived";
} {
  const KEYS = ["selfDirection", "stimulation", "hedonism", "achievement", "power",
    "security", "conformity", "tradition", "benevolence", "universalism"] as const;
  const registry = getPersonaValues(name) as Record<string, number> | undefined;
  const persona = getAnyPersona(name) as unknown as Record<string, unknown> | undefined;
  const own = persona?.schwartzValues as Record<string, number> | undefined;
  const src = registry ?? own;
  if (!src) return { values: null, source: "none" };

  const values: Record<string, number> = {};
  for (const k of KEYS) if (typeof src[k] === "number") values[k] = src[k];

  const sdt: Record<string, number> = {};
  ["autonomyNeed", "competenceNeed", "relatednessNeed"].forEach((k) => {
    const v = (src as Record<string, number>)[k];
    if (typeof v === "number") sdt[k] = v;
  });
  // Questionnaire-derived personas get SDT computed from answers; AI-generated
  // ones get a flat 0.5/0.5/0.5 that is a placeholder, not a measurement. They
  // were indistinguishable in the payload, so a caller could not tell a
  // derivation from a default -- and 0.5 across all three is the tell.
  const flat = Object.keys(sdt).length === 3 && Object.values(sdt).every((v) => v === 0.5);
  // The four rollups. calculateHigherOrderValues has always existed and was
  // never called: both tools read values.openness and friends straight off the
  // base object, where those keys do not live, so every entry rendered its
  // formula string with an undefined value beside it. (2026-07-31)
  const higherOrder = {
    openness: round2((values.selfDirection + values.stimulation) / 2),
    selfEnhancement: round2((values.achievement + values.power) / 2),
    conservation: round2((values.security + values.conformity + values.tradition) / 3),
    selfTranscendence: round2((values.benevolence + values.universalism) / 2),
  };

  // Stored on registry profiles; absent from a persona-authored block, where
  // the closest honest answer is the level its own values point at. Which of
  // the two happened is reported rather than left to be guessed.
  const stored = (registry as unknown as { maslowLevel?: string })?.maslowLevel;
  const derivedMaslow = (() => {
    const candidates: Array<[string, number]> = [
      ["safety", (values.security + values.conformity) / 2],
      ["belonging", (values.benevolence + (sdt.relatednessNeed ?? 0.5)) / 2],
      ["esteem", (values.achievement + values.power) / 2],
      ["self-actualization", (values.selfDirection + values.universalism) / 2],
    ];
    return candidates.sort((a, b) => b[1] - a[1])[0][0];
  })();

  // A persona's values can be authored by hand or written by the derivation.
  // Both live in the same field, and a value of exactly 0.5 means different
  // things in each case: a deliberate midpoint, or the untouched baseline the
  // derivation starts from. Anything treating values as evidence needs to be
  // able to tell them apart. (2026-07-31)
  const derivation = persona?.valuesDerivation as { method?: string } | undefined;
  const personaSource = derivation?.method === "traits" ? "derived" : "persona";

  // Axes the trait derivation cannot move.
  //
  // Four of the thirteen -- hedonism, power, universalism, relatednessNeed --
  // have no entry in the trait-value correlation table at all, so a derived
  // profile leaves them at the 0.5 baseline no matter what the traits say.
  // That is not a measurement of a midpoint, and anything running with
  // useValues:true will differentiate on the other nine only. selfTranscendence
  // is a rollup of benevolence and universalism, so it is pulled toward 0.5 by
  // an input that was never populated. Stated rather than left to be inferred
  // from a suspicious row of 0.5s. (2026-07-31)
  const counts = valueAxisCorrelationCounts();
  const atBaseline = (k: string) => values[k] === 0.5 || sdt[k] === 0.5;
  const unpopulated = personaSource === "derived"
    ? Object.keys({ ...values, ...sdt }).filter((k) => atBaseline(k) && !counts[k])
    : [];
  // Axes that ARE derived but whose contributions cancelled. A different fact
  // from an axis with no correlations, and the two are indistinguishable by
  // value alone -- both read 0.5.
  const netZero = personaSource === "derived"
    ? Object.keys({ ...values, ...sdt }).filter((k) => atBaseline(k) && !!counts[k])
    : [];

  return {
    values,
    source: registry ? "registry" : (personaSource as "persona"),
    ...(unpopulated.length
      ? {
          unpopulatedAxes: unpopulated,
          unpopulatedNote: `These axes have no trait correlation defined, so the derivation leaves them at the 0.5 baseline regardless of the persona's traits. They carry no signal; a values-weighted run differentiates on the others only.`,
        }
      : {}),
    ...(netZero.length
      ? {
          netZeroAxes: netZero,
          netZeroNote: `These axes ARE derived — trait correlations exist and were applied — but this persona's traits pull them both ways and the contributions cancel near the baseline. Reading 0.5 here means "measured, no net lean", which is not the same as the unpopulated axes above.`,
        }
      : {}),
    // Which rollups inherit a baseline input. openness can be clean while
    // selfTranscendence is half synthetic, and the composite hides that.
    ...(unpopulated.length
      ? (() => {
          const inputs: Record<string, string[]> = {
            openness: ["selfDirection", "stimulation"],
            selfEnhancement: ["achievement", "power"],
            conservation: ["security", "conformity", "tradition"],
            selfTranscendence: ["benevolence", "universalism"],
          };
          const contaminated: Record<string, string> = {};
          for (const [roll, ins] of Object.entries(inputs)) {
            const bad = ins.filter((i) => unpopulated.includes(i));
            if (bad.length) contaminated[roll] = `${bad.length} of ${ins.length} inputs unpopulated (${bad.join(", ")})`;
          }
          return Object.keys(contaminated).length
            ? { higherOrderContamination: contaminated }
            : {};
        })()
      : {}),
    ...(Object.keys(sdt).length ? { sdt, sdtSource: flat ? "default" : "derived" } : {}),
    higherOrder,
    maslowLevel: stored ?? derivedMaslow,
    maslowSource: stored ? "stored" : "derived",
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function registerValuesTools(server: McpServer): void {
  server.registerTool("persona_values_list", {
    title: "List Persona Values",
    description: "List all Schwartz's 10 Universal Values with their meanings, plus higher-order values, Self-Determination Theory needs, and Maslow levels. Use this to understand the values framework before looking up specific personas.",
    inputSchema: {},
    annotations: {
      title: "List Persona Values",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              schwartzValues: {
                selfDirection: { range: "0-1", meaning: "Independent thought, creativity, freedom. High: values autonomy and exploration. Low: prefers guidance and structure." },
                stimulation: { range: "0-1", meaning: "Excitement, novelty, challenge. High: seeks variety and new experiences. Low: prefers routine and predictability." },
                hedonism: { range: "0-1", meaning: "Pleasure, sensuous gratification. High: prioritizes enjoyment and comfort. Low: prioritizes duty over pleasure." },
                achievement: { range: "0-1", meaning: "Personal success through competence. High: driven to excel and demonstrate capability. Low: content without external validation." },
                power: { range: "0-1", meaning: "Social status, prestige, control. High: seeks influence over others/resources. Low: indifferent to status hierarchies." },
                security: { range: "0-1", meaning: "Safety, harmony, stability. High: risk-averse, needs predictability. Low: comfortable with uncertainty." },
                conformity: { range: "0-1", meaning: "Restraint of actions that harm others. High: follows social rules carefully. Low: independent of social expectations." },
                tradition: { range: "0-1", meaning: "Respect for customs, heritage. High: values cultural/religious practices. Low: questions or ignores tradition." },
                benevolence: { range: "0-1", meaning: "Welfare of close others. High: prioritizes helping friends/family. Low: more self-focused." },
                universalism: { range: "0-1", meaning: "Tolerance, social justice, environment. High: cares about all people and nature. Low: focused on in-group." },
              },
              higherOrderValues: {
                openness: { formula: "(selfDirection + stimulation) / 2", meaning: "Openness to change - receptivity to new ideas and experiences" },
                selfEnhancement: { formula: "(achievement + power) / 2", meaning: "Focus on personal success and dominance" },
                conservation: { formula: "(security + conformity + tradition) / 3", meaning: "Preservation of stability and traditional practices" },
                selfTranscendence: { formula: "(benevolence + universalism) / 2", meaning: "Concern for welfare of others and nature" },
              },
              selfDeterminationTheory: {
                autonomyNeed: { range: "0-1", meaning: "Need for choice and self-direction (Deci & Ryan, 1985)" },
                competenceNeed: { range: "0-1", meaning: "Need to feel capable and effective" },
                relatednessNeed: { range: "0-1", meaning: "Need for connection and belonging" },
              },
              maslowLevels: [
                { level: "physiological", meaning: "Basic survival needs (food, water, shelter)" },
                { level: "safety", meaning: "Security, stability, freedom from fear" },
                { level: "belonging", meaning: "Social connection, love, acceptance" },
                { level: "esteem", meaning: "Achievement, recognition, respect" },
                { level: "self-actualization", meaning: "Self-fulfillment, reaching potential" },
              ],
              researchBasis: {
                schwartz: "Schwartz, S. H. (1992, 2012). Theory of Basic Human Values. DOI: 10.1016/S0065-2601(08)60281-6",
                sdt: "Deci, E. L., & Ryan, R. M. (1985, 2000). Self-Determination Theory. DOI: 10.1037/0003-066X.55.1.68",
                maslow: "Maslow, A. H. (1943). A Theory of Human Motivation. DOI: 10.1037/h0054346",
              },
              usage: "Use persona_values_lookup with a persona name to see these values for a specific persona, and list_influence_patterns to see which persuasion patterns work on which values.",
            }, null, 2),
          },
        ],
      };
    }
  );

  /**
   * Whole-persona lookup: traits, values, accessibility and demographics in one
   * call, and the payload the persona view renders.
   *
   * persona_values_lookup stays registered rather than being renamed into this.
   * It is a published tool name that connectors already call, and renaming it
   * in the same deploy as the replacement would break every existing caller --
   * the expand half of expand-contract. It can be retired once nothing calls it.
   */
  server.registerTool("persona_lookup", {
    title: "Look Up Persona",
    description: "Look up a complete persona: cognitive traits, Schwartz values, accessibility traits and demographics. Renders as an interactive profile with per-trait meters. Use this instead of persona_values_lookup when you want the whole persona rather than only its values.",
    inputSchema: {
      persona: z.string().describe("Persona name (e.g., 'first-timer', 'power-user', 'anxious-user')"),
    },
    annotations: {
      title: "Look Up Persona",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { resourceUri: widgetUri("persona") } },
  }, async ({ persona }) => {
      const p = getAnyPersona(persona);
      if (!p) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: `No persona found: ${persona}`,
            hint: "Call list_cognitive_personas for the authoritative roster.",
          }, null, 2) }],
          isError: true,
        };
      }
      const profile = getCognitiveProfile(p as never);
      const values = getPersonaValues((p as { name: string }).name);
      const rec = p as unknown as Record<string, unknown>;

      // Flattened to plain name->number maps because that is what the meters
      // read. The nested {value, meaning} shape values_lookup returns is fine
      // for prose and useless for a bar.
      const payload = {
        name: (p as { name: string }).name,
        description: (p as { description?: string }).description ?? "",
        demographics: rec.demographics ?? {},
        traits: profile?.traits ?? {},
        // One resolver, shared with persona_values_lookup, so the two tools
        // cannot answer the same question differently again.
        ...(() => {
          const r = resolvePersonaValues((p as { name: string }).name);
          if (r.source === "none") {
            return {
              values: null,
              valuesSource: "none",
              valuesNote: "No Schwartz values for this persona. They come from a hand-authored registry, or from a schwartzValues block on the persona itself; this persona has neither. Anything weighting by values is running on defaults for it.",
            };
          }
          return {
            values: r.values,
            valuesSource: r.source,
            ...(r.sdt ? { selfDeterminationNeeds: r.sdt, selfDeterminationSource: r.sdtSource } : {}),
            ...(r.unpopulatedAxes ? { unpopulatedAxes: r.unpopulatedAxes, unpopulatedNote: r.unpopulatedNote } : {}),
            ...(r.netZeroAxes ? { netZeroAxes: r.netZeroAxes, netZeroNote: r.netZeroNote } : {}),
            ...(r.higherOrderContamination ? { higherOrderContamination: r.higherOrderContamination } : {}),
            ...(r.higherOrder ? { higherOrderValues: r.higherOrder } : {}),
            ...(r.maslowLevel ? { maslowLevel: r.maslowLevel, maslowSource: r.maslowSource } : {}),
            ...(r.sdtSource === "default"
              ? { selfDeterminationNote: "All three needs read 0.5, which is the placeholder AI-generated personas ship with rather than a measurement. Questionnaire-derived personas carry computed values here." }
              : {}),
          };
        })(),
        ...(rec.accessibility_traits ? { accessibility_traits: rec.accessibility_traits } : {}),
        ...(rec.accessibilityTraits ? { accessibility_traits: rec.accessibilityTraits } : {}),
        ...(profile?.attentionPattern ? { attentionPattern: profile.attentionPattern } : {}),
        ...(profile?.decisionStyle ? { decisionStyle: profile.decisionStyle } : {}),
        // Where those two came from. "default" means no rule matched and no
        // value was declared -- it is the initial literal, not a reading of
        // this persona, and it should not be acted on as one.
        ...(profile?.attentionPatternSource ? { attentionPatternSource: profile.attentionPatternSource } : {}),
        ...(profile?.decisionStyleSource ? { decisionStyleSource: profile.decisionStyleSource } : {}),
        // Gap to the runner-up style. Near zero means the traits do not favour
        // one, and the label is a weak reading rather than a finding.
        ...(profile?.decisionStyleMargin !== undefined
          ? { decisionStyleMargin: profile.decisionStyleMargin }
          : {}),
        // Author-declared summaries that disagree with the trait vector.
        //
        // A persona can declare attentionPattern "thorough" while carrying
        // attentionSpan 0.35, or a tech_level that its own traits contradict.
        // Both are legitimate authoring -- the declaration wins -- but shipping
        // the two side by side with nothing acknowledging the gap is what makes
        // a profile read as internally inconsistent. Named, not silently
        // reconciled: only the author knows which one is wrong.
        ...(() => {
          const notes: string[] = [];
          const t = (profile?.traits ?? {}) as unknown as Record<string, number>;
          const acc = (rec.accessibility_traits ?? rec.accessibilityTraits ?? {}) as Record<string, number>;
          const demo = (rec.demographics ?? {}) as Record<string, string>;
          const span = acc.attentionSpan;
          if (profile?.attentionPatternSource === "declared" &&
              profile.attentionPattern === "thorough" && typeof span === "number" && span < 0.5) {
            notes.push(`attentionPattern is declared "thorough" but accessibilityTraits.attentionSpan is ${span}. The declaration is used; the traits suggest skimming.`);
          }
          if (profile?.decisionStyleSource === "default") {
            notes.push(`decisionStyle "${profile.decisionStyle}" is the fallback: no rule matched this trait combination and the persona declares none. Do not read it as derived from the traits.`);
          }
          const tech = String(demo.tech_level ?? "");
          const transfer = t.transferLearning, fluency = t.proceduralFluency;
          if (tech && tech !== "expert" && typeof transfer === "number" && transfer >= 0.85 &&
              typeof fluency === "number" && fluency >= 0.65) {
            notes.push(`demographics.tech_level is "${tech}" while transferLearning is ${transfer} and proceduralFluency is ${fluency}. Demographics are set at creation and are not inferred from traits.`);
          }
          return notes.length ? { consistencyNotes: notes } : {};
        })(),
      };

      // JSON in the text block, no structuredContent and no outputSchema.
      //
      // An outputSchema of {} is not "unconstrained" -- the SDK expands it to
      // {type:object, properties:{}, additionalProperties:false}, a schema that
      // permits no properties at all, which every real payload then violates.
      // A schema loose enough to be correct here cannot be expressed as a Zod
      // raw shape anyway, since getStatusInfo-style payloads gain fields over
      // time.
      //
      // The view reads structuredContent when a host forwards it and falls back
      // to content[0].text otherwise, which is the shape Anthropic's own MCP
      // Apps example uses. Dropping both removes the validation failure without
      // costing the widget anything.
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  );

  server.registerTool("persona_values_lookup", {
    title: "Lookup Persona Values",
    description: "Look up the values profile for a persona (Schwartz's 10 Universal Values, SDT needs, Maslow level). Values describe WHO the persona is at a deeper motivational level, informing influence susceptibility.",
    inputSchema: {
      persona: z.string().describe("Persona name (e.g., 'first-timer', 'power-user', 'anxious-user')"),
      includeInfluencePatterns: z.boolean().optional().default(true).describe("Include ranked influence patterns this persona is susceptible to"),
    },
    annotations: {
      title: "Lookup Persona Values",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ persona, includeInfluencePatterns }) => {
      const resolved = resolvePersonaValues(persona);
      // Keyed on "the resolver found something", not on an enumerated list of
      // sources. This read `source === "persona"` and then a later change
      // added "derived" for personas whose values the derivation wrote --
      // which is every regenerated custom persona -- so they stopped matching
      // and fell back into the not-found error the fallback exists to prevent.
      // A condition that enumerates the valid cases has to be revisited every
      // time a case is added; "not none" does not. (2026-07-31)
      const values = getPersonaValues(persona) ?? (resolved.source !== "none"
        ? (resolved.values as unknown as ReturnType<typeof getPersonaValues>)
        : undefined);

      if (!values) {
        const availablePersonas = PERSONA_VALUE_PROFILES.map(p => p.personaName);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `No values profile found for persona: ${persona}`,
                availablePersonas,
                // These are the registry's OWN keys, and several differ from
                // the names every other tool advertises -- "adhd" here against
                // "cognitive-adhd" in empathy_audit, "motor-tremor" against
                // "motor-impairment-tremor". Both forms resolve, because
                // resolvePersonaName aliases them, but a list that teaches the
                // internal vocabulary sends a caller to a different name than
                // the rest of the surface uses. Say so rather than let the
                // list imply these are the canonical names. (2026-07-31)
                availablePersonasNote: "Registry keys. The longer names used by empathy_audit and the persona tools (cognitive-adhd, motor-impairment-tremor, low-vision-magnified) alias onto these and resolve fine. list_cognitive_personas is the authoritative roster.",
                note: "Values come from this registry, or from a schwartzValues block on a custom persona's own file — persona_lookup reads both. Custom personas can also have values added via the questionnaire.",
              }, null, 2),
            },
          ],
        };
      }

      const profile = PERSONA_VALUE_PROFILES.find(
        p => p.personaName.toLowerCase() === persona.toLowerCase()
      );

      let influencePatterns: Array<{pattern: string; susceptibility: number; description: string;
        basis?: { values: string[]; traits: string[]; weighting: string }}> | undefined;
      let influencePatternsTotal: number | undefined;
      let influencePatternsOmitted: string[] | undefined;
      if (includeInfluencePatterns) {
        // Traits passed through, so patterns sharing a value target set can
        // differ and a trait named for its pattern actually reaches it.
        const rankTraits = getCognitiveProfile(getAnyPersona(persona) as never)?.traits as
          unknown as Record<string, number> | undefined;
        const ranked = rankInfluencePatternsForProfile(values, rankTraits);
        // A silent top-7 cut made a mapped pattern look unmapped: social_proof
        // ranks 10th for some personas and simply vanished, with nothing in the
        // response distinguishing "scored low and truncated" from "this trait
        // never reaches the pattern list". The count and the omitted names are
        // reported now. (2026-07-31)
        influencePatternsTotal = ranked.length;
        influencePatternsOmitted = ranked.slice(7).map(r => r.pattern.name);
        // Each score's inputs, so a rank can be traced instead of guessed at.
        // commitment topping the list was untraceable from the output: the
        // reader could see 0.71 and had to reverse-engineer which values and
        // which traits produced it.
        influencePatterns = ranked.slice(0, 7).map(r => ({
          basis: {
            values: r.pattern.targetValues.map((v) => `${v}=${(values as unknown as Record<string, number>)[v] ?? "n/a"}`),
            traits: (r.pattern.relatedTraits ?? []).map(
              (t) => `${t.trait}=${rankTraits?.[t.trait] ?? "n/a"}${t.direction === "negative" ? " (inverted)" : ""}`),
            weighting: "60% value mean, 40% trait mean",
          },
          pattern: r.pattern.name,
          susceptibility: r.susceptibility,
          description: r.pattern.description,
        }));
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              persona,
              rationale: profile?.rationale,
              schwartzValues: {
                selfDirection: { value: values.selfDirection, meaning: "Independent thought, creativity, freedom" },
                stimulation: { value: values.stimulation, meaning: "Excitement, novelty, challenge" },
                hedonism: { value: values.hedonism, meaning: "Pleasure, sensuous gratification" },
                achievement: { value: values.achievement, meaning: "Personal success through competence" },
                power: { value: values.power, meaning: "Social status, prestige, control" },
                security: { value: values.security, meaning: "Safety, harmony, stability" },
                conformity: { value: values.conformity, meaning: "Restraint of actions that harm others" },
                tradition: { value: values.tradition, meaning: "Respect for customs, heritage" },
                benevolence: { value: values.benevolence, meaning: "Welfare of close others" },
                universalism: { value: values.universalism, meaning: "Tolerance, social justice, environment" },
              },
              higherOrderValues: {
                openness: { value: resolved.higherOrder?.openness, meaning: "(selfDirection + stimulation) / 2" },
                selfEnhancement: { value: resolved.higherOrder?.selfEnhancement, meaning: "(achievement + power) / 2" },
                conservation: { value: resolved.higherOrder?.conservation, meaning: "(security + conformity + tradition) / 3" },
                selfTranscendence: { value: resolved.higherOrder?.selfTranscendence, meaning: "(benevolence + universalism) / 2" },
              },
              // From the resolver, which carries the SDT numbers whichever
              // source they came from. Reading them off `values` returned
              // undefined on the persona-file path -- the block rendered three
              // "meaning" strings with no values attached.
              // Values exist here but the persona does not, so nothing can
              // actually be RUN as it. Eight registry keys are in this state;
              // finding that out previously meant diffing this tool's output
              // against list_cognitive_personas by hand.
              ...(getAnyPersona(persona)
                ? {}
                : { runnable: false,
                    runnableNote: `A values profile exists for "${persona}" but no persona does, so it cannot be used by empathy_audit, cognitive_journey or any other tool that runs AS a persona. Values data without a persona behind it.` }),
              ...(resolved.sdtSource ? { selfDeterminationSource: resolved.sdtSource } : {}),
              selfDeterminationTheory: {
                autonomyNeed: { value: resolved.sdt?.autonomyNeed ?? values.autonomyNeed, meaning: "Need for choice and control" },
                competenceNeed: { value: resolved.sdt?.competenceNeed ?? values.competenceNeed, meaning: "Need to feel capable" },
                relatednessNeed: { value: resolved.sdt?.relatednessNeed ?? values.relatednessNeed, meaning: "Need for connection" },
              },
              maslowLevel: {
                level: resolved.maslowLevel ?? values.maslowLevel,
                source: resolved.maslowSource,
                meaning: (resolved.maslowLevel ?? values.maslowLevel) === "physiological" ? "Basic survival needs"
                  : (resolved.maslowLevel ?? values.maslowLevel) === "safety" ? "Security and stability"
                  : (resolved.maslowLevel ?? values.maslowLevel) === "belonging" ? "Social connection and love"
                  : (resolved.maslowLevel ?? values.maslowLevel) === "esteem" ? "Achievement and recognition"
                  : "Self-fulfillment and growth",
              },
              influencePatterns,
              ...(influencePatternsTotal !== undefined && influencePatternsOmitted?.length
                ? {
                    influencePatternsShown: influencePatterns?.length,
                    influencePatternsTotal,
                    influencePatternsOmitted,
                    influencePatternsNote: "Ranked by susceptibility and cut to the top seven. The omitted names ARE mapped and scored -- they ranked below the cut, which is different from a pattern the persona's traits never reach.",
                  }
                : {}),
              // The Schwartz block arrived unattributed here while
              // persona_lookup labelled the same values. Provenance should not
              // depend on which tool you asked.
              valuesSource: resolved.source,
              ...(resolved.unpopulatedAxes
                ? { unpopulatedAxes: resolved.unpopulatedAxes, unpopulatedNote: resolved.unpopulatedNote }
                : {}),
              ...(resolved.netZeroAxes
                ? { netZeroAxes: resolved.netZeroAxes, netZeroNote: resolved.netZeroNote }
                : {}),
              ...(resolved.higherOrderContamination
                ? { higherOrderContamination: resolved.higherOrderContamination }
                : {}),
              researchBasis: {
                schwartz: "Schwartz, S. H. (1992, 2012). Theory of Basic Human Values. DOI: 10.1016/S0065-2601(08)60281-6",
                sdt: "Deci, E. L., & Ryan, R. M. (1985, 2000). Self-Determination Theory. DOI: 10.1037/0003-066X.55.1.68",
                maslow: "Maslow, A. H. (1943). A Theory of Human Motivation. DOI: 10.1037/h0054346",
              },
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("list_influence_patterns", {
    title: "List Influence Patterns",
    description: "List research-backed behavioral persuasion patterns (Cialdini, Kahneman) and which persona values correlate with susceptibility to each pattern.",
    inputSchema: {},
    annotations: {
      title: "List Influence Patterns",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => {
      const patterns = INFLUENCE_PATTERNS.map(pattern => ({
        name: pattern.name,
        description: pattern.description,
        researchBasis: pattern.researchBasis,
        targetValues: pattern.targetValues,
        mechanism: pattern.mechanism,
        examples: pattern.examples,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              count: patterns.length,
              patterns,
              usage: "Use persona_values_lookup to see which patterns a specific persona is susceptible to",
              note: "These patterns describe psychological influence mechanisms. Use ethically for UX optimization, not manipulation.",
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("persona_questionnaire_get", {
    title: "Get Persona Questionnaire",
    description: "Get the persona questionnaire for building a custom persona. Returns research-backed questions that map to cognitive traits. Use comprehensive=true for all 25 traits, or leave false for 8 core traits. v16.12.0: Now includes optional category question for disability-specific value safeguards.",
    inputSchema: {
      comprehensive: z.boolean().optional().default(false).describe("Include all 25 traits (true) or just 8 core traits (false)"),
      traits: z.array(z.string()).optional().describe("Specific trait names to include (overrides comprehensive)"),
      includeCategory: z.boolean().optional().default(true).describe("Include category question for disability-aware values (v16.12.0)"),
    },
    annotations: {
      title: "Get Persona Questionnaire",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ comprehensive, traits, includeCategory }) => {
      const { generatePersonaQuestionnaire, formatForAskUserQuestion, CATEGORY_QUESTION } = await import("../../persona-questionnaire.js");

      const questions = generatePersonaQuestionnaire({
        comprehensive,
        traits: traits as Array<keyof import("../../types.js").CognitiveTraits> | undefined,
      });

      const formatted = formatForAskUserQuestion(questions);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              instructions: "Present these questions to the user one at a time or all at once. Each answer maps to a trait value. After collecting answers, use persona_questionnaire_build to create the persona. v16.12.0: Start with the category question to enable disability-aware value safeguards.",
              questionCount: questions.length,
              questions: formatted,
              rawQuestions: questions,
              ...(includeCategory && {
                categoryQuestion: CATEGORY_QUESTION,
                categoryInstructions: "Ask this FIRST to determine persona category. The category affects which values are applied and provides research-based safeguards for disability simulations.",
              }),
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("persona_questionnaire_build", {
    title: "Build Persona Questionnaire",
    description: "Build a custom persona from questionnaire answers with category-aware value safeguards. Answers should be a map of trait names to values (0-1). Missing traits will use intelligent defaults based on research correlations. v16.12.0: Optionally specify category for disability-specific value handling.",
    inputSchema: {
      name: z.string().describe("Name for the new persona"),
      description: z.string().describe("Description of the persona"),
      answers: z.record(z.string(), z.number()).describe("Map of trait names to values (0-1), e.g. {patience: 0.25, riskTolerance: 0.75}"),
      category: z.enum(PERSONA_CATEGORIES).optional().describe("Persona category for value safeguards (v16.12.0)"),
      valueOverrides: z.record(z.string(), z.number()).optional().describe("Override specific values (0-1) if different from category defaults"),
      save: z.boolean().optional().default(true).describe("Save the persona to disk for future use"),
    },
    annotations: {
      title: "Build Persona Questionnaire",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ name, description, answers, category, valueOverrides, save }) => {
      const {
        buildTraitsFromAnswers,
        getTraitLabel,
        getTraitBehaviors,
        detectPersonaCategory,
        buildValuesFromCategory,
        validateCategoryValues,
      } = await import("../../persona-questionnaire.js");
      const { createCognitivePersona, saveCustomPersona } = await import("../../personas.js");

      const detectedCategory = category || detectPersonaCategory(name, description);
      const traits = buildTraitsFromAnswers(answers);
      const categoryResult = buildValuesFromCategory(
        detectedCategory,
        valueOverrides as Record<string, number> | undefined,
        traits
      );
      const warnings = validateCategoryValues(detectedCategory, categoryResult.values);
      const persona = createCognitivePersona(name, description, traits, {});

      let savedPath: string | undefined;
      if (save) {
        savedPath = saveCustomPersona(persona);
      }

      const traitSummary: Record<string, { value: number; label: string; behaviors: string[] }> = {};
      for (const [trait, value] of Object.entries(traits)) {
        if (value !== 0.5) {
          traitSummary[trait] = {
            value: value as number,
            label: getTraitLabel(trait as keyof import("../../types.js").CognitiveTraits, value as number),
            behaviors: getTraitBehaviors(trait as keyof import("../../types.js").CognitiveTraits, value as number),
          };
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              persona: {
                name: persona.name,
                description: persona.description,
                demographics: persona.demographics,
              },
              cognitiveTraits: traits,
              traitSummary,
              category: {
                detected: detectedCategory,
                strategy: categoryResult.valueStrategy,
                guidance: categoryResult.guidance,
              },
              values: categoryResult.values,
              researchBasis: categoryResult.researchBasis,
              ...(categoryResult.derivations && categoryResult.derivations.length > 0 && {
                valueDerivations: categoryResult.derivations,
              }),
              ...(warnings.length > 0 && { warnings }),
              savedPath,
              usage: `Use persona "${name}" with cognitive-journey or other commands`,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("persona_trait_lookup", {
    title: "Lookup Persona Trait",
    description: "Look up behavioral descriptions for specific trait values. Useful for understanding what a trait value means in practice.",
    inputSchema: {
      trait: z.string().describe("Trait name (e.g., 'patience', 'riskTolerance')"),
      value: z.number().min(0).max(1).describe("Trait value (0-1)"),
    },
    // Declares the trait view. The bands are the finding; the JSON is a list
    // of five level objects a reader has to hold in their head to compare.
_meta: { ui: { resourceUri: "ui://cbrowser/trait-v2" } },
    annotations: {
      title: "Lookup Persona Trait",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ trait, value }) => {
      const { getTraitReference, getTraitLabel, getTraitBehaviors } = await import("../../persona-questionnaire.js");

      const reference = getTraitReference(trait as keyof import("../../types.js").CognitiveTraits);

      if (!reference) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Unknown trait: ${trait}`,
                availableTraits: [
                  "patience", "riskTolerance", "comprehension", "persistence", "curiosity",
                  "workingMemory", "readingTendency", "resilience", "selfEfficacy", "satisficing",
                  "trustCalibration", "interruptRecovery", "informationForaging", "changeBlindness",
                  "anchoringBias", "timeHorizon", "attributionStyle", "metacognitivePlanning",
                  "proceduralFluency", "transferLearning", "authoritySensitivity", "emotionalContagion",
                  "fearOfMissingOut", "socialProofSensitivity", "mentalModelRigidity", "siteFamiliarity"
                ],
              }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              trait: reference.name,
              description: reference.description,
              researchBasis: reference.researchBasis,
              value,
              label: getTraitLabel(trait as keyof import("../../types.js").CognitiveTraits, value),
              behaviors: getTraitBehaviors(trait as keyof import("../../types.js").CognitiveTraits, value),
              allLevels: reference.levels,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("persona_category_guidance", {
    title: "Persona Category Guidance",
    description: "Get guidance for value assignment based on persona category. (v16.12.0) Explains research basis for why cognitive, physical, sensory, and emotional disability categories require different value handling approaches.",
    inputSchema: {
      category: z.enum(PERSONA_CATEGORIES).describe("Persona category to get guidance for"),
    },
    annotations: {
      title: "Persona Category Guidance",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ category }) => {
      const { CATEGORY_VALUE_PRESETS, COGNITIVE_SUBTYPES } = await import("../../persona-questionnaire.js");

      const preset = CATEGORY_VALUE_PRESETS.find(p => p.category === category);

      if (!preset) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Unknown category: ${category}`,
                availableCategories: ["cognitive", "physical", "sensory", "emotional", "general"],
              }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              category: preset.category,
              description: preset.description,
              valueStrategy: preset.valueStrategy,
              guidance: preset.guidance,
              defaultValues: preset.defaultValues,
              researchBasis: preset.researchBasis,
              ...(category === "cognitive" && {
                subtypes: Object.entries(COGNITIVE_SUBTYPES).map(([key, subtype]) => ({
                  name: key,
                  values: subtype.values,
                  researchBasis: subtype.researchBasis,
                })),
              }),
            }, null, 2),
          },
        ],
      };
    }
  );
}
