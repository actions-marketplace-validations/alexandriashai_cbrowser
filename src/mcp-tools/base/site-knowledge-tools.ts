/**
 * CBrowser MCP Tools - Site Knowledge Tools
 * Page understanding, site model learning, and site profile management.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 * @since v18.35.0
 */

import { z } from "zod";
import type { McpServer, ToolRegistrationContext } from "../types.js";

/**
 * Register site knowledge tools (7 tools: page_understand, site_model_status, site_model_query,
 * site_profile_list, site_profile_delete, site_profile_status, question_answer)
 */
export function registerSiteKnowledgeTools(
  server: McpServer,
  { getBrowser, getBrowserByToken }: ToolRegistrationContext
): void {
  // ---------------------------------------------------------------------------
  // Tool 1: page_understand
  // ---------------------------------------------------------------------------

  server.registerTool("page_understand", {
    title: "Page Understanding Analysis",
    description: "Analyze the current page to understand its type, available actions, form structure, and navigation. Returns a rich page model with affordances, structure, and element relationships. Useful before interacting with a page to know what's possible.",
    inputSchema: {
      _browserToken: z.string().optional().describe("Browser session token from a previous tool call. Pass this to analyze the same page you navigated to."),
    },
    annotations: {
      title: "Page Understanding Analysis",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ _browserToken }) => {
      try {
        let b: Awaited<ReturnType<typeof getBrowser>>;
        let token: string | undefined;
        if (getBrowserByToken) {
          const result = await getBrowserByToken(_browserToken);
          b = result.browser;
          token = result.token;
        } else {
          b = await getBrowser();
        }

        const page = await b.getPage();
        const { PageUnderstandingEngine } = await import("../../analysis/page-understanding.js");
        const engine = new PageUnderstandingEngine();
        const understanding = await engine.analyze(page);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  url: understanding.url,
                  type: understanding.type,
                  affordanceCount: understanding.affordances.length,
                  formCount: understanding.structure.forms.length,
                  ctaCount: understanding.structure.ctas.length,
                  navigationGroups: understanding.structure.navigation.length,
                  headingDepth: understanding.structure.headingHierarchy.length,
                  relationshipCount: understanding.relationships.length,
                  computeTimeMs: understanding.computeTimeMs,
                  topAffordances: understanding.affordances.slice(0, 20).map((a) => ({
                    element: a.element,
                    text: a.elementText,
                    action: a.action,
                    expectedOutcome: a.expectedOutcome,
                    confidence: a.confidence,
                    reversible: a.reversible,
                  })),
                  forms: understanding.structure.forms.map((f) => ({
                    label: f.label,
                    fieldCount: f.fields.length,
                    action: f.action,
                    method: f.method,
                    hasSubmitButton: !!f.submitButton,
                  })),
                  ctas: understanding.structure.ctas.map((c) => ({
                    text: c.text,
                    prominence: c.prominence,
                    type: c.type,
                  })),
                  ...(token ? { _browserToken: token } : {}),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
                  hint: "Ensure a page is loaded before calling page_understand. Navigate to a URL first.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 2: site_model_status
  // ---------------------------------------------------------------------------

  server.registerTool("site_model_status", {
    title: "Site Model Status",
    description: "Check if site knowledge exists for a domain. Run this BEFORE using high-familiarity personas (power-user, confident-user) to verify site knowledge is available. Returns navigation graph stats, element reliability scores, known goal paths, and failure patterns. If empty, run page_understand or navigate the site to build knowledge.",
    inputSchema: {
      domain: z.string().describe("Domain to check (e.g., 'example.com')"),
    },
    annotations: {
      title: "Site Model Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ domain }) => {
      try {
        const { SiteModelManager } = await import("../../site-model/manager.js");
        const manager = SiteModelManager.getInstance();
        const stats = await manager.getModelStats(domain);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  domain,
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 3: site_model_query
  // ---------------------------------------------------------------------------

  server.registerTool("site_model_query", {
    title: "Query Site Model",
    description: "Query the site model for the best known path to achieve a goal type on a domain. Returns the most successful action sequence if one exists.",
    inputSchema: {
      domain: z.string().describe("Domain to query (e.g., 'example.com')"),
      goalType: z.enum([
        "find_information",
        "complete_action",
        "navigate_to",
        "fill_form",
        "compare",
        "explore",
        "extract_data",
      ]).describe("Type of goal to find the best path for"),
    },
    annotations: {
      title: "Query Site Model",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ domain, goalType }) => {
      try {
        const { SiteModelManager } = await import("../../site-model/manager.js");
        const manager = SiteModelManager.getInstance();
        await manager.loadModel(domain);
        const bestPath = manager.queryBestPath(domain, goalType);

        if (!bestPath) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    domain,
                    goalType,
                    found: false,
                    message: `No known path for goal type '${goalType}' on ${domain}. The site model will learn paths as you interact with the site.`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  domain,
                  goalType,
                  found: true,
                  path: {
                    goalDescription: bestPath.goalDescription,
                    successRate: bestPath.successRate,
                    attemptCount: bestPath.attemptCount,
                    averageSteps: bestPath.averageSteps,
                    lastUsed: new Date(bestPath.lastUsed).toISOString(),
                    actionSequence: bestPath.actionSequence,
                    personaPerformance: bestPath.personaPerformance,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  domain,
                  goalType,
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 4: site_profile_list
  // ---------------------------------------------------------------------------

  server.registerTool("site_profile_list", {
    title: "List Site Profiles",
    description: "List all persistent site profiles (saved browser state per domain). Shows which sites have saved cookies, localStorage, and auth state.",
    inputSchema: {},
    annotations: {
      title: "List Site Profiles",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => {
      try {
        const { SiteProfileManager } = await import("../../browser/site-profile-manager.js");
        const manager = new SiteProfileManager();
        const profiles = await manager.listProfiles();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  profileCount: profiles.length,
                  profiles: profiles.map((p) => ({
                    domain: p.domain,
                    lastUsed: p.lastUsed,
                    cookieCount: p.cookieCount,
                    authStatus: p.authStatus,
                    sizeBytes: p.sizeBytes,
                    healthy: p.healthy,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 5: site_profile_delete
  // ---------------------------------------------------------------------------

  server.registerTool("site_profile_delete", {
    title: "Delete Site Profile",
    description: "Delete a persistent site profile for a domain. Removes saved cookies, localStorage, and auth state.",
    inputSchema: {
      domain: z.string().describe("Domain whose profile to delete (e.g., 'example.com')"),
    },
    annotations: {
      title: "Delete Site Profile",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ domain }) => {
      try {
        const { SiteProfileManager } = await import("../../browser/site-profile-manager.js");
        const manager = new SiteProfileManager();
        const deleted = await manager.deleteProfile(domain);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: deleted,
                  domain,
                  message: deleted
                    ? `Profile for '${domain}' deleted successfully`
                    : `No profile found for '${domain}'`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  domain,
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 6: site_profile_status
  // ---------------------------------------------------------------------------

  server.registerTool("site_profile_status", {
    title: "Site Profile Health",
    description: "Check the health of a site profile. Shows cookie count, expiry status, auth state, and whether the profile is still usable.",
    inputSchema: {
      domain: z.string().describe("Domain to check (e.g., 'example.com')"),
    },
    annotations: {
      title: "Site Profile Health",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ domain }) => {
      try {
        const { SiteProfileManager } = await import("../../browser/site-profile-manager.js");
        const manager = new SiteProfileManager();
        const health = await manager.getProfileHealth(domain);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(health, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  domain,
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Tool 7: question_answer — ask questions about CBrowser
  // ---------------------------------------------------------------------------

  server.registerTool("question_answer", {
    title: "Ask About CBrowser",
    description: "Ask any question about CBrowser tools, features, personas, traits, scores, or workflows. Queries the CBrowser knowledge base (289 pages of documentation) and returns a grounded answer. Use this when you need to understand what a tool does, what a score means, how to use a feature, or how tools work together.",
    inputSchema: {
      question: z.string().describe("Your question about CBrowser (e.g., 'What does empathy_audit measure?', 'How do I test mobile accessibility?', 'What is CTC?', 'Which persona should I use for elderly users?')"),
      context: z.string().optional().describe("Optional context — the URL being tested, the tool being used, or the scores you're seeing"),
    },
    annotations: {
      title: "Ask About CBrowser",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ question, context }) => {
    const cmsUrl = process.env.CMS_URL || "http://localhost:3200";
    const { getActiveKeyHash } = await import("../../mcp-tools/tier-gate.js");
    const keyHash = getActiveKeyHash();

    try {
      const res = await fetch(`${cmsUrl}/api/ai/question`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(keyHash ? { Authorization: `Bearer ${keyHash}` } : {}),
        },
        body: JSON.stringify({ question, context }),
      });

      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Knowledge base query failed (${res.status})`, question }, null, 2) }],
        };
      }

      const data = await res.json() as { answer: string; sources: string[] };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            question,
            answer: data.answer,
            sources: data.sources,
            note: "Answer grounded in CBrowser documentation (289 pages). Sources listed for reference.",
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          error: "Could not reach CBrowser knowledge base",
          question,
          suggestion: "Try rephrasing or check https://cbrowser.ai/docs for documentation",
        }, null, 2) }],
      };
    }
  });
}
