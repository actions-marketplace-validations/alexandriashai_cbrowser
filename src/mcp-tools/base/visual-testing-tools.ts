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
  server.tool(
    "visual_baseline",
    "Capture a visual baseline for a URL",
    {
      url: z.string().url().describe("URL to capture baseline for"),
      name: z.string().describe("Name for the baseline"),
    },
    async ({ url, name }) => {
      const result = await captureVisualBaseline(url, name, {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              name: result.name,
              url: result.url,
              timestamp: result.timestamp,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "visual_regression",
    "Run AI visual regression test against a baseline",
    {
      url: z.string().url().describe("URL to test"),
      baselineName: z.string().describe("Name of baseline to compare against"),
    },
    async ({ url, baselineName }) => {
      const result = await runVisualRegression(url, baselineName);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              passed: result.passed,
              similarityScore: result.analysis?.similarityScore,
              summary: result.analysis?.summary,
              changes: result.analysis?.changes?.length || 0,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "cross_browser_test",
    "Test page rendering across multiple browsers",
    {
      url: z.string().url().describe("URL to test"),
      browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).optional().describe("Browsers to test"),
    },
    async ({ url, browsers }) => {
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

  server.tool(
    "cross_browser_diff",
    "Quick diff of page metrics across browsers",
    {
      url: z.string().url().describe("URL to compare"),
      browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).optional().describe("Browsers to compare"),
    },
    async ({ url, browsers }) => {
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

  server.tool(
    "responsive_test",
    "Test page across different viewport sizes",
    {
      url: z.string().url().describe("URL to test"),
      viewports: z.array(z.string()).optional().describe("Viewport presets (mobile, tablet, desktop, etc.)"),
    },
    async ({ url, viewports }) => {
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

  server.tool(
    "ab_comparison",
    "Compare two URLs visually (staging vs production)",
    {
      urlA: z.string().url().describe("First URL (e.g., staging)"),
      urlB: z.string().url().describe("Second URL (e.g., production)"),
      labelA: z.string().optional().describe("Label for first URL"),
      labelB: z.string().optional().describe("Label for second URL"),
    },
    async ({ urlA, urlB, labelA, labelB }) => {
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

  // ── Smart Baseline (v18.0.0) ──

  server.tool(
    "smart_baseline",
    "Capture a smart consensus baseline using Wasserstein barycenter. Takes N screenshots, rejects outliers, computes optimal reference. Robust to dynamic content and timing variations.",
    {
      url: z.string().describe("URL to capture"),
      name: z.string().describe("Baseline name"),
      captures: z.number().optional().describe("Number of screenshots (default: 5)"),
      delay: z.number().optional().describe("Delay between captures in ms (default: 1500)"),
      selector: z.string().optional().describe("CSS selector to capture"),
      device: z.string().optional().describe("Device emulation"),
    },
    async ({ url, name, captures, delay, selector, device }) => {
      const { captureSmartBaseline } = await import("../../visual/index.js");
      const result = await captureSmartBaseline(url, name, {
        numCaptures: captures,
        captureDelay: delay,
        selector,
        device,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              name: result.name,
              captures: result.numCaptures,
              outliers: result.numOutliers,
              meanDistance: result.meanDistance,
              stdDev: result.stdDevDistance,
              adaptiveThreshold: result.adaptiveThreshold,
              reference: result.referencePath,
              computeTime: `${result.computeTimeMs.toFixed(0)}ms`,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "smart_regression",
    "Run visual regression against a smart baseline. Uses Wasserstein distance with adaptive threshold based on observed render variance.",
    {
      url: z.string().describe("URL to test"),
      baseline: z.string().describe("Smart baseline name"),
      threshold: z.number().optional().describe("Override adaptive threshold (0-1)"),
      transportMap: z.boolean().optional().describe("Also generate visual transport map"),
    },
    async ({ url, baseline, threshold, transportMap: wantMap }) => {
      if (wantMap) {
        const { runRegressionWithTransportMap } = await import("../../visual/index.js");
        const result = await runRegressionWithTransportMap(url, baseline, { threshold });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                passed: result.passed,
                similarity: result.analysis.similarityScore,
                status: result.analysis.overallStatus,
                summary: result.analysis.summary,
                hotspots: result.transportMap?.hotspots,
                flows: result.transportMap?.flows.length,
                svgPath: result.transportMapSvgPath,
              }, null, 2),
            },
          ],
        };
      }

      const { runSmartRegression } = await import("../../visual/index.js");
      const result = await runSmartRegression(url, baseline, { threshold });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              passed: result.passed,
              similarity: result.analysis.similarityScore,
              status: result.analysis.overallStatus,
              summary: result.analysis.summary,
              rawAnalysis: result.analysis.rawAnalysis,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "transport_map",
    "Generate a Visual Transport Map showing WHERE visual content moved between two screenshots. Produces heatmap, flow arrows, hotspots, and SVG visualization.",
    {
      baselinePath: z.string().describe("Path to baseline screenshot"),
      currentPath: z.string().describe("Path to current screenshot"),
      cellSize: z.number().optional().describe("Grid cell size in pixels (default: 32)"),
      hotspots: z.number().optional().describe("Number of hotspots to identify (default: 5)"),
    },
    async ({ baselinePath, currentPath, cellSize, hotspots: numHotspots }) => {
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

  server.tool(
    "attention_analysis",
    "Analyze where a persona's visual attention goes on a page using Wasserstein saliency. Produces attention alignment, entropy, concentration, and top attention areas. Based on Klein & Frintrop W₂ on CIE-Lab distributions.",
    {
      url: z.string().describe("URL to analyze"),
      persona: z.string().optional().default("first-timer").describe("Persona name"),
      cellSize: z.number().optional().default(16).describe("Saliency grid cell size"),
    },
    async ({ url, persona, cellSize }) => {
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
        const screenshotPath = join(tmpdir(), `attn-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });

        const { analyzeAttention } = await import("../../visual/attention-transport.js");
        const result = await analyzeAttention(screenshotPath, persona, cellSize);

        try { unlinkSync(screenshotPath); } catch {}

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              persona: result.persona,
              alignmentScore: result.alignmentScore,
              entropy: result.entropy,
              concentration: result.concentration,
              transportCost: result.transportCost,
              topAttentionAreas: result.attentionCompetitors,
              interpretation: {
                alignment: result.alignmentScore > 0.8 ? "Attention follows intended design" : result.alignmentScore > 0.5 ? "Moderate attention alignment" : "Attention diverges from intended design",
                entropy: result.entropy > 0.8 ? "Scattered attention (overwhelmed)" : result.entropy > 0.5 ? "Moderate attention spread" : "Focused attention",
                concentration: result.concentration > 0.6 ? "Attention concentrated on few areas" : "Attention distributed across page",
              },
              computeTimeMs: Math.round(result.computeTimeMs),
            }, null, 2),
          }],
        };
      } finally {
        await browser.close();
      }
    }
  );

  server.tool(
    "attention_compare",
    "Compare attention patterns between two personas on the same page. Shows where they look differently and the Wasserstein divergence between their saliency maps.",
    {
      url: z.string().describe("URL to analyze"),
      personaA: z.string().describe("First persona"),
      personaB: z.string().describe("Second persona"),
    },
    async ({ url, personaA, personaB }) => {
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
        const result = await compareAttention(screenshotPath, personaA, personaB, 16);

        try { unlinkSync(screenshotPath); } catch {}

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
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
            }, null, 2),
          }],
        };
      } finally {
        await browser.close();
      }
    }
  );
}
