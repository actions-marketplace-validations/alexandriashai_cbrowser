/**
 * CBrowser MCP Tools - Audit Tools
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import type { McpServer } from "../types.js";
import {
  runAgentReadyAudit,
  runCompetitiveBenchmark,
  runEmpathyAudit,
  runWebMCPReadyAudit,
} from "../../analysis/index.js";
import { listAccessibilityPersonas } from "../../personas.js";

/**
 * Register audit tools (4 tools: agent_ready_audit, competitive_benchmark, empathy_audit, webmcp_ready_audit)
 */
export function registerAuditTools(server: McpServer): void {
  server.registerTool("agent_ready_audit", {
    title: "Agent-Ready Audit",
    description: "Audit a website for AI-agent friendliness. Analyzes findability, stability, accessibility, and semantics. Returns score (0-100), grade (A-F), issues, and remediation recommendations.",
    inputSchema: {
      url: z.string().url().describe("URL to audit"),
      userLanguage: z.string().optional().describe("User's expected language (e.g., 'en-US') — for content language validation"),
    },
    annotations: {
      title: "Agent-Ready Audit",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ url }) => {
      const result = await runAgentReadyAudit(url, { headless: true });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: result.url,
              score: result.score,
              grade: result.grade,
              summary: result.summary,
              topIssues: result.issues.slice(0, 5),
              topRecommendations: result.recommendations.slice(0, 5),
              duration: result.duration,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("competitive_benchmark", {
    title: "Competitive Benchmark",
    description: "Compare UX across competitor sites. Runs identical cognitive journeys on multiple sites and generates head-to-head comparison with rankings, friction analysis, and recommendations.",
    inputSchema: {
      sites: z.array(z.string().url()).describe("Array of URLs to compare"),
      goal: z.string().describe("Task goal (e.g., 'sign up for free trial')"),
      persona: z.string().optional().default("first-timer").describe("Persona to use"),
      maxSteps: z.number().optional().default(8).describe("Max steps per site (keep low to avoid timeout)"),
      maxTime: z.number().optional().default(20).describe("Max time per site in seconds"),
    },
    annotations: {
      title: "Competitive Benchmark",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ sites, goal, persona, maxSteps, maxTime }) => {
      const result = await runCompetitiveBenchmark({
        sites: sites.map((url) => ({ url })),
        goal,
        persona,
        maxSteps,
        maxTime,
        headless: true,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              goal: result.goal,
              persona: result.persona,
              ranking: result.ranking,
              comparison: result.comparison,
              recommendations: result.recommendations.slice(0, 5),
              duration: result.duration,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("empathy_audit", {
    title: "Empathy Accessibility Audit",
    description: "Simulate how real users experience a site. Accepts ANY persona — disability personas get specialized barrier detection, non-disability personas get general UX analysis with a flag. Tests ONE persona per call. Disability: motor-impairment-tremor, low-vision-magnified, cognitive-adhd, dyslexic-user, deaf-user, elderly-low-vision, color-blind-deuteranopia. General: first-timer, power-user, mobile-user, elderly-user, impatient-user, or any custom persona.",
    inputSchema: {
      url: z.string().url().describe("URL to audit"),
      goal: z.string().describe("Task goal (e.g., 'complete checkout')"),
      disabilities: z.array(z.string()).optional().describe("Persona to test. Accepts disability names OR any cognitive persona (first-timer, power-user, etc). Non-disability personas are flagged. Pass ONE for reliable results."),
      wcagLevel: z.enum(["A", "AA", "AAA"]).optional().default("AA").describe("WCAG conformance level"),
      maxSteps: z.number().optional().default(5).describe("Max cognitive journey steps (keep low for MCP)"),
      maxTime: z.number().optional().default(20).describe("Max time per persona in seconds"),
      userLocation: z.string().optional().describe("User's approximate location (e.g., 'Denver, Colorado, US')"),
      userLanguage: z.string().optional().describe("User's expected language (e.g., 'en-US') — affects readability scoring"),
    },
    annotations: {
      title: "Empathy Accessibility Audit",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ url, goal, disabilities, wcagLevel, maxSteps, maxTime }) => {
      try {
        // Auto-limit to 1 persona to avoid MCP client timeout on Claude.ai (~60s limit)
        const allPersonas = listAccessibilityPersonas();
        const requestedList = disabilities || allPersonas;
        const wasLimited = requestedList.length > 1;
        const singlePersona = [requestedList[0]];

        const result = await runEmpathyAudit(url, {
          goal,
          disabilities: singlePersona,
          wcagLevel,
          maxSteps,
          maxTime,
          headless: true,
        });
        // Build response with guidance for additional personas
        const testedPersona = singlePersona[0];
        const remainingPersonas = allPersonas.filter(p => p !== testedPersona);

        const response: Record<string, unknown> = {
          url: result.url,
          goal: result.goal,
          testedPersona,
          overallScore: result.overallScore,
          resultsSummary: result.results.map((r) => {
            const uniqueTypes = new Set(r.barriers.map(b => b.type));
            return {
              persona: r.persona,
              disabilityType: r.disabilityType,
              goalAchieved: r.goalAchieved,
              empathyScore: r.empathyScore,
              // v18.22.0: Added score context for transparency
              scoreContext: r.scoreContext ? {
                explanation: r.scoreContext.explanation,
                deductionsByType: r.scoreContext.deductionsByType,
                frictionDeduction: r.scoreContext.frictionDeduction,
                goalDeduction: r.scoreContext.goalDeduction,
              } : undefined,
              barrierTypeCount: uniqueTypes.size,
              barrierTypes: Array.from(uniqueTypes),
              affectedElements: r.barriers.length,
              wcagViolationCount: r.wcagViolations.length,
              // v18.26.0: Perceptual transport metrics (Wasserstein-based)
              perceptualTransport: (r as any).perceptualTransport || undefined,
              empathyScoreBarrierOnly: (r as any).empathyScoreBarrierOnly || undefined,
              // v18.27.0: Cognitive load estimation (optimal transport)
              cognitiveLoad: (r as any).cognitiveLoad || undefined,
              // v18.28.0: Attention transport analysis (W₂ saliency)
              attentionAnalysis: (r as any).attentionAnalysis || undefined,
              // v18.29.0: Journey validation — evidence, path, forensics
              journeyValidation: (r as any).journeyValidation || undefined,
              // v18.35.0: Non-disability persona flag
              isDisabilityPersona: (r as any).isDisabilityPersona !== false,
              personaNote: (r as any).personaNote || undefined,
            };
          }),
          allWcagViolations: result.allWcagViolations,
          topBarriers: result.topBarriers.slice(0, 5),
          topRemediation: result.combinedRemediation.slice(0, 5),
          duration: result.duration,
        };

        // Add guidance if we limited the request
        if (wasLimited) {
          response.note = `Limited to 1 persona to avoid timeout. For full coverage, call again with: ${remainingPersonas.slice(0, 3).join(", ")}${remainingPersonas.length > 3 ? `, and ${remainingPersonas.length - 3} more` : ""}`;
          response.remainingPersonas = remainingPersonas;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        // Categorize the error for better user feedback
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;

        // Determine error type for actionable feedback
        let errorType = "unknown";
        let suggestion = "Please try again or contact support if the issue persists.";

        if (errorMessage.includes("timeout") || errorMessage.includes("Timeout")) {
          errorType = "timeout";
          suggestion = "The page took too long to load. Try increasing maxTime or testing a faster page.";
        } else if (errorMessage.includes("net::") || errorMessage.includes("DNS") || errorMessage.includes("ERR_")) {
          errorType = "network";
          suggestion = "Unable to reach the URL. Check the URL is valid and accessible.";
        } else if (errorMessage.includes("blocked") || errorMessage.includes("403") || errorMessage.includes("captcha")) {
          errorType = "bot-detection";
          suggestion = "The site may be blocking automation. Try with a different URL.";
        } else if (errorMessage.includes("chromium") || errorMessage.includes("browser")) {
          errorType = "browser";
          suggestion = "Browser automation error. The server may need to restart.";
        }

        // Log the full error for debugging
        console.error(`[empathy_audit] Error: ${errorMessage}`);
        if (errorStack) {
          console.error(`[empathy_audit] Stack: ${errorStack}`);
        }

        // Return a structured error response
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                errorType,
                message: errorMessage,
                suggestion,
                url,
                goal,
                disabilities: disabilities || "all",
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool("webmcp_ready_audit", {
    title: "WebMCP Readiness Audit",
    description: "Audit an MCP server for Claude in Chrome / WebMCP compatibility. Uses 6-tier evaluation: Server Implementation (25%), Tool Discoverability (20%), Instrumentation (15%), Consistency (15%), Agent Optimizations (15%), Documentation (10%). Returns score (0-100), grade (A-F), tier breakdown, issues, and recommendations.",
    inputSchema: {
      url: z.string().url().describe("MCP server URL to audit (e.g., https://demo.cbrowser.ai/mcp)"),
      apiKey: z.string().optional().describe("API key if server requires authentication"),
      oauthToken: z.string().optional().describe("OAuth token if server uses OAuth"),
      timeout: z.number().optional().default(30000).describe("Timeout in ms (default: 30000)"),
    },
    annotations: {
      title: "WebMCP Readiness Audit",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ url, apiKey, oauthToken, timeout }) => {
      const result = await runWebMCPReadyAudit(url, {
        apiKey,
        oauthToken,
        timeout,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: result.url,
              score: result.score,
              grade: result.grade,
              summary: result.summary,
              tierScores: result.tiers.map((t) => ({
                tier: t.tier,
                name: t.name,
                score: t.score,
                weight: `${Math.round(t.weight * 100)}%`,
              })),
              topIssues: result.issues.slice(0, 5),
              topRecommendations: result.recommendations.slice(0, 5),
              duration: result.duration,
            }, null, 2),
          },
        ],
      };
    }
  );

  // ── Site Cognitive Assessment (Composite Pipeline) ──

  server.registerTool("site_cognitive_assessment", {
    title: "Site Cognitive Assessment",
    description: "Three-gate pipeline: (1) bot-detection probe, (2) agent-ready qualification, (3) per-persona cognitive effort analysis. Prevents misleading scores on blocked or broken pages. Returns unified report with gate results, per-persona transport costs, and recommendations.",
    inputSchema: {
      url: z.string().url().describe("URL to assess"),
      personas: z.string().optional().default("first-timer,cognitive-adhd").describe("Comma-separated persona names (default: first-timer,cognitive-adhd)"),
      threshold: z.number().optional().default(60).describe("Minimum agent-ready score to proceed to persona analysis (default: 60)"),
      userLocation: z.string().optional().describe("User's approximate location (e.g., 'Denver, Colorado, US') — for geo-aware content expectations"),
      userTimezone: z.string().optional().describe("User's timezone (e.g., 'America/Denver') — for time-sensitive content evaluation"),
      userLanguage: z.string().optional().describe("User's expected language (e.g., 'en-US') — for readability calibration"),
      proxy: z.string().optional().describe("Proxy server URL for geo-accurate testing (e.g., 'http://user:pass@proxy.example.com:12321'). Routes browser through the proxy so sites see the proxy's IP/location instead of the server's."),
      geoRegion: z.string().optional().describe("Route through a residential proxy in this region. Available: us-west, us-east, us-central, uk, germany, japan. Overrides proxy parameter."),
      device: z.string().optional().describe("Device emulation: 'mobile', 'tablet', 'desktop', or specific device like 'iPhone 15'. Default: desktop."),
    },
    annotations: {
      title: "Site Cognitive Assessment",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ url, personas, threshold, userLocation, userTimezone, userLanguage, proxy, geoRegion }) => {
    const startTime = Date.now();
    const personaList = (personas || "first-timer,cognitive-adhd").split(",").map(s => s.trim()).filter(Boolean);

    // Derive locale from userLanguage (e.g., "en-US" → locale "en-US", language "en")
    const expectedLocale = userLanguage || "en-US";
    const expectedLang = expectedLocale.split("-")[0] || "en";

    const response: Record<string, unknown> = {
      url,
      personas: personaList,
      threshold,
      userContext: {
        location: userLocation || null,
        timezone: userTimezone || null,
        language: expectedLocale,
      },
    };

    // ── Gate 1: Bot Detection Probe ──
    try {
      const { CBrowser: BrowserClass } = await import("../../browser.js");
      // Set browser locale to match user's expected language
      // Resolve geoRegion to proxy config (overrides raw proxy)
      if (geoRegion && !proxy) {
        const { getGeoProxy } = await import("../../geo-proxy.js");
        const geoProxy = getGeoProxy(geoRegion);
        if (geoProxy) {
          proxy = `http://${encodeURIComponent(geoProxy.username)}:${encodeURIComponent(geoProxy.password)}@${geoProxy.server.replace('http://', '')}`;
          (response as Record<string, unknown>).geoRegion = geoRegion;
        }
      }

      // Parse proxy URL if provided (format: socks5://user:pass@host:port or http://host:port)
      const proxyConfig = proxy ? (() => {
        try {
          const u = new URL(proxy);
          return {
            server: `${u.protocol}//${u.hostname}:${u.port}`,
            ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
            ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
          };
        } catch { return { server: proxy }; }
      })() : undefined;

      const browser = new BrowserClass({
        headless: true,
        locale: expectedLocale,
        ...(userTimezone ? { timezone: userTimezone } : {}),
        ...(proxyConfig ? { proxy: proxyConfig, timeout: 60000 } : {}),
      });
      await browser.launch();

      try {
        const navResult = await browser.navigate(url);
        const page = await browser.getPage();

        const pageTitle = await page.title().catch(() => "");
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || "").catch(() => "");
        const elementCount = await page.evaluate(() => document.querySelectorAll("a, button, input, select, textarea").length).catch(() => 0);

        const BLOCK_SIGNATURES = [
          "access denied", "403 forbidden", "just a moment", "press & hold",
          "verify you are human", "captcha", "blocked", "robot check",
          "cloudflare", "please wait", "checking your browser",
        ];
        const lowerTitle = pageTitle.toLowerCase();
        const lowerBody = bodyText.toLowerCase();
        const blockSignature = BLOCK_SIGNATURES.find(sig => lowerTitle.includes(sig) || lowerBody.includes(sig));
        const isEmpty = elementCount < 5 && bodyText.length < 100;

        // Language mismatch detection
        const pageLang = await page.evaluate(() => document.documentElement.lang || "").catch(() => "");
        const pageLangShort = pageLang.split("-")[0].toLowerCase();
        const languageMismatch = pageLangShort && pageLangShort !== expectedLang && pageLangShort !== "";

        if (languageMismatch) {
          (response as Record<string, unknown>).languageWarning = {
            expected: expectedLocale,
            detected: pageLang,
            message: `Page language "${pageLang}" does not match expected "${expectedLocale}". The site may be geo-detecting the server's IP rather than the user's locale. Content scoring may not reflect the user's actual experience.`,
          };
        }

        if (blockSignature || isEmpty) {
          response.gate1 = {
            status: "blocked",
            signature: blockSignature || "empty page",
            pageTitle,
            elementCount,
            bodyLength: bodyText.length,
          };
          response.result = "BLOCKED";
          response.message = `Site is bot-blocked (${blockSignature || "empty DOM"}). Cannot assess cognitive experience. Try with stealth mode enabled or use a staging URL.`;
          response.duration = `${Date.now() - startTime}ms`;
          await browser.close();
          return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
        }

        response.gate1 = { status: "accessible", pageTitle, elementCount };

        // ── Gate 2: Agent-Ready Audit ──
        try {
          const auditResult = await runAgentReadyAudit(url, {
            headless: true,
            ...(proxyConfig ? { proxy: proxyConfig } : {}),
            locale: expectedLocale,
            // Increase timeouts when proxied — residential proxies add 5-15s latency
            ...(proxyConfig ? { timeout: 120000, navigationTimeout: 60000 } : {}),
          });
          const score = auditResult.score.overall;
          const grade = auditResult.grade;

          response.gate2 = {
            status: score >= threshold ? "qualified" : "unqualified",
            score,
            grade,
            threshold,
            topIssues: auditResult.issues?.slice(0, 5).map((issue) => ({
              description: issue.description,
              severity: issue.severity,
              category: issue.category,
            })) || [],
          };

          if (score < threshold) {
            response.result = "UNQUALIFIED";
            response.message = `Site scored ${score}/100 (grade ${grade}), below the ${threshold} threshold. Fix structural issues before persona testing adds value.`;
            response.duration = `${Date.now() - startTime}ms`;
            await browser.close();
            return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
          }
        } catch (auditErr) {
          response.gate2 = { status: "error", error: auditErr instanceof Error ? auditErr.message : String(auditErr) };
          // Continue to Gate 3 even if audit fails — don't block on optional qualification
        }

        // ── Gate 3: Per-Persona Cognitive Effort ──
        const personaResults: Record<string, unknown> = {};
        const { buildOTCognitiveProfile } = await import("../../visual/cognitive-transport.js");
        const { computeDemandDistribution, computeSequentialCTC } = await import("../../visual/cognitive-transport-chain.js");
        const { extractPageMetrics } = await import("../../visual/cognitive-transport.js");
        const { getAnyPersona, createCognitivePersona } = await import("../../personas.js");

        // Navigate in our browser for page metrics
        await browser.navigate(url);
        const metricsPage = await browser.getPage();
        const pageMetrics = await extractPageMetrics(metricsPage);
        const demand = computeDemandDistribution(pageMetrics);

        // Page understanding
        let pageUnderstanding: Record<string, unknown> | null = null;
        try {
          const { PageUnderstandingEngine } = await import("../../analysis/page-understanding.js");
          const engine = new PageUnderstandingEngine();
          const pu = await engine.analyze(metricsPage);
          pageUnderstanding = {
            type: pu.type,
            affordanceCount: pu.affordances.length,
            formCount: pu.structure.forms.length,
            ctaCount: pu.structure.ctas.length,
          };
        } catch {}

        for (const personaName of personaList) {
          try {
            const existingPersona = getAnyPersona(personaName);
            const personaObj = existingPersona || createCognitivePersona(personaName, personaName, {});
            const traits = ((personaObj as unknown as Record<string, unknown>).cognitiveTraits || {}) as Record<string, number>;
            const otProfile = buildOTCognitiveProfile(personaName, traits);
            const result = computeSequentialCTC(otProfile, demand, { asymmetric: true, interactions: true });

            personaResults[personaName] = {
              totalCTC: Math.round(result.totalCTC * 1000) / 1000,
              bottleneck: result.bottleneckLayer,
              abandonmentRisk: Math.round(result.abandonmentRisk * 100) + "%",
              deficit: Math.round(result.deficitCost * 1000) / 1000,
              surplus: Math.round(result.surplusCost * 1000) / 1000,
              layers: result.layers.map(l => ({
                name: l.name,
                cost: Math.round(l.transportCost * 1000) / 1000,
              })),
            };
          } catch (personaErr) {
            personaResults[personaName] = { error: personaErr instanceof Error ? personaErr.message : String(personaErr) };
          }
        }

        response.gate3 = { status: "complete", personas: personaResults };
        response.pageMetrics = {
          informationDensity: Math.round(pageMetrics.informationDensity * 1000) / 1000,
          visualComplexity: Math.round(pageMetrics.visualComplexity * 1000) / 1000,
          interactiveElements: pageMetrics.interactiveElementCount,
          choiceCount: pageMetrics.choiceCount,
        };
        if (pageUnderstanding) response.pageUnderstanding = pageUnderstanding;

        // Generate recommendations
        const recommendations: string[] = [];
        for (const [name, data] of Object.entries(personaResults)) {
          const d = data as Record<string, unknown>;
          if (d.bottleneck) {
            recommendations.push(`${name}: Reduce ${d.bottleneck} complexity (primary bottleneck, CTC=${d.totalCTC})`);
          }
        }
        response.recommendations = recommendations.slice(0, 5);
        response.result = "COMPLETE";
        response.duration = `${Date.now() - startTime}ms`;

        await browser.close();
      } catch (navErr) {
        response.gate1 = { status: "error", error: navErr instanceof Error ? navErr.message : String(navErr) };
        response.result = "ERROR";
        response.duration = `${Date.now() - startTime}ms`;
        await browser.close();
      }
    } catch (browserErr) {
      response.gate1 = { status: "error", error: browserErr instanceof Error ? browserErr.message : String(browserErr) };
      response.result = "ERROR";
      response.duration = `${Date.now() - startTime}ms`;
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
  });

  // ── Visual Cognitive Story ──

  server.registerTool("visual_cognitive_story", {
    title: "Visual Cognitive Story",
    description: "Generate a complete visual narrative of how a persona experiences a page. Produces multiple annotated screenshots: attention heatmap (where they look), motor overlay (what they can click), attention quality (do they see the CTAs), and a written narrative connecting effort, attention, and conversion. Returns all images as public URLs.",
    inputSchema: {
      url: z.string().url().describe("URL to analyze"),
      persona: z.string().optional().default("cognitive-adhd").describe("Persona name"),
      device: z.string().optional().describe("Device to emulate: 'mobile', 'tablet', 'desktop', or a specific device like 'iPhone 15', 'Pixel 7', 'iPad Pro'. Default: desktop (1920x1080)."),
      useValues: z.boolean().optional().default(false).describe("Enable motivational value influence on attention quality and narrative. Default: false."),
    },
    annotations: {
      title: "Visual Cognitive Story",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ url, persona, device, useValues }) => {
    const startTime = Date.now();
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const { writeFileSync, mkdirSync, existsSync, unlinkSync } = await import("fs");

    try {
      const { CBrowser: BrowserClass } = await import("../../browser.js");
      const browser = new BrowserClass({
        headless: true,
        ...(device ? { device: device.toLowerCase() } : { viewportWidth: 1920, viewportHeight: 1080 }),
      });
      await browser.launch();

      try {
        await browser.navigate(url);
        await new Promise(r => setTimeout(r, 2000));
        const page = await browser.getPage();

        const ssPath = join(tmpdir(), `story-${Date.now()}.png`);
        await page.screenshot({ path: ssPath, fullPage: false });

        const webDir = "/home/wyld-web/static/cbrowser-web/out/heatmaps";
        if (!existsSync(webDir)) mkdirSync(webDir, { recursive: true });
        const ts = Date.now();

        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        const urls: Record<string, string> = {};

        // ── 1. Attention Heatmap ──
        let attentionData: { entropy: number; concentration: number; hotspots: Array<{ x: number; y: number; saliency: number; row: number; col: number }>; saliencyMap?: { cells: Float64Array; rows: number; cols: number } } | null = null;
        try {
          const { analyzeAttention } = await import("../../visual/attention-transport.js");
          const attnResult = await analyzeAttention(ssPath, persona, 4);
          attentionData = {
            entropy: attnResult.entropy,
            concentration: attnResult.concentration,
            hotspots: attnResult.saliencyMap?.hotspots || [],
            saliencyMap: attnResult.saliencyMap,
          };

          if (attnResult.saliencyMap) {
            const { generateHeatmapOverlay } = await import("../../visual/heatmap-overlay.js");
            const heatB64 = await generateHeatmapOverlay(ssPath, attnResult.saliencyMap.cells, attnResult.saliencyMap.rows, attnResult.saliencyMap.cols, `${persona} Attention`);
            const heatId = `story-attn-${persona}-${ts}`;
            writeFileSync(join(webDir, `${heatId}.png`), Buffer.from(heatB64, "base64"));
            urls.attention = `https://cbrowser.ai/heatmaps/${heatId}.png`;
            images.push({ type: "image", data: heatB64, mimeType: "image/png" });
          }
        } catch (e) { console.debug(`[story] Attention failed: ${(e as Error).message}`); }

        // ── 2. Motor Accessibility Overlay ──
        try {
          const { motorAccessibility } = await import("../../visual/cognitive-models.js");
          const { buildOTCognitiveProfile } = await import("../../visual/cognitive-transport.js");
          const { getAnyPersona, createCognitivePersona } = await import("../../personas.js");

          const personaObj = getAnyPersona(persona) || createCognitivePersona(persona, persona, {});
          const traits = ((personaObj as unknown as Record<string, unknown>).cognitiveTraits || {}) as Record<string, number>;
          const otProfile = buildOTCognitiveProfile(persona, traits);

          const elements = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"]')).slice(0, 30).map(el => {
              const rect = (el as HTMLElement).getBoundingClientRect();
              const vw = window.innerWidth / 2;
              const vh = window.innerHeight / 2;
              return {
                selector: el.tagName.toLowerCase() + ((el as HTMLElement).innerText?.trim().slice(0, 15) ? `[${(el as HTMLElement).innerText.trim().slice(0, 15)}]` : ''),
                width: rect.width, height: rect.height,
                distance: Math.sqrt((rect.x + rect.width / 2 - vw) ** 2 + (rect.y + rect.height / 2 - vh) ** 2),
                x: rect.x, y: rect.y,
              };
            }).filter((e: { width: number; height: number }) => e.width > 0 && e.height > 0);
          });

          const motorResult = motorAccessibility(elements, otProfile);

          const { generateMotorOverlay } = await import("../../visual/visual-overlays.js");
          const motorElements = elements.map((el: { selector: string; x: number; y: number; width: number; height: number }, i: number) => ({
            ...el,
            hitProbability: motorResult.elements[i]?.hitProbability ?? 0.9,
            isBarrier: motorResult.elements[i]?.isBarrier ?? false,
          }));
          // Pass CSS viewport width for coordinate scaling (getBoundingClientRect returns CSS px)
          const cssVW = await page.evaluate(() => window.innerWidth).catch(() => 1920);
          const motorB64 = await generateMotorOverlay(ssPath, motorElements, persona, cssVW);
          const motorId = `story-motor-${persona}-${ts}`;
          writeFileSync(join(webDir, `${motorId}.png`), Buffer.from(motorB64, "base64"));
          urls.motor = `https://cbrowser.ai/heatmaps/${motorId}.png`;
          images.push({ type: "image", data: motorB64, mimeType: "image/png" });
        } catch (e) { console.debug(`[story] Motor failed: ${(e as Error).message}`); }

        // ── 3. Attention Quality Overlay ──
        try {
          if (attentionData?.hotspots) {
            const { computeAttentionQuality, extractPageElementsForAttention } = await import("../../visual/attention-quality.js");
            const { generateAttentionQualityOverlay } = await import("../../visual/visual-overlays.js");
            const rawElements = await extractPageElementsForAttention(page);

            // Scale CSS coordinates to screenshot pixel coordinates (DPR adjustment)
            const dpr: number = await page.evaluate(() => window.devicePixelRatio).catch(() => 1);
            const pageElements = rawElements.map(el => ({
              ...el,
              x: el.x * dpr,
              y: el.y * dpr,
              width: el.width * dpr,
              height: el.height * dpr,
            }));
            // Pass persona values only when useValues is enabled
            let pValues: Record<string, number> | undefined;
            if (useValues) {
              try {
                const { getPersonaValues: getPV } = await import("../../values/index.js");
                const v = getPV(persona);
                if (v) pValues = v as unknown as Record<string, number>;
              } catch {}
            }
            const quality = computeAttentionQuality(attentionData.hotspots, pageElements, 4, pValues);

            // Build overlay targets from page elements that matched hotspots
            const overlayTargets = quality.topAttentionTargets.map(t => {
              const el = pageElements.find(e => e.text?.includes(t.element.slice(0, 20)) || e.selector === t.element);
              return {
                type: t.type,
                x: el?.x ?? 0, y: el?.y ?? 0,
                width: el?.width ?? 100, height: el?.height ?? 30,
                saliency: t.saliency,
                label: t.element,
              };
            }).filter(t => t.x > 0 || t.y > 0);

            if (overlayTargets.length > 0) {
              const cssVW2 = await page.evaluate(() => window.innerWidth).catch(() => 1920);
              const qualB64 = await generateAttentionQualityOverlay(ssPath, overlayTargets, persona, cssVW2);
              const qualId = `story-quality-${persona}-${ts}`;
              writeFileSync(join(webDir, `${qualId}.png`), Buffer.from(qualB64, "base64"));
              urls.quality = `https://cbrowser.ai/heatmaps/${qualId}.png`;
              images.push({ type: "image", data: qualB64, mimeType: "image/png" });
            }

            urls.qualityData = quality as unknown as string;
          }
        } catch (e) { console.debug(`[story] Quality failed: ${(e as Error).message}`); }

        // ── 4. Cognitive Effort Summary ──
        let effortData: Record<string, unknown> | null = null;
        try {
          const { buildOTCognitiveProfile } = await import("../../visual/cognitive-transport.js");
          const { computeDemandDistribution, computeSequentialCTC } = await import("../../visual/cognitive-transport-chain.js");
          const { extractPageMetrics } = await import("../../visual/cognitive-transport.js");
          const { getAnyPersona, createCognitivePersona } = await import("../../personas.js");

          const personaObj = getAnyPersona(persona) || createCognitivePersona(persona, persona, {});
          const traits = ((personaObj as unknown as Record<string, unknown>).cognitiveTraits || {}) as Record<string, number>;
          const otProfile = buildOTCognitiveProfile(persona, traits);
          const pageMetrics = await extractPageMetrics(page);
          const demand = computeDemandDistribution(pageMetrics);
          const ctcResult = computeSequentialCTC(otProfile, demand, { asymmetric: true, interactions: true });

          effortData = {
            totalCTC: Math.round(ctcResult.totalCTC * 1000) / 1000,
            bottleneck: ctcResult.bottleneckLayer,
            abandonmentRisk: Math.round(ctcResult.abandonmentRisk * 100),
            layers: ctcResult.layers.map(l => ({ name: l.name, cost: Math.round(l.transportCost * 1000) / 1000 })),
          };
        } catch (e) { console.debug(`[story] Effort failed: ${(e as Error).message}`); }

        // ── 5. Combined overlay — all layers on one grayscale image ──
        try {
          const { generateCombinedStoryOverlay } = await import("../../visual/visual-overlays.js");

          const motorEls = [];
          try {
            const motorElements = await page.evaluate(() => {
              return Array.from(document.querySelectorAll('a, button, input, select, [role="button"]')).slice(0, 20).map(el => {
                const rect = (el as HTMLElement).getBoundingClientRect();
                return { selector: el.tagName.toLowerCase(), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
              }).filter((e: { width: number; height: number }) => e.width > 0 && e.height > 0);
            });
            for (const el of motorElements) {
              motorEls.push({ ...el, hitProbability: 0.85, isBarrier: el.width < 30 || el.height < 30 });
            }
          } catch {}

          const qualTargets: Array<{ type: "cta" | "heading" | "decorative" | "navigation" | "content" | "unknown"; x: number; y: number; width: number; height: number; saliency: number; label: string }> = [];
          try {
            const { extractPageElementsForAttention } = await import("../../visual/attention-quality.js");
            const pageEls = await extractPageElementsForAttention(page);
            for (const el of pageEls.filter(e => e.isCTA || e.isHeading || e.isDecorative).slice(0, 15)) {
              qualTargets.push({
                type: el.isCTA ? "cta" : el.isHeading ? "heading" : "decorative",
                x: el.x, y: el.y, width: el.width, height: el.height,
                saliency: 0.5, label: el.text?.slice(0, 25) || el.selector,
              });
            }
          } catch {}

          const cssVW3 = await page.evaluate(() => window.innerWidth).catch(() => 1920);
          const combinedB64 = await generateCombinedStoryOverlay(
            ssPath,
            attentionData?.saliencyMap?.cells ?? null,
            attentionData?.saliencyMap?.rows ?? 0,
            attentionData?.saliencyMap?.cols ?? 0,
            motorEls,
            qualTargets,
            persona,
            cssVW3,
          );
          const combId = `story-combined-${persona}-${ts}`;
          writeFileSync(join(webDir, `${combId}.png`), Buffer.from(combinedB64, "base64"));
          urls.combined = `https://cbrowser.ai/heatmaps/${combId}.png`;
          images.push({ type: "image", data: combinedB64, mimeType: "image/png" });
        } catch (e) { console.debug(`[story] Combined overlay failed: ${(e as Error).message}`); }

        // ── Build narrative ──
        const concentration = attentionData?.concentration ?? 0;
        const entropy = attentionData?.entropy ?? 0;
        const ctc = (effortData?.totalCTC as number) ?? 0;
        const bottleneck = (effortData?.bottleneck as string) ?? "unknown";
        const risk = (effortData?.abandonmentRisk as number) ?? 0;
        const qualityData = urls.qualityData as unknown as { ctaCaptureRate?: number; distractorRatio?: number; qualityScore?: number; interpretation?: string } | undefined;

        let narrative = `## ${persona} on ${new URL(url).hostname}\n\n`;
        narrative += `### The Eye: Where Attention Goes\n`;
        narrative += concentration > 0.5
          ? `Attention is focused (concentration: ${(concentration * 100).toFixed(0)}%). This persona quickly identifies a visual anchor and locks onto it.\n`
          : `Attention is scattered (concentration: ${(concentration * 100).toFixed(0)}%). This persona's eye wanders across the page without finding a clear focal point.\n`;
        narrative += entropy > 0.8
          ? `High visual entropy means too many competing elements fight for attention.\n\n`
          : `Visual hierarchy is working — the page guides the eye effectively.\n\n`;

        narrative += `### The Effort: How Hard It Is\n`;
        narrative += `Total cognitive transport cost: ${ctc.toFixed(2)}. `;
        narrative += ctc < 0.5 ? `This page is comfortable for ${persona}. ` : ctc < 1.0 ? `Moderate effort required. ` : `Significant cognitive burden. `;
        narrative += `The bottleneck is **${bottleneck}** — this is where the design creates the most friction.\n`;
        narrative += `Abandonment risk: **${risk}%**.\n\n`;

        narrative += `### The Question: Do They See What Matters?\n`;
        if (qualityData) {
          const cta = qualityData.ctaCaptureRate ?? 0;
          const distract = qualityData.distractorRatio ?? 0;
          narrative += cta > 0.2
            ? `CTAs capture ${(cta * 100).toFixed(0)}% of top attention — the conversion path is visible.\n`
            : `CTAs capture only ${(cta * 100).toFixed(0)}% of top attention — the conversion path is nearly invisible to this persona.\n`;
          narrative += distract > 0.4
            ? `${(distract * 100).toFixed(0)}% of attention goes to non-actionable elements (decorative images, nav chrome). Design is leaking attention.\n`
            : `Low distractor ratio (${(distract * 100).toFixed(0)}%) — most attention goes to actionable content.\n`;
          narrative += `\nAttention quality score: **${qualityData.qualityScore ?? 0}/100**\n`;
        } else {
          narrative += `Attention quality data unavailable.\n`;
        }

        narrative += `\n### The Verdict\n`;
        if (ctc < 0.5 && (qualityData?.ctaCaptureRate ?? 0) > 0.2) {
          narrative += `**Strong.** Easy to use AND attention lands on CTAs. This page works for ${persona}.`;
        } else if (ctc < 0.5 && (qualityData?.ctaCaptureRate ?? 0) < 0.1) {
          narrative += `**Easy but unfocused.** Low cognitive effort, but attention misses the CTAs. The page needs stronger visual hierarchy to guide ${persona} toward conversion.`;
        } else if (ctc > 1.0 && (qualityData?.ctaCaptureRate ?? 0) > 0.2) {
          narrative += `**Hard but focused.** High cognitive effort, but when ${persona} pushes through, they see the CTAs. Reduce complexity to lower the abandonment risk without losing the visual focus.`;
        } else {
          narrative += `**Needs work.** High effort AND low CTA visibility. ${persona} is both struggling to process the page AND not seeing the conversion path. Prioritize: simplify the ${bottleneck} layer, then make CTAs more prominent.`;
        }

        // ── Assemble response ──
        const storyResponse = {
          url,
          persona,
          narrative,
          images: urls,
          effort: effortData,
          attention: {
            entropy: Math.round(entropy * 1000) / 1000,
            concentration: Math.round(concentration * 1000) / 1000,
          },
          quality: qualityData ? {
            ctaCaptureRate: qualityData.ctaCaptureRate,
            distractorRatio: qualityData.distractorRatio,
            score: qualityData.qualityScore,
          } : null,
          duration: `${Date.now() - startTime}ms`,
        };

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text", text: JSON.stringify(storyResponse, null, 2) },
          ...images,
        ];

        try { unlinkSync(ssPath); } catch {}
        return { content };
      } finally {
        await browser.close();
      }
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: err instanceof Error ? err.message : String(err), url, persona }, null, 2),
        }],
      };
    }
  });
}
