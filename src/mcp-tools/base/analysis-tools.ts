/**
 * CBrowser MCP Tools - Analysis Tools
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import type { McpServer, ToolRegistrationContext } from "../types.js";
import { refuseUnboundSession } from "../session-policy.js";
import { findElementByIntent, runAIReadinessBenchmark } from "../../analysis/index.js";

/**
 * Register analysis tools (4 tools: analyze_page, generate_tests, find_element_by_intent, ai_benchmark)
 */
export function registerAnalysisTools(
  server: McpServer,
  { getBrowser, getBrowserByToken }: ToolRegistrationContext
): void {
  server.registerTool("analyze_page", {
    title: "Analyze Page Structure",
    description: "Analyze page structure for forms, buttons, links. MUST pass _browserToken from a previous tool call to analyze the same page — without it a blank page is analyzed and every count comes back zero.",
    inputSchema: {
      // Took no arguments at all, so on the HTTP transport it always analysed a
      // fresh blank page: 0 forms, 0 buttons, 0 links, hasLogin false. Reads as a
      // real analysis of a sparse page rather than as an error. (2026-07-28)
      _browserToken: z.string().optional().describe("Browser session token from a previous tool call"),
    },
    annotations: {
      title: "Analyze Page Structure",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ _browserToken }) => {
      // Reports on page structure, so a blank-page answer (0 forms, 0 buttons,
      // 0 links) reads as a real finding rather than an error.
      const unbound = refuseUnboundSession("analyze_page", { getBrowserByToken }, _browserToken);
      if (unbound) return unbound;

      let b;
      let token: string | undefined;
      if (getBrowserByToken) {
        const resolved = await getBrowserByToken(_browserToken);
        b = resolved.browser;
        token = resolved.token;
      } else {
        b = await getBrowser();
      }
      const analysis = await b.analyzePage();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...(token ? { _browserToken: token } : {}),
              title: analysis.title,
              forms: analysis.forms.length,
              buttons: analysis.buttons.length,
              links: analysis.links.length,
              hasLogin: analysis.hasLogin,
              hasSearch: analysis.hasSearch,
              hasNavigation: analysis.hasNavigation,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("generate_tests", {
    title: "Generate Test Cases",
    description: "Generate test scenarios for a page",
    inputSchema: {
      url: z.string().url().optional().describe("URL to analyze (uses current page if not provided)"),
      // "uses current page if not provided" was unreachable on the HTTP transport:
      // omitting url fell back to a blank page, so the no-url branch generated
      // tests for about:blank. (2026-07-28)
      _browserToken: z.string().optional().describe("Browser session token from a previous tool call — required when url is omitted"),
    },
    annotations: {
      title: "Generate Test Cases",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ url, _browserToken }) => {
      // Only when it is being asked about "the current page". With an explicit
      // url it navigates itself and needs no session.
      if (!url) {
        const unbound = refuseUnboundSession("generate_tests", { getBrowserByToken }, _browserToken);
        if (unbound) return unbound;
      }

      let b;
      let token: string | undefined;
      if (getBrowserByToken) {
        const resolved = await getBrowserByToken(_browserToken);
        b = resolved.browser;
        token = resolved.token;
      } else {
        b = await getBrowser();
      }
      const result = await b.generateTests(url);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...(token ? { _browserToken: token } : {}),
              testsGenerated: result.tests.length,
              tests: result.tests.map(t => ({
                name: t.name,
                description: t.description,
                steps: t.steps.length,
              })),
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("find_element_by_intent", {
    title: "Find Element by Intent",
    description: "AI-powered semantic element finding with ARIA-first selector strategy. Prioritizes aria-label > role > semantic HTML > ID > name > class. Returns selectorType, accessibilityScore (0-1), and alternatives. Use verbose=true for enriched failure responses.",
    inputSchema: {
      intent: z.string().describe("Natural language description like 'the cheapest product' or 'login form'"),
      verbose: z.boolean().optional().describe("Include alternative matches with confidence scores and AI suggestions"),
      // Without this, the tool searched a blank browser on the HTTP transport and
      // returned `confidence: 0, "No match found"` with empty alternatives — a
      // plausible "nothing here" that is indistinguishable from a real miss.
      // (2026-07-28)
      _browserToken: z.string().optional().describe("Browser session token from a previous tool call"),
    },
    annotations: {
      title: "Find Element by Intent",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ intent, verbose, _browserToken }) => {
      // Searches the page, so a blank-browser search returns "no match found"
      // with confidence 0 — indistinguishable from a genuine miss.
      const unbound = refuseUnboundSession("find_element_by_intent", { getBrowserByToken }, _browserToken);
      if (unbound) return unbound;

      let b;
      if (getBrowserByToken) {
        b = (await getBrowserByToken(_browserToken)).browser;
      } else {
        b = await getBrowser();
      }
      const result = await findElementByIntent(b, intent, { verbose });
      if (result && result.confidence > 0) {
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result || { found: false, message: "No matching element found" }, null, 2) }],
      };
    }
  );

  server.registerTool("ai_benchmark", {
    title: "AI Friendliness Benchmark",
    description: "Compare AI-friendliness across competitor sites. Runs agent-ready audits on each URL, ranks by AI readiness grade, and identifies what each competitor does better for AI agents. Use for competitive intelligence on AI-readiness.",
    inputSchema: {
      urls: z.array(z.string().url()).describe("Array of competitor URLs to benchmark"),
      goal: z.string().optional().describe("Optional goal for context (e.g., 'complete checkout')"),
    },
    annotations: {
      title: "AI Friendliness Benchmark",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ urls, goal }) => {
      const result = await runAIReadinessBenchmark({
        urls,
        goal,
        headless: true,
        maxConcurrency: 3,
      });

      // Calculate audit success/failure counts for summary
      const successCount = result.sites.filter((s) => s.auditStatus === "complete").length;
      const failedCount = result.sites.filter((s) => s.auditStatus === "failed").length;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                timestamp: result.timestamp,
                duration: `${(result.duration / 1000).toFixed(1)}s`,
                sitesAnalyzed: result.sites.length,
                sitesSucceeded: successCount,
                sitesFailed: failedCount,
                ranking: result.ranking.map((r) => ({
                  rank: r.rank,
                  site: r.site,
                  grade: r.grade,
                  score: r.score,
                  auditStatus: r.auditStatus,
                })),
                comparison: {
                  bestOverall: result.comparison.bestOverall,
                  bestFindability: result.comparison.bestFindability,
                  bestStability: result.comparison.bestStability,
                  bestAccessibility: result.comparison.bestAccessibility,
                  bestSemantics: result.comparison.bestSemantics,
                  commonIssues: result.comparison.commonIssues.slice(0, 3),
                },
                siteAdvantages: result.comparison.siteAdvantages,
                topRecommendations: result.recommendations
                  .slice(0, 10)
                  .map((r) => ({
                    site: r.site,
                    priority: r.priority,
                    improvement: r.improvement,
                    competitorReference: r.competitorReference,
                  })),
                detailedResults: result.sites.map((s) => ({
                  site: s.siteName,
                  grade: s.grade,
                  score: s.score,
                  strengths: s.strengths,
                  weaknesses: s.weaknesses,
                  topIssues: s.topIssues,
                  // Include failure details for transparency (v18.22.0)
                  auditStatus: s.auditStatus,
                  ...(s.auditStatus === "failed" && {
                    failureCategory: s.failureCategory,
                    failureDetails: s.failureDetails,
                    suggestion: s.suggestion,
                    retryAttempts: s.retryAttempts,
                  }),
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
