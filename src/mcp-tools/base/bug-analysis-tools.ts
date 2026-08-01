/**
 * CBrowser MCP Tools - Bug Analysis Tools
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import type { McpServer, ToolRegistrationContext } from "../types.js";
import { huntBugs, runChaosTest } from "../../analysis/index.js";

/**
 * Register bug analysis tools (2 tools: hunt_bugs, chaos_test)
 */
export function registerBugAnalysisTools(
  server: McpServer,
  { getBrowser }: ToolRegistrationContext
): void {
  server.registerTool("hunt_bugs", {
    _meta: { ui: { resourceUri: "ui://cbrowser/bugs" } },
    title: "Hunt Bugs",
    description: "Autonomous bug hunting - crawl and find issues. Returns bugs with severity, selector, and actionable recommendation for each issue found.",
    inputSchema: {
      url: z.string().url().describe("Starting URL to hunt from"),
      maxPages: z.number().optional().default(10).describe("Maximum pages to visit"),
      limit: z.number().optional().default(25).describe("How many bugs to return, worst first. The full count and a per-page/per-type breakdown are always reported, so a truncated list never hides the shape of what was found."),
      offset: z.number().optional().default(0).describe("Skip this many bugs before returning, for paging through a large result."),
      timeout: z.number().optional().default(60000).describe("Timeout in milliseconds"),
    },
    annotations: {
      title: "Hunt Bugs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ url, maxPages, timeout, limit, offset }) => {
      const b = await getBrowser();
      const result = await huntBugs(b, url, { maxPages, timeout });
      const all = result.bugs ?? [];

      // Collapse repeats of the same finding on the same page.
      //
      // A carousel with duplicated slides reported the same five broken images
      // twice, so ten "bugs" were five distinct assets. Counting the work
      // rather than the DOM occurrences is the honest figure; occurrences are
      // kept so nothing is lost. (2026-07-31)
      const groups = new Map<string, any>();
      for (const bug of all) {
        const key = `${bug.type}|${bug.url}|${bug.description}`;
        const seen = groups.get(key);
        if (seen) {
          seen.occurrences += 1;
          if (bug.selector && !seen.selectors.includes(bug.selector)) seen.selectors.push(bug.selector);
        } else {
          groups.set(key, { ...bug, occurrences: 1, selectors: bug.selector ? [bug.selector] : [] });
        }
      }
      const distinct = [...groups.values()];

      const SEV = (x: string) => ({ critical: 0, high: 1, major: 1, medium: 2, moderate: 2, low: 3, minor: 3, info: 4 }[String(x).toLowerCase()] ?? 5);
      // Worst first. A plain slice took the first ten in crawl order, which is
      // page one -- so a five-page crawl reported thirty-five bugs and showed
      // ten, every one of them from the homepage, with nothing saying so.
      distinct.sort((x, y) => SEV(x.severity) - SEV(y.severity));

      const start = Math.max(0, offset ?? 0);
      const shown = distinct.slice(start, start + Math.max(1, limit ?? 25));

      const tally = (rows: any[], key: string) => rows.reduce((m: Record<string, number>, r: any) => {
        const k = String(r[key] ?? "unknown"); m[k] = (m[k] ?? 0) + 1; return m;
      }, {});

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              pagesVisited: result.pagesVisited,
              // Raw DOM occurrences, and the distinct findings behind them.
              bugsFound: all.length,
              distinctBugs: distinct.length,
              duration: result.duration,
              returned: shown.length,
              offset: start,
              // Stated, not implied. The previous shape reported a count it did
              // not deliver and gave no way to ask for the rest.
              ...(start + shown.length < distinct.length
                ? {
                    omitted: distinct.length - (start + shown.length),
                    omittedNote: `Showing ${shown.length} of ${distinct.length} distinct bugs, worst first. Re-run with offset=${start + shown.length} for the next page, or raise limit. The breakdowns below cover ALL findings, not just the ones shown.`,
                  }
                : {}),
              // Composition of everything found, so a truncated list cannot
              // misrepresent the shape of the result.
              byPage: tally(distinct, "url"),
              byType: tally(distinct, "type"),
              bySeverity: tally(distinct, "severity"),
              bugs: shown.map(bug => ({
                type: bug.type,
                severity: bug.severity,
                description: bug.description,
                url: bug.url,
                selector: bug.selector,
                ...(bug.occurrences > 1
                  ? { occurrences: bug.occurrences, allSelectors: bug.selectors }
                  : {}),
                recommendation: bug.recommendation,
              })),
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("chaos_test", {
    title: "Chaos Engineering Test",
    description: "Inject failures and test resilience",
    inputSchema: {
      url: z.string().url().describe("URL to test"),
      networkLatency: z.number().optional().describe("Simulate network latency (ms)"),
      offline: z.boolean().optional().describe("Simulate offline mode"),
      blockUrls: z.array(z.string()).optional().describe("URL patterns to block"),
    },
    annotations: {
      title: "Chaos Engineering Test",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ url, networkLatency, offline, blockUrls }) => {
      const b = await getBrowser();
      try {
        const result = await runChaosTest(b, url, { networkLatency, offline, blockUrls });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                passed: result.passed,
                errors: result.errors,
                duration: result.duration,
                impact: result.impact,
              }, null, 2),
            },
          ],
        };
      } catch (error: any) {
        try {
          await b.recoverBrowser();
        } catch {
          // Browser recovery failed, but continue with error response
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                passed: false,
                errors: [`Chaos test crashed: ${error.message}`],
                duration: 0,
                impact: {
                  loadTimeMs: 0,
                  blockedResources: [],
                  failedResources: [],
                  delayedResources: [],
                  pageCompleted: false,
                  pageInteractive: false,
                  consoleErrors: 0,
                  degradationSummary: ["Test crashed - browser recovered"],
                },
                recovered: true,
              }, null, 2),
            },
          ],
        };
      }
    }
  );
}
