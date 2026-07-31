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
        // Values from the shared registry, else the ones the persona carries
        // itself, else an explicit statement that there are none.
        //
        // This read the registry alone and omitted the block entirely when it
        // missed -- so a custom persona whose own file carries a full
        // schwartzValues map (all ten values plus the three SDT needs)
        // returned no values at all, from a tool whose description promises
        // them. Silently, with no field saying anything was absent, while the
        // data sat one key away in the same object. (2026-07-31)
        ...(() => {
          const KEYS = ["selfDirection", "stimulation", "hedonism", "achievement", "power",
            "security", "conformity", "tradition", "benevolence", "universalism"] as const;
          const own = rec.schwartzValues as Record<string, number> | undefined;
          const src = values ?? own;
          if (!src) {
            return {
              values: null,
              valuesSource: "none",
              valuesNote: "No Schwartz values for this persona. They come from a hand-authored registry, or from a schwartzValues block on the persona itself; this persona has neither. Anything weighting by values is running on defaults for it.",
            };
          }
          const out: Record<string, number> = {};
          for (const k of KEYS) {
            const v = (src as Record<string, number>)[k];
            if (typeof v === "number") out[k] = v;
          }
          return {
            values: out,
            valuesSource: values ? "registry" : "persona",
            // The SDT needs travel with a persona-authored block and are not
            // part of the ten; passed through rather than dropped.
            ...(!values && own
              ? (() => {
                  const extra: Record<string, number> = {};
                  ["autonomyNeed", "competenceNeed", "relatednessNeed"].forEach((k) => {
                    if (typeof own[k] === "number") extra[k] = own[k];
                  });
                  return Object.keys(extra).length ? { selfDeterminationNeeds: extra } : {};
                })()
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
      const values = getPersonaValues(persona);

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

      let influencePatterns: Array<{pattern: string; susceptibility: number; description: string}> | undefined;
      if (includeInfluencePatterns) {
        const ranked = rankInfluencePatternsForProfile(values);
        influencePatterns = ranked.slice(0, 7).map(r => ({
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
                openness: { value: values.openness, meaning: "(selfDirection + stimulation) / 2" },
                selfEnhancement: { value: values.selfEnhancement, meaning: "(achievement + power) / 2" },
                conservation: { value: values.conservation, meaning: "(security + conformity + tradition) / 3" },
                selfTranscendence: { value: values.selfTranscendence, meaning: "(benevolence + universalism) / 2" },
              },
              selfDeterminationTheory: {
                autonomyNeed: { value: values.autonomyNeed, meaning: "Need for choice and control" },
                competenceNeed: { value: values.competenceNeed, meaning: "Need to feel capable" },
                relatednessNeed: { value: values.relatednessNeed, meaning: "Need for connection" },
              },
              maslowLevel: {
                level: values.maslowLevel,
                meaning: values.maslowLevel === "physiological" ? "Basic survival needs"
                  : values.maslowLevel === "safety" ? "Security and stability"
                  : values.maslowLevel === "belonging" ? "Social connection and love"
                  : values.maslowLevel === "esteem" ? "Achievement and recognition"
                  : "Self-fulfillment and growth",
              },
              influencePatterns,
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
