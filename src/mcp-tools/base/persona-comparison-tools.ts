/**
 * CBrowser MCP Tools - Persona Comparison Tools
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import type { McpServer, ToolRegistrationContext } from "../types.js";
import { comparePersonas } from "../../analysis/index.js";
import { isApiKeyConfigured } from "../../cognitive/index.js";
import {
  getAnyPersona,
  getCognitiveProfile,
  createCognitivePersona,
  isAgentPersonaObject,
} from "../../personas.js";
import type { Persona, AccessibilityPersona, CognitiveState } from "../../types.js";
import {
  buildOTCognitiveProfile as buildOTProfile,
  cognitiveDistance,
  cognitiveBarycenter,
  cognitiveGeodesic,
  cognitiveDistanceMatrix,
  selectMaxCoveragePersonas,
  generateAdversarialPersonas,
  estimateCognitiveLoad,
  type OTCognitiveProfile,
} from "../../visual/cognitive-transport.js";

/**
 * Register persona comparison tools (3 tools: compare_personas, compare_personas_init, compare_personas_complete)
 */
export function registerPersonaComparisonTools(
  server: McpServer,
  { getBrowser, getBrowserByToken }: ToolRegistrationContext
): void {
  server.registerTool("compare_personas", {
    title: "Compare Personas on Site",
    description: "Compare how different user personas experience a journey. In Claude Code sessions (no API key), use compare_personas_init and compare_personas_complete instead for the bridge workflow.",
    inputSchema: {
      url: z.string().url().describe("Starting URL"),
      goal: z.string().describe("Goal to accomplish"),
      personas: z.array(z.string()).describe("Persona names to compare"),
    },
    annotations: {
      title: "Compare Personas on Site",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ url, goal, personas }) => {
      const hasApiKey = isApiKeyConfigured();

      if (!hasApiKey) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                mode: "bridge",
                message: "Running in Claude Code session - use the bridge workflow for API-free persona comparison",
                instructions: `
COMPARE PERSONAS BRIDGE WORKFLOW (No API Key Required):

1. Call compare_personas_init with your URL, goal, and personas list
2. For each persona returned, run a cognitive_journey_init and drive the journey using browser tools
3. After all journeys complete, call compare_personas_complete with the results

Example:
1. compare_personas_init({ url: "${url}", goal: "${goal}", personas: ${JSON.stringify(personas)} })
2. For each persona: cognitive_journey_init → navigate/click/fill → track state
3. compare_personas_complete({ journeyResults: [...], url: "${url}", goal: "${goal}" })
`,
                url,
                goal,
                personas,
              }, null, 2),
            },
          ],
        };
      }

      const result = await comparePersonas({
        startUrl: url,
        goal,
        personas,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: result.url,
              goal: result.goal,
              personasCompared: result.personas.length,
              summary: result.summary,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("compare_personas_init", {
    title: "Initialize Persona Comparison",
    description: "Initialize persona comparison for Claude Code bridge workflow. Returns persona profiles and instructions for running journeys without API key.",
    inputSchema: {
      url: z.string().url().describe("Starting URL for all journeys"),
      goal: z.string().describe("Goal to accomplish"),
      personas: z.array(z.string()).describe("Persona names to compare (e.g., ['first-timer', 'power-user', 'elderly-user'])"),
    },
    annotations: {
      title: "Initialize Persona Comparison",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ url, goal, personas }) => {
      // v17.0.0: Filter out agent personas - persona comparison doesn't support them
      const filteredPersonas = personas.filter(name => {
        const persona = getAnyPersona(name);
        if (persona && isAgentPersonaObject(persona)) {
          console.warn(`[CBrowser] Skipping agent persona "${name}" - not supported for persona comparison`);
          return false;
        }
        return true;
      });

      const personaProfiles = filteredPersonas.map((personaName) => {
        const existingPersona = getAnyPersona(personaName);
        let personaObj: Persona | AccessibilityPersona;

        if (!existingPersona) {
          personaObj = createCognitivePersona(personaName, personaName, {});
        } else {
          // Safe cast - we filtered out agent personas above
          personaObj = existingPersona as Persona | AccessibilityPersona;
        }

        const profile = getCognitiveProfile(personaObj);

        return {
          name: personaName,
          description: personaObj.description,
          demographics: personaObj.demographics,
          cognitiveTraits: profile.traits,
          attentionPattern: profile.attentionPattern,
          decisionStyle: profile.decisionStyle,
        };
      });

      // v18.27.0: Compute cognitive distance matrix via optimal transport
      const otProfiles = personaProfiles.map(p =>
        buildOTProfile(p.name, p.cognitiveTraits as unknown as Record<string, number> || {})
      );
      const { matrix: distMatrix } = cognitiveDistanceMatrix(otProfiles);
      const bary = cognitiveBarycenter(otProfiles);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mode: "compare_personas_bridge",
              url,
              goal,
              personaCount: personas.length,
              // v18.27.0: Wasserstein cognitive distance analysis
              cognitiveAnalysis: {
                distanceMatrix: distMatrix.map((row, i) => ({
                  persona: filteredPersonas[i],
                  distances: Object.fromEntries(filteredPersonas.map((name, j) => [name, Math.round(row[j] * 10000) / 10000])),
                })),
                consensusMind: {
                  meanDistance: Math.round(bary.meanDistance * 10000) / 10000,
                  outlierPersona: bary.outlierPersona,
                  outlierReason: "Farthest from consensus cognitive profile (worst-served by generic design)",
                },
              },
              personas: personaProfiles,
              instructions: `
PERSONA COMPARISON BRIDGE WORKFLOW:

You have ${personas.length} personas to compare. For each persona:

1. Call cognitive_journey_init with the persona name, goal, and URL
2. Drive the journey using browser tools (navigate, click, fill, screenshot)
3. Track cognitive state using cognitive_journey_update_state
4. Continue until goal achieved or persona abandons
5. Record the final result

After ALL personas complete their journeys, call compare_personas_complete with:
{
  url: "${url}",
  goal: "${goal}",
  journeyResults: [
    {
      persona: "persona-name",
      goalAchieved: true/false,
      totalTime: seconds,
      stepCount: number,
      finalState: { patienceRemaining, frustrationLevel, confusionLevel },
      abandonmentReason: null or "patience" | "frustration" | "confusion" | "timeout" | "loop",
      frictionPoints: ["description of friction point", ...]
    },
    // ... one for each persona
  ]
}

PERSONA ORDER:
${personaProfiles.map((p, i) => `${i + 1}. ${p.name} - ${p.description}`).join("\n")}

Begin with the first persona: ${personas[0]}
`,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("compare_personas_complete", {
    title: "Complete Persona Comparison",
    description: "Complete persona comparison by aggregating journey results. Call this after running all persona journeys via the bridge workflow.",
    inputSchema: {
      url: z.string().url().describe("The URL that was tested"),
      goal: z.string().describe("The goal that was attempted"),
      journeyResults: z.array(z.object({
        persona: z.string().describe("Persona name"),
        goalAchieved: z.boolean().describe("Whether the goal was achieved"),
        totalTime: z.number().describe("Total time in seconds"),
        stepCount: z.number().describe("Number of steps taken"),
        finalState: z.object({
          patienceRemaining: z.number(),
          frustrationLevel: z.number(),
          confusionLevel: z.number(),
        }).describe("Final cognitive state"),
        abandonmentReason: z.enum(["patience", "frustration", "confusion", "timeout", "loop"]).nullable().describe("Why journey ended if not goal achieved"),
        frictionPoints: z.array(z.string()).describe("List of friction point descriptions"),
      })).describe("Results from each persona journey"),
    },
    annotations: {
      title: "Complete Persona Comparison",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ url, goal, journeyResults }) => {
      const startTime = Date.now();

      const successfulResults = journeyResults.filter((r) => r.goalAchieved);
      const failedResults = journeyResults.filter((r) => !r.goalAchieved);

      const sortedByTime = [...successfulResults].sort((a, b) => a.totalTime - b.totalTime);
      const sortedByFriction = [...journeyResults].sort((a, b) => b.frictionPoints.length - a.frictionPoints.length);

      const allFrictionPoints = journeyResults.flatMap((r) => r.frictionPoints);
      const frictionCounts = allFrictionPoints.reduce((acc, fp) => {
        acc[fp] = (acc[fp] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const commonFriction = Object.entries(frictionCounts)
        .filter(([_, count]) => count > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([fp]) => fp);

      const recommendations: string[] = [];

      const abandonedByPatience = failedResults.filter((r) => r.abandonmentReason === "patience");
      const abandonedByFrustration = failedResults.filter((r) => r.abandonmentReason === "frustration");
      const abandonedByConfusion = failedResults.filter((r) => r.abandonmentReason === "confusion");

      if (abandonedByPatience.length > 0) {
        recommendations.push(
          `${abandonedByPatience.length} persona(s) abandoned due to PATIENCE exhaustion: ${abandonedByPatience.map((r) => r.persona).join(", ")} - consider shorter flows`
        );
      }

      if (abandonedByFrustration.length > 0) {
        recommendations.push(
          `${abandonedByFrustration.length} persona(s) abandoned due to FRUSTRATION: ${abandonedByFrustration.map((r) => r.persona).join(", ")} - review error messages and feedback`
        );
      }

      if (abandonedByConfusion.length > 0) {
        recommendations.push(
          `${abandonedByConfusion.length} persona(s) abandoned due to CONFUSION: ${abandonedByConfusion.map((r) => r.persona).join(", ")} - improve UI clarity and labeling`
        );
      }

      if (sortedByFriction[0]?.frictionPoints.length > 0) {
        const worstPersona = sortedByFriction[0];
        const avgFrustration = worstPersona.finalState.frustrationLevel;
        recommendations.push(
          `"${worstPersona.persona}" experienced the most friction (${worstPersona.frictionPoints.length} points, ${Math.round(avgFrustration * 100)}% frustration)`
        );
      }

      if (commonFriction.length > 0) {
        recommendations.push(
          `Common friction across personas: ${commonFriction.slice(0, 2).join("; ")}`
        );
      }

      if (recommendations.length === 0) {
        recommendations.push(
          "All personas completed the journey without significant cognitive barriers"
        );
      }

      const avgTime = successfulResults.length > 0
        ? successfulResults.reduce((sum, r) => sum + r.totalTime, 0) / successfulResults.length
        : 0;

      const comparison = {
        url,
        goal,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        personas: journeyResults.map((r) => ({
          persona: r.persona,
          success: r.goalAchieved,
          totalTime: r.totalTime * 1000,
          stepCount: r.stepCount,
          frictionCount: r.frictionPoints.length,
          frictionPoints: r.frictionPoints,
          cognitive: {
            patienceRemaining: r.finalState.patienceRemaining,
            frustrationLevel: r.finalState.frustrationLevel,
            confusionLevel: r.finalState.confusionLevel,
            abandonmentReason: r.abandonmentReason,
          },
        })),
        summary: {
          totalPersonas: journeyResults.length,
          successCount: successfulResults.length,
          failureCount: failedResults.length,
          fastestPersona: sortedByTime[0]?.persona || "N/A",
          slowestPersona: sortedByTime[sortedByTime.length - 1]?.persona || "N/A",
          mostFriction: sortedByFriction[0]?.persona || "N/A",
          leastFriction: sortedByFriction[sortedByFriction.length - 1]?.persona || "N/A",
          avgCompletionTime: Math.round(avgTime * 1000),
          commonFrictionPoints: commonFriction,
        },
        recommendations,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(comparison, null, 2),
          },
        ],
      };
    }
  );

  // ── Cognitive Transport Tools (v18.27.0) ──

  server.registerTool("cognitive_distance", {
    title: "Cognitive Distance Between Personas",
    description: "Compute the Wasserstein cognitive distance between two personas. Returns W₁ distance (true cognitive distance), per-trait contributions, and Bures-Wasserstein W₂ distance. Based on optimal transport theory — transport cost = cognitive processing cost.",
    inputSchema: {
      personaA: z.string().describe("First persona name"),
      personaB: z.string().describe("Second persona name"),
    },
    annotations: {
      title: "Cognitive Distance Between Personas",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ personaA, personaB }) => {
      const pA = getAnyPersona(personaA);
      const pB = getAnyPersona(personaB);
      if (!pA || !pB) {
        return { content: [{ type: "text" as const, text: `Persona not found: ${!pA ? personaA : personaB}` }] };
      }
      const profileA = getCognitiveProfile(pA as Persona | AccessibilityPersona);
      const profileB = getCognitiveProfile(pB as Persona | AccessibilityPersona);
      const otA = buildOTProfile(personaA, profileA.traits as unknown as Record<string, number> || {});
      const otB = buildOTProfile(personaB, profileB.traits as unknown as Record<string, number> || {});
      const dist = cognitiveDistance(otA, otB);

      // Top 5 trait contributions
      const topTraits = Object.entries(dist.traitContributions)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([trait, contrib]) => ({ trait, contribution: Math.round(contrib * 10000) / 10000 }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            personaA, personaB,
            w1Distance: Math.round(dist.w1 * 10000) / 10000,
            w2Distance: Math.round(dist.w2 * 10000) / 10000,
            slicedWasserstein: Math.round(dist.sliced * 10000) / 10000,
            interpretation: dist.w1 < 0.01 ? "Nearly identical cognitive profiles"
              : dist.w1 < 0.03 ? "Similar cognitive profiles with minor differences"
              : dist.w1 < 0.06 ? "Moderately different cognitive profiles"
              : "Substantially different cognitive profiles",
            topDifferentiatingTraits: topTraits,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool("cognitive_coverage", {
    title: "Maximum Coverage Persona Selection",
    description: "Select the N most cognitively different personas from a list for maximum test coverage. Uses greedy farthest-point sampling in Wasserstein space.",
    inputSchema: {
      personas: z.array(z.string()).describe("List of persona names to select from"),
      count: z.number().describe("Number of personas to select"),
    },
    annotations: {
      title: "Maximum Coverage Persona Selection",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ personas, count }) => {
      const profiles: OTCognitiveProfile[] = [];
      for (const name of personas) {
        const p = getAnyPersona(name);
        if (!p) continue;
        const profile = getCognitiveProfile(p as Persona | AccessibilityPersona);
        profiles.push(buildOTProfile(name, profile.traits as unknown as Record<string, number> || {}));
      }
      const selected = selectMaxCoveragePersonas(profiles, count);
      const { matrix } = cognitiveDistanceMatrix(selected);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            selectedPersonas: selected.map(p => p.name),
            coverage: "Maximum cognitive diversity — these personas are the most different from each other",
            distanceMatrix: matrix.map((row, i) => ({
              persona: selected[i].name,
              distances: Object.fromEntries(selected.map((s, j) => [s.name, Math.round(row[j] * 10000) / 10000])),
            })),
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool("cognitive_interpolate", {
    title: "Persona Geodesic Interpolation",
    description: "Generate an interpolated persona between two known personas using Wasserstein geodesic. Preserves trait coupling structure — the midpoint between ADHD and power-user has intermediate trait correlations, not just averaged values.",
    inputSchema: {
      personaA: z.string().describe("Starting persona"),
      personaB: z.string().describe("Ending persona"),
      position: z.number().min(0).max(1).optional().default(0.5).describe("Position on geodesic (0=A, 0.5=midpoint, 1=B)"),
    },
    annotations: {
      title: "Persona Geodesic Interpolation",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ personaA, personaB, position }) => {
      const pA = getAnyPersona(personaA);
      const pB = getAnyPersona(personaB);
      if (!pA || !pB) {
        return { content: [{ type: "text" as const, text: `Persona not found: ${!pA ? personaA : personaB}` }] };
      }
      const profileA = getCognitiveProfile(pA as Persona | AccessibilityPersona);
      const profileB = getCognitiveProfile(pB as Persona | AccessibilityPersona);
      const otA = buildOTProfile(personaA, profileA.traits as unknown as Record<string, number> || {});
      const otB = buildOTProfile(personaB, profileB.traits as unknown as Record<string, number> || {});

      const geodesic = cognitiveGeodesic(otA, otB, 10);
      const closestIdx = geodesic.reduce((best, p, i) =>
        Math.abs(p.t - position) < Math.abs(geodesic[best].t - position) ? i : best, 0);
      const point = geodesic[closestIdx];

      // Identify which traits changed most from A
      const traitDiffs = Object.entries(point.traits)
        .map(([trait, val]) => ({ trait, value: Math.round(val * 100) / 100, fromA: Math.round(((otA.traits[trait] ?? 0.5) - val) * 100) / 100 }))
        .sort((a, b) => Math.abs(b.fromA) - Math.abs(a.fromA))
        .slice(0, 8);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            interpolatedPersona: {
              name: `${personaA}-${personaB}-${Math.round(position * 100)}pct`,
              position: point.t,
              traits: point.traits,
            },
            description: `Persona at ${Math.round(point.t * 100)}% along the Wasserstein geodesic from ${personaA} to ${personaB}`,
            topChangedTraits: traitDiffs,
          }, null, 2),
        }],
      };
    }
  );

  server.registerTool("cognitive_load_estimate", {
    title: "Cognitive Load Estimate",
    description: "Estimate cognitive load for a specific persona on page metrics. Returns per-dimension breakdown (information, visual, attention, decision, motor, text, memory, patience) and identifies the bottleneck dimension.",
    inputSchema: {
      persona: z.string().describe("Persona name"),
      informationDensity: z.number().min(0).max(1).describe("Content density (0=sparse, 1=dense)"),
      visualComplexity: z.number().min(0).max(1).describe("Visual complexity (0=simple, 1=complex)"),
      interactiveElements: z.number().describe("Number of interactive elements"),
      textDensity: z.number().min(0).max(1).describe("Text heaviness (0=minimal, 1=wall of text)"),
      animationLevel: z.number().min(0).max(1).describe("Animation/motion amount"),
      choiceCount: z.number().describe("Number of decision points/options"),
      navigationDepth: z.number().describe("Clicks needed to reach content"),
    },
    annotations: {
      title: "Cognitive Load Estimate",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ persona, informationDensity, visualComplexity, interactiveElements, textDensity, animationLevel, choiceCount, navigationDepth }) => {
      const p = getAnyPersona(persona);
      if (!p) return { content: [{ type: "text" as const, text: `Persona not found: ${persona}` }] };
      const profile = getCognitiveProfile(p as Persona | AccessibilityPersona);
      const otProfile = buildOTProfile(persona, profile.traits as unknown as Record<string, number> || {});

      const load = estimateCognitiveLoad(otProfile, {
        informationDensity, visualComplexity, interactiveElementCount: interactiveElements,
        textDensity, animationLevel, choiceCount, navigationDepth,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            persona,
            totalLoad: Math.round(load.totalLoad * 100) / 100,
            overloaded: load.overloaded,
            bottleneck: load.bottleneck,
            breakdown: Object.fromEntries(
              Object.entries(load.breakdown).map(([k, v]) => [k, Math.round(v * 100) / 100])
            ),
            recommendation: load.overloaded
              ? `${persona} is cognitively overloaded. Primary bottleneck: ${load.bottleneck}. Reduce ${load.bottleneck} complexity to improve experience.`
              : `${persona} can handle this page. Closest to overload on: ${load.bottleneck}.`,
          }, null, 2),
        }],
      };
    }
  );

  // ── Cognitive Effort (Full COT) ──

  server.registerTool("cognitive_effort", {
    title: "Cognitive Effort Analysis",
    description: "Compute total cognitive effort for a persona to use a page. Uses the full 6-layer Sequential Transport Chain from Cognitive Optimal Transport theory: saliency → cognitive load → decision complexity → motor accessibility → frustration → readability. Each layer depletes capacity for subsequent layers. Returns per-layer costs, interaction effects, deficit/surplus breakdown, bottleneck layer, and abandonment risk.",
    inputSchema: {
      url: z.string().url().describe("URL to analyze"),
      persona: z.string().describe("Persona name (e.g., 'first-timer', 'cognitive-adhd', 'elderly-user', 'autism-spectrum')"),
      _browserToken: z.string().optional().describe("Browser session token"),
      userLocation: z.string().optional().describe("User's approximate location (e.g., 'Denver, Colorado, US')"),
      userTimezone: z.string().optional().describe("User's timezone (e.g., 'America/Denver')"),
      userLanguage: z.string().optional().describe("User's expected language (e.g., 'en-US')"),
      proxy: z.string().optional().describe("Proxy server URL for geo-accurate testing"),
      geoRegion: z.string().optional().describe("Route through a residential proxy in this region: us-west, us-east, us-central, uk, germany, japan"),
      device: z.string().optional().describe("Device emulation: 'mobile', 'tablet', 'desktop', or specific device name"),
      useValues: z.boolean().optional().default(false).describe("Enable motivational value modulation (Schwartz values). When true, persona values modulate saliency maps, decision costs, and frustration costs. Default: false (trait-only mode)."),
    },
    annotations: {
      title: "Cognitive Effort Analysis",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ url, persona: personaName, _browserToken, userLocation, userTimezone, userLanguage, proxy, useValues }) => {
    try {
      // Get browser
      let b: Awaited<ReturnType<typeof getBrowser>>;
      let token: string | undefined;
      if (getBrowserByToken) {
        const result = await getBrowserByToken(_browserToken);
        b = result.browser;
        token = result.token;
      } else {
        b = await getBrowser();
      }

      // Navigate
      await b.navigate(url);
      const page = await b.getPage();

      // Detect language mismatch
      const expectedLang = (userLanguage || "en-US").split("-")[0];
      const pageLang = await page.evaluate(() => document.documentElement.lang || "").catch(() => "");
      const pageLangShort = pageLang.split("-")[0].toLowerCase();
      let languageWarning: string | undefined;
      if (pageLangShort && pageLangShort !== expectedLang.toLowerCase() && pageLangShort !== "") {
        languageWarning = `Page language "${pageLang}" does not match expected "${userLanguage || 'en-US'}". Site may be geo-detecting server IP, not user locale.`;
      }

      // Check if page is blocked/error
      const pageTitle = await page.title().catch(() => '');
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
      const httpStatus = await page.evaluate(() => {
        const perf = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        return perf?.responseStatus || 200;
      }).catch(() => 200);

      const BLOCK_SIGNATURES = [
        'access denied', '403 forbidden', 'just a moment', 'press & hold',
        'verify you are human', 'captcha', 'blocked', 'robot check',
        'cloudflare', 'please wait', 'checking your browser',
      ];
      const lowerTitle = pageTitle.toLowerCase();
      const lowerBody = bodyText.toLowerCase();
      const isBlocked = httpStatus >= 400 ||
        BLOCK_SIGNATURES.some(sig => lowerTitle.includes(sig) || lowerBody.includes(sig));

      if (isBlocked) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "page_blocked",
              url,
              persona: personaName,
              httpStatus,
              detectedSignature: BLOCK_SIGNATURES.find(sig => lowerTitle.includes(sig) || lowerBody.includes(sig)) || `HTTP ${httpStatus}`,
              pageTitle,
              message: "The page returned an error or bot challenge. Cognitive effort cannot be measured on blocked pages.",
              suggestion: "Try with stealth mode enabled, or verify the URL loads in a regular browser.",
              ...(token ? { _browserToken: token } : {}),
            }, null, 2),
          }],
        };
      }

      // Get persona
      const existingPersona = getAnyPersona(personaName);
      let personaObj: Persona;
      if (!existingPersona || isAgentPersonaObject(existingPersona)) {
        personaObj = createCognitivePersona(personaName, personaName, {});
      } else {
        personaObj = existingPersona as Persona;
      }

      // Build OT profile
      const otProfile = buildOTProfile(
        personaName,
        (personaObj.cognitiveTraits || {}) as unknown as Record<string, number>
      );

      // Extract page metrics
      const { extractPageMetrics } = await import("../../visual/cognitive-transport.js");
      const pageMetrics = await extractPageMetrics(page);

      // Compute full COT
      const { computeDemandDistribution, computeSequentialCTC } = await import("../../visual/cognitive-transport-chain.js");
      const demand = computeDemandDistribution(pageMetrics);

      // Modulate demand by motivational values (opt-in, default off)
      if (useValues) try {
        const { getPersonaValues, registerPersonaValues: regPV2, createPersonaValues: createPV2 } = await import("../../values/index.js");
        let pValues = getPersonaValues(personaName);

        // Custom persona CMS fallback
        if (!pValues) {
          try {
            const { getSessionApiKey } = await import("./cognitive-tools.js"); const _sessionApiKey = getSessionApiKey();
            if (_sessionApiKey) {
              const cmsUrl = process.env.CMS_URL || "http://localhost:3200";
              const res = await fetch(`${cmsUrl}/api/personas`, { headers: { "Authorization": `Bearer ${_sessionApiKey}` } });
              if (res.ok) {
                const data = await res.json() as { personas: Array<{ name: string; slug: string; schwartz_values?: string }> };
                const match = data.personas.find((p: any) => p.slug === personaName || p.name.toLowerCase() === personaName.toLowerCase());
                if (match?.schwartz_values) {
                  const sv = typeof match.schwartz_values === "string" ? JSON.parse(match.schwartz_values) : match.schwartz_values;
                  const pv = createPV2(
                    { selfDirection: sv.selfDirection ?? 0.5, stimulation: sv.stimulation ?? 0.5, hedonism: sv.hedonism ?? 0.5, achievement: sv.achievement ?? 0.5, power: sv.power ?? 0.5, security: sv.security ?? 0.5, conformity: sv.conformity ?? 0.5, tradition: sv.tradition ?? 0.5, benevolence: sv.benevolence ?? 0.5, universalism: sv.universalism ?? 0.5 },
                    { autonomyNeed: sv.autonomyNeed ?? 0.5, competenceNeed: sv.competenceNeed ?? 0.5, relatednessNeed: sv.relatednessNeed ?? 0.5 },
                    "esteem"
                  );
                  regPV2([{ personaName, values: pv, rationale: "Custom persona from CMS" }]);
                  pValues = pv;
                }
              }
            }
          } catch { /* CMS fallback failed */ }
        }
        if (pValues && demand.demands) {
          // Conservation (security+conformity+tradition)/3 amplifies decision layer
          const conservation = (pValues.security + pValues.conformity + pValues.tradition) / 3;
          // Openness (selfDirection+stimulation)/2 reduces decision cost (comfortable with choices)
          const openness = (pValues.selfDirection + pValues.stimulation) / 2;
          // Achievement amplifies frustration layer (impatience)
          const achMod = 1 + (pValues.achievement - 0.5) * 0.3;

          // Scale decision-related demands: satisficing, anchoringBias, riskTolerance, fearOfMissingOut
          const decisionScale = 1 + (conservation - openness) * 0.3; // -0.15 to +0.15 range
          for (const dim of ["satisficing", "anchoringBias", "riskTolerance", "fearOfMissingOut", "socialProofSensitivity"]) {
            if (demand.demands[dim] !== undefined) {
              demand.demands[dim] *= decisionScale;
            }
          }
          // Scale frustration-related demands
          for (const dim of ["resilience", "selfEfficacy", "emotionalContagion"]) {
            if (demand.demands[dim] !== undefined) {
              demand.demands[dim] *= achMod;
            }
          }
        }
      } catch { /* values not available — proceed without */ }

      const result = computeSequentialCTC(otProfile, demand, { asymmetric: true, interactions: true });

      // Also compute motor and readability from formal models
      let motorResult = null;
      let readabilityResult = null;
      try {
        const { motorAccessibility, readability, getPointingProfile, getReadingProfile } = await import("../../visual/cognitive-models.js");

        // Get interactive elements for motor analysis — viewport-visible only
        const elements = await page.evaluate(() => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const interactive = document.querySelectorAll('a, button, input, select, textarea, [role="button"]');
          return Array.from(interactive).filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 &&
              rect.bottom > 0 && rect.top < vh &&
              rect.right > 0 && rect.left < vw;
          }).slice(0, 30).map((el) => {
            const rect = el.getBoundingClientRect();
            const cx = vw / 2;
            const cy = vh / 2;
            return {
              selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''),
              width: rect.width,
              height: rect.height,
              distance: Math.sqrt((rect.x + rect.width/2 - cx) ** 2 + (rect.y + rect.height/2 - cy) ** 2),
            };
          });
        });

        motorResult = motorAccessibility(elements, otProfile);

        // Get text blocks for readability analysis — viewport-visible only
        const textBlocks = await page.evaluate(() => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const blocks: Array<{ text: string; fontSize: number; lineHeight: number; fontFamily: string; isSerif: boolean; contrastRatio: number }> = [];
          const textEls = Array.from(document.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, th, span, div'));
          for (const el of textEls) {
            const rect = (el as HTMLElement).getBoundingClientRect();
            if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) continue;
            if (rect.width === 0 || rect.height === 0) continue;
            const text = (el as HTMLElement).innerText?.trim();
            if (!text || text.length < 20) continue;
            const style = window.getComputedStyle(el);
            const fontSize = parseFloat(style.fontSize) || 16;
            const lineHeight = parseFloat(style.lineHeight) / fontSize || 1.5;
            const fontFamily = style.fontFamily || 'sans-serif';
            const isSerif = /serif/i.test(fontFamily) && !/sans-serif/i.test(fontFamily);
            blocks.push({ text: text.slice(0, 500), fontSize, lineHeight, fontFamily, isSerif, contrastRatio: 7 });
            if (blocks.length >= 20) break;
          }
          return blocks;
        });

        if (textBlocks.length > 0) {
          readabilityResult = readability(textBlocks, otProfile);
        }
      } catch {}

      // Format response
      const response: Record<string, unknown> = {
        url,
        persona: personaName,
        cognitiveTransportCost: {
          total: Math.round(result.totalCTC * 1000) / 1000,
          additive: Math.round(result.additiveCTC * 1000) / 1000,
          sequentialAmplification: Math.round((result.totalCTC / Math.max(0.001, result.additiveCTC)) * 100) / 100,
        },
        layers: result.layers.map(l => ({
          name: l.name,
          cost: Math.round(l.transportCost * 1000) / 1000,
          capacityConsumed: Math.round(l.capacityConsumed * 1000) / 1000,
        })),
        bottleneck: result.bottleneckLayer,
        deficitVsSurplus: {
          deficit: Math.round(result.deficitCost * 1000) / 1000,
          surplus: Math.round(result.surplusCost * 1000) / 1000,
        },
        abandonmentRisk: Math.round(result.abandonmentRisk * 100) + "%",
        interactions: Object.fromEntries(
          Object.entries(result.interactions)
            .filter(([, v]) => v > 0.001)
            .map(([k, v]) => [k, Math.round(v * 1000) / 1000])
        ),
        ...(motorResult ? {
          motorAccessibility: {
            score: Math.round(motorResult.score * 100) + "%",
            barriers: motorResult.barrierCount,
            elements: motorResult.elements.filter((e: { isBarrier: boolean }) => e.isBarrier).slice(0, 5).map((e: { selector: string; hitProbability: number; movementTime: number }) => ({
              element: e.selector,
              hitProbability: Math.round(e.hitProbability * 100) + "%",
              movementTimeMs: Math.round(e.movementTime),
            })),
          },
        } : {}),
        ...(readabilityResult ? {
          readability: {
            score: Math.round(readabilityResult.score * 100) + "%",
            averageWPM: Math.round(
              readabilityResult.blocks.reduce((s: number, b: { wordsPerMinute: number }) => s + b.wordsPerMinute, 0) / readabilityResult.blocks.length
            ),
            hardestBlock: readabilityResult.blocks.length > 0
              ? (readabilityResult.blocks as Array<{ difficulty: number; penalties: string[] }>).reduce((worst, b) => b.difficulty > worst.difficulty ? b : worst).penalties
              : [],
          },
        } : {}),
        interpretation: result.totalCTC < 0.3
          ? `${personaName} should handle this page comfortably.`
          : result.totalCTC < 0.6
          ? `${personaName} will experience moderate cognitive effort. Bottleneck: ${result.bottleneckLayer}.`
          : result.totalCTC < 0.8
          ? `${personaName} will struggle significantly. ${result.bottleneckLayer} is the primary barrier. Consider simplifying.`
          : `${personaName} is likely to abandon this page. Cognitive transport cost is ${Math.round(result.totalCTC * 100)}%. Immediate remediation needed on ${result.bottleneckLayer}.`,
        ...(languageWarning ? { languageWarning } : {}),
        ...(userLocation ? { userContext: { location: userLocation, timezone: userTimezone, language: userLanguage } } : {}),
        ...(token ? { _browserToken: token } : {}),
      };

      // Generate motor accessibility overlay
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      try {
        if (motorResult && motorResult.elements.length > 0) {
          const { join: joinPath } = await import("path");
          const { tmpdir: getTmpDir } = await import("os");
          const { writeFileSync, mkdirSync, existsSync, unlinkSync: ul } = await import("fs");

          const ssPath = joinPath(getTmpDir(), `cog-effort-${Date.now()}.png`);
          await page.screenshot({ path: ssPath, fullPage: false });

          // Get element bounding boxes for motor overlay
          const motorElements = await page.evaluate(() => {
            const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"]');
            return Array.from(els).slice(0, 30).map(el => {
              const rect = (el as HTMLElement).getBoundingClientRect();
              return {
                selector: el.tagName.toLowerCase(),
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
              };
            }).filter((e: { width: number; height: number }) => e.width > 0 && e.height > 0);
          });

          const { generateMotorOverlay } = await import("../../visual/visual-overlays.js");
          const motorOverlayElements = motorElements.map((el: { selector: string; x: number; y: number; width: number; height: number }, i: number) => ({
            ...el,
            hitProbability: motorResult.elements[i]?.hitProbability ?? 0.9,
            isBarrier: motorResult.elements[i]?.isBarrier ?? false,
          }));

          const motorBase64 = await generateMotorOverlay(ssPath, motorOverlayElements, personaName);

          const heatmapId = `motor-${personaName}-${Date.now()}`;
          const webDir = "/home/wyld-web/static/cbrowser-web/out/heatmaps";
          if (!existsSync(webDir)) mkdirSync(webDir, { recursive: true });
          writeFileSync(joinPath(webDir, `${heatmapId}.png`), Buffer.from(motorBase64, "base64"));
          response.motorOverlayUrl = `https://cbrowser.ai/heatmaps/${heatmapId}.png`;
          response.motorOverlayNote = "Green = easy to click. Yellow = moderate difficulty. Red = motor barrier for this persona.";

          content.push({ type: "image" as const, data: motorBase64, mimeType: "image/png" });
          try { ul(ssPath); } catch {}
        }
      } catch (e) {
        console.debug(`[cognitive_effort] Motor overlay failed: ${(e as Error).message}`);
      }

      content.unshift({
        type: "text" as const,
        text: JSON.stringify(response, null, 2),
      });

      return { content };
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
            url,
            persona: personaName,
          }, null, 2),
        }],
      };
    }
  });
}
