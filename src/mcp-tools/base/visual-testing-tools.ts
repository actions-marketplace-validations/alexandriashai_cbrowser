/**
 * CBrowser MCP Tools - Visual Testing Tools
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import type { McpServer } from "../types.js";
import {
  runVisualRegression,
  runCrossBrowserTest,
  runResponsiveTest,
  runABComparison,
  crossBrowserDiff,
  captureVisualBaseline,
} from "../../visual/index.js";

/**
 * Register visual testing tools (6 tools: visual_baseline, visual_regression, cross_browser_test, cross_browser_diff, responsive_test, ab_comparison)
 */
export function registerVisualTestingTools(server: McpServer): void {
  server.registerTool("visual_baseline", {
    title: "Capture Visual Baseline",
    description: "Capture a visual baseline using Wasserstein barycenter. Takes multiple screenshots, rejects outliers, computes optimal consensus reference with adaptive threshold. Robust to dynamic content, animations, and timing variations.",
    inputSchema: {
      url: z.string().url().describe("URL to capture baseline for"),
      name: z.string().describe("Name for the baseline"),
      captures: z.number().optional().default(3).describe("Number of screenshots (default 3). More = more robust but slower."),
      delay: z.number().optional().default(1500).describe("Delay between captures in ms"),
      selector: z.string().optional().describe("CSS selector to capture specific element"),
      device: z.string().optional().describe("Device emulation (e.g. mobile, tablet, iphone-15)"),
      waitFor: z.union([z.number(), z.string()]).optional().describe("Wait after page load: number = ms delay, string = CSS selector to wait for. Useful for client-side translation or deferred rendering."),
    },
    annotations: {
      title: "Capture Visual Baseline",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ url, name, captures, delay, selector, device, waitFor }) => {
      const { captureSmartBaseline } = await import("../../visual/index.js");
      const result = await captureSmartBaseline(url, name, {
        numCaptures: captures || 3,
        captureDelay: delay,
        selector,
        device,
        waitFor,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              name: result.name,
              captures: result.numCaptures,
              outliers: result.numOutliers,
              meanDistance: result.meanDistance,
              adaptiveThreshold: result.adaptiveThreshold,
              reference: result.referencePath,
              computeTime: `${result.computeTimeMs.toFixed(0)}ms`,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("visual_regression", {
    title: "Visual Regression Test",
    description: "Run visual regression test against a baseline. Automatically uses smart regression (Wasserstein) if a smart baseline exists for this name, otherwise falls back to traditional comparison.",
    inputSchema: {
      url: z.string().url().describe("URL to test"),
      baselineName: z.string().describe("Name of baseline to compare against"),
      transportMap: z.boolean().optional().describe("Also generate a visual transport map showing where content moved"),
      threshold: z.number().optional().describe("Override similarity threshold (0-1). Smart baselines use adaptive thresholds by default."),
    },
    annotations: {
      title: "Visual Regression Test",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ url, baselineName, transportMap: wantMap, threshold }) => {
      // Check if a smart baseline exists — if so, use smart regression
      const { getSmartBaseline, runSmartRegression, runRegressionWithTransportMap } = await import("../../visual/index.js");
      const smartBaseline = getSmartBaseline(baselineName);

      if (smartBaseline) {
        if (wantMap) {
          const result = await runRegressionWithTransportMap(url, baselineName, { threshold });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  mode: "smart+transport",
                  passed: result.passed,
                  similarity: result.analysis.similarityScore,
                  status: result.analysis.overallStatus,
                  summary: result.analysis.summary,
                  adaptiveThreshold: smartBaseline.adaptiveThreshold,
                  hotspots: result.transportMap?.hotspots,
                  flows: result.transportMap?.flows.length,
                  svgPath: result.transportMapSvgPath,
                }, null, 2),
              },
            ],
          };
        }

        const result = await runSmartRegression(url, baselineName, { threshold });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                mode: "smart",
                passed: result.passed,
                similarity: result.analysis.similarityScore,
                status: result.analysis.overallStatus,
                summary: result.analysis.summary,
                adaptiveThreshold: smartBaseline.adaptiveThreshold,
                rawAnalysis: result.analysis.rawAnalysis,
              }, null, 2),
            },
          ],
        };
      }

      // Traditional regression
      const result = await runVisualRegression(url, baselineName);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              mode: "traditional",
              passed: result.passed,
              similarityScore: result.analysis?.similarityScore,
              summary: result.analysis?.summary,
              changes: result.analysis?.changes?.length || 0,
              tip: "Capture with visual_baseline captures=5 for smart Wasserstein regression",
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("cross_browser_test", {
    title: "Cross-Browser Test",
    description: "Test page rendering across multiple browsers",
    inputSchema: {
      url: z.string().url().describe("URL to test"),
      browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).optional().describe("Browsers to test"),
    },
    annotations: {
      title: "Cross-Browser Test",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ url, browsers }) => {
      const result = await runCrossBrowserTest(url, { browsers });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: result.url,
              overallStatus: result.overallStatus,
              summary: result.summary,
              screenshotCount: result.screenshots.length,
              comparisonCount: result.comparisons.length,
              ...(result.missingBrowsers?.length ? { missingBrowsers: result.missingBrowsers } : {}),
              ...(result.availableBrowsers ? { availableBrowsers: result.availableBrowsers } : {}),
              ...(result.suggestion ? { suggestion: result.suggestion } : {}),
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("cross_browser_diff", {
    title: "Cross-Browser Diff",
    description: "Quick diff of page metrics across browsers",
    inputSchema: {
      url: z.string().url().describe("URL to compare"),
      browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).optional().describe("Browsers to compare"),
    },
    annotations: {
      title: "Cross-Browser Diff",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ url, browsers }) => {
      const result = await crossBrowserDiff(url, browsers);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: result.url,
              browsers: result.browsers,
              differences: result.differences,
              metrics: result.metrics,
              ...(result.missingBrowsers?.length ? { missingBrowsers: result.missingBrowsers } : {}),
              ...(result.availableBrowsers ? { availableBrowsers: result.availableBrowsers } : {}),
              ...(result.suggestion ? { suggestion: result.suggestion } : {}),
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("responsive_test", {
    title: "Responsive Test",
    description: "Test page across different viewport sizes",
    inputSchema: {
      url: z.string().url().describe("URL to test"),
      viewports: z.array(z.string()).optional().describe("Viewport presets (mobile, tablet, desktop, etc.)"),
    },
    annotations: {
      title: "Responsive Test",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ url, viewports }) => {
      const result = await runResponsiveTest(url, { viewports });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: result.url,
              overallStatus: result.overallStatus,
              summary: result.summary,
              viewportsCount: result.screenshots.length,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("ab_comparison", {
    title: "A/B Visual Comparison",
    description: "Compare two URLs visually (staging vs production)",
    inputSchema: {
      urlA: z.string().url().describe("First URL (e.g., staging)"),
      urlB: z.string().url().describe("Second URL (e.g., production)"),
      labelA: z.string().optional().describe("Label for first URL"),
      labelB: z.string().optional().describe("Label for second URL"),
    },
    annotations: {
      title: "A/B Visual Comparison",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ urlA, urlB, labelA, labelB }) => {
      const labels = labelA && labelB ? { a: labelA, b: labelB } : undefined;
      const result = await runABComparison(urlA, urlB, { labels });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              overallStatus: result.overallStatus,
              similarityScore: result.analysis?.similarityScore,
              summary: result.summary,
              differences: result.differences.slice(0, 10).map(d => ({
                type: d.type,
                severity: d.severity,
                description: d.description,
                affectedSide: d.affectedSide,
              })),
              differenceCount: result.differences.length,
              structureSummary: {
                a: {
                  headings: (result.screenshots.a as any).structure?.headings?.length || 0,
                  links: (result.screenshots.a as any).structure?.links?.length || 0,
                  forms: (result.screenshots.a as any).structure?.forms || 0,
                  buttons: (result.screenshots.a as any).structure?.buttons?.length || 0,
                },
                b: {
                  headings: (result.screenshots.b as any).structure?.headings?.length || 0,
                  links: (result.screenshots.b as any).structure?.links?.length || 0,
                  forms: (result.screenshots.b as any).structure?.forms || 0,
                  buttons: (result.screenshots.b as any).structure?.buttons?.length || 0,
                },
              },
              duration: result.duration,
            }, null, 2),
          },
        ],
      };
    }
  );

  // smart_baseline and smart_regression merged into visual_baseline and visual_regression (v18.34.0)

  server.registerTool("transport_map", {
    title: "Visual Transport Map",
    description: "Generate a Visual Transport Map showing WHERE visual content moved between two screenshots. Produces heatmap, flow arrows, hotspots, and SVG visualization.",
    inputSchema: {
      baselinePath: z.string().describe("Path to baseline screenshot"),
      currentPath: z.string().describe("Path to current screenshot"),
      cellSize: z.number().optional().describe("Grid cell size in pixels (default: 32)"),
      hotspots: z.number().optional().describe("Number of hotspots to identify (default: 5)"),
    },
    annotations: {
      title: "Visual Transport Map",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ baselinePath, currentPath, cellSize, hotspots: numHotspots }) => {
      const { computeTransportMap } = await import("../../visual/distance-metrics.js");
      const result = await computeTransportMap(baselinePath, currentPath, { cellSize, numHotspots });

      // Save SVG
      const { writeFileSync, mkdirSync, existsSync } = await import("fs");
      const { join } = await import("path");
      const { homedir } = await import("os");
      const baseDir = process.env.CBROWSER_DATA_DIR || join(homedir(), ".cbrowser");
      const mapsDir = join(baseDir, "transport-maps");
      if (!existsSync(mapsDir)) mkdirSync(mapsDir, { recursive: true });
      const svgPath = join(mapsDir, `transport-map-${Date.now()}.svg`);
      writeFileSync(svgPath, result.svg);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              grid: result.gridSize,
              flows: result.flows.length,
              totalCost: result.totalCost,
              hotspots: result.hotspots,
              svgPath,
              dimensions: result.dimensions,
              computeTime: `${result.computeTimeMs.toFixed(0)}ms`,
            }, null, 2),
          },
        ],
      };
    }
  );

  // ── Attention Transport (v18.28.0) ──

  server.registerTool("attention_analysis", {
    title: "Attention Saliency Analysis",
    description: "Analyze where a persona's visual attention goes on a page using Wasserstein saliency. Returns attention metrics AND a visual heatmap overlay showing where this persona looks. Based on Klein & Frintrop W₂ on CIE-Lab distributions.",
    inputSchema: {
      url: z.string().describe("URL to analyze"),
      persona: z.string().optional().default("first-timer").describe("Persona name"),
      cellSize: z.number().optional().default(4).describe("Saliency grid cell size in pixels (smaller = finer heatmap, default: 4)"),
      heatmap: z.boolean().optional().default(true).describe("Generate visual heatmap overlay (default: true)"),
      device: z.string().optional().describe("Device emulation: 'mobile', 'tablet', 'desktop', or specific device name"),
      useValues: z.boolean().optional().default(false).describe("Enable motivational value influence on saliency map generation and attention scoring. Default: false."),
    },
    annotations: {
      title: "Attention Saliency Analysis",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ url, persona, cellSize, heatmap, device, useValues }) => {
      const { CBrowser } = await import("../../browser.js");
      const browser = new CBrowser({
        headless: true,
        ...(device ? { device: device.toLowerCase() } : { viewportWidth: 1920, viewportHeight: 1080 }),
      });
      const { join } = await import("path");
      const { tmpdir } = await import("os");
      const { unlinkSync } = await import("fs");

      try {
        await browser.launch();
        await browser.navigate(url);
        await new Promise(r => setTimeout(r, 2000));

        const page = await browser.getPage();
        const screenshotPath = join(tmpdir(), `attn-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });

        const { analyzeAttention } = await import("../../visual/attention-transport.js");
        const result = await analyzeAttention(screenshotPath, persona, cellSize);

        // Compute attention quality — cross-reference hotspots with page elements
        let attentionQuality: unknown = null;
        try {
          const { computeAttentionQuality, extractPageElementsForAttention } = await import("../../visual/attention-quality.js");
          const rawElements = await extractPageElementsForAttention(page);
          const hotspots = result.saliencyMap?.hotspots || [];

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
              const { getPersonaValues, registerPersonaValues, createPersonaValues } = await import("../../values/index.js");
              let vals = getPersonaValues(persona);

              // If not found in built-ins, check CMS for custom persona values
              if (!vals) {
                try {
                  const { getSessionApiKey } = await import("./cognitive-tools.js"); const _sessionApiKey = getSessionApiKey();
                  if (_sessionApiKey) {
                    const cmsUrl = process.env.CMS_URL || "http://localhost:3200";
                    const res = await fetch(`${cmsUrl}/api/personas`, {
                      headers: { "Authorization": `Bearer ${_sessionApiKey}` },
                    });
                    if (res.ok) {
                      const data = await res.json() as { personas: Array<{ name: string; slug: string; schwartz_values?: string }> };
                      const match = data.personas.find((p: any) => p.slug === persona || p.name.toLowerCase() === persona.toLowerCase());
                      if (match?.schwartz_values) {
                        const sv = typeof match.schwartz_values === "string" ? JSON.parse(match.schwartz_values) : match.schwartz_values;
                        const pv = createPersonaValues(
                          { selfDirection: sv.selfDirection ?? 0.5, stimulation: sv.stimulation ?? 0.5, hedonism: sv.hedonism ?? 0.5, achievement: sv.achievement ?? 0.5, power: sv.power ?? 0.5, security: sv.security ?? 0.5, conformity: sv.conformity ?? 0.5, tradition: sv.tradition ?? 0.5, benevolence: sv.benevolence ?? 0.5, universalism: sv.universalism ?? 0.5 },
                          { autonomyNeed: sv.autonomyNeed ?? 0.5, competenceNeed: sv.competenceNeed ?? 0.5, relatednessNeed: sv.relatednessNeed ?? 0.5 },
                          "esteem"
                        );
                        registerPersonaValues([{ personaName: persona, values: pv, rationale: "Custom persona from CMS" }]);
                        vals = pv;
                      }
                    }
                  }
                } catch { /* CMS lookup failed — proceed without values */ }
              }

              if (vals) pValues = vals as unknown as Record<string, number>;
            } catch {}
          }
          attentionQuality = computeAttentionQuality(hotspots, pageElements, cellSize, pValues);
        } catch (e) {
          console.debug(`[attention_analysis] Attention quality failed: ${(e as Error).message}`);
        }

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{
          type: "text" as const,
          text: JSON.stringify({
            persona: result.persona,
            alignmentScore: result.alignmentScore,
            entropy: result.entropy,
            concentration: result.concentration,
            transportCost: result.transportCost,
            topAttentionAreas: result.attentionCompetitors,
            ...(attentionQuality ? { attentionQuality } : {}),
            interpretation: {
              alignment: result.alignmentScore > 0.8 ? "Attention follows intended design" : result.alignmentScore > 0.5 ? "Moderate attention alignment" : "Attention diverges from intended design",
              entropy: result.entropy > 0.8 ? "Scattered attention (overwhelmed)" : result.entropy > 0.5 ? "Moderate attention spread" : "Focused attention",
              concentration: result.concentration > 0.6 ? "Attention concentrated on few areas" : "Attention distributed across page",
            },
            computeTimeMs: Math.round(result.computeTimeMs),
            hasHeatmap: heatmap !== false,
          }, null, 2),
        }];

        // Generate heatmap overlay and save as public URL
        if (heatmap !== false && result.saliencyMap) {
          try {
            const { generateHeatmapOverlay } = await import("../../visual/heatmap-overlay.js");
            const heatmapBase64 = await generateHeatmapOverlay(
              screenshotPath,
              result.saliencyMap.cells,
              result.saliencyMap.rows,
              result.saliencyMap.cols,
              `${persona} Attention`,
            );

            // Save to public directory for URL access
            const { writeFileSync, mkdirSync, existsSync } = await import("fs");
            const { homedir } = await import("os");
            const heatmapId = `attn-${persona}-${Date.now()}`;

            // Known paths for the public web directory
            const webPublicPaths = [
              "/home/wyld-web/static/cbrowser-web/out/heatmaps",
              join(homedir(), "static", "cbrowser-web", "out", "heatmaps"),
            ];
            const cbrowserDir = join(homedir(), ".cbrowser", "heatmaps");

            let savedPath = "";
            let publicUrl = "";

            // Try public web directory first
            const webDir = webPublicPaths.find(p => {
              const parent = p.replace("/heatmaps", "");
              return existsSync(parent);
            });

            if (webDir) {
              if (!existsSync(webDir)) mkdirSync(webDir, { recursive: true });
              savedPath = join(webDir, `${heatmapId}.png`);
              writeFileSync(savedPath, Buffer.from(heatmapBase64, "base64"));
              publicUrl = `https://cbrowser.ai/heatmaps/${heatmapId}.png`;
            } else {
              if (!existsSync(cbrowserDir)) mkdirSync(cbrowserDir, { recursive: true });
              savedPath = join(cbrowserDir, `${heatmapId}.png`);
              writeFileSync(savedPath, Buffer.from(heatmapBase64, "base64"));
              publicUrl = savedPath;
            }

            // Return both image content and URL
            content.push({
              type: "image" as const,
              data: heatmapBase64,
              mimeType: "image/png",
            });

            // Add URL to the text response
            const firstBlock = content[0];
            if (firstBlock.type === "text") {
              const textContent = JSON.parse(firstBlock.text);
              textContent.heatmapUrl = publicUrl;
              textContent.heatmapNote = "Show this heatmap image to the user. The red areas show where this persona's attention concentrates. Blue areas receive little attention.";
              content[0] = { type: "text" as const, text: JSON.stringify(textContent, null, 2) };
            }
          } catch (e) {
            console.debug(`[attention_analysis] Heatmap generation failed: ${(e as Error).message}`);
          }
        }

        try { unlinkSync(screenshotPath); } catch {}

        return { content };
      } finally {
        await browser.close();
      }
    }
  );

  server.registerTool("attention_compare", {
    title: "Compare Persona Attention",
    description: "Compare attention patterns between two personas on the same page. Shows where they look differently and the Wasserstein divergence between their saliency maps.",
    inputSchema: {
      url: z.string().describe("URL to analyze"),
      personaA: z.string().describe("First persona"),
      personaB: z.string().describe("Second persona"),
    },
    annotations: {
      title: "Compare Persona Attention",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ url, personaA, personaB }) => {
      const { CBrowser } = await import("../../browser.js");
      const browser = new CBrowser({ headless: true, viewportWidth: 1920, viewportHeight: 1080 });
      const { join } = await import("path");
      const { tmpdir } = await import("os");
      const { unlinkSync } = await import("fs");

      try {
        await browser.launch();
        await browser.navigate(url);
        await new Promise(r => setTimeout(r, 2000));

        const page = await browser.getPage();
        const screenshotPath = join(tmpdir(), `attn-cmp-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });

        const { compareAttention } = await import("../../visual/attention-transport.js");
        const result = await compareAttention(screenshotPath, personaA, personaB, 4);

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

        const responseData: Record<string, unknown> = {
          personaA: {
            name: personaA,
            alignment: result.personaA.alignmentScore,
            entropy: result.personaA.entropy,
            concentration: result.personaA.concentration,
          },
          personaB: {
            name: personaB,
            alignment: result.personaB.alignmentScore,
            entropy: result.personaB.entropy,
            concentration: result.personaB.concentration,
          },
          attentionDivergence: result.attentionDivergence,
          interpretation: result.attentionDivergence < 0.05
            ? "Nearly identical attention patterns"
            : result.attentionDivergence < 0.15
            ? "Moderate attention differences"
            : "Substantially different attention patterns",
          divergentRegions: result.divergentRegions.slice(0, 5),
        };

        // Generate comparison heatmap overlay
        if (result.personaA.saliencyMap && result.personaB.saliencyMap) {
          try {
            const { generateComparisonHeatmap } = await import("../../visual/visual-overlays.js");
            const compBase64 = await generateComparisonHeatmap(
              screenshotPath,
              result.personaA.saliencyMap.cells,
              result.personaB.saliencyMap.cells,
              result.personaA.saliencyMap.rows,
              result.personaA.saliencyMap.cols,
              personaA,
              personaB,
            );

            // Save to public URL
            const { writeFileSync, mkdirSync, existsSync } = await import("fs");
            const heatmapId = `cmp-${personaA}-${personaB}-${Date.now()}`;
            const webDir = "/home/wyld-web/static/cbrowser-web/out/heatmaps";
            if (!existsSync(webDir)) mkdirSync(webDir, { recursive: true });
            const savedPath = join(webDir, `${heatmapId}.png`);
            writeFileSync(savedPath, Buffer.from(compBase64, "base64"));
            responseData.comparisonHeatmapUrl = `https://cbrowser.ai/heatmaps/${heatmapId}.png`;
            responseData.heatmapNote = `Blue = ${personaA} looks here more. Red = ${personaB} looks here more. Transparent = similar attention.`;

            content.push({ type: "image" as const, data: compBase64, mimeType: "image/png" });
          } catch (e) {
            console.debug(`[attention_compare] Comparison heatmap failed: ${(e as Error).message}`);
          }
        }

        content.unshift({ type: "text" as const, text: JSON.stringify(responseData, null, 2) });

        try { unlinkSync(screenshotPath); } catch {}

        return { content };
      } finally {
        await browser.close();
      }
    }
  );
}
