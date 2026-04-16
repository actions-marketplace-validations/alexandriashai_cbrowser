/**
 * CBrowser MCP Tools - Browser Management Tools
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import type { McpServer, ToolRegistrationContext } from "../types.js";
import { getStatusInfo } from "../../config.js";
import { VERSION } from "../../version.js";

/**
 * Register browser management tools (4 tools: status, browser_health, browser_recover, reset_browser)
 */
export function registerBrowserManagementTools(
  server: McpServer,
  { getBrowser, getToolCount }: ToolRegistrationContext
): void {
  server.registerTool("status", {
    title: "Browser Status",
    description: "Get CBrowser environment status and diagnostics including data directories, installed browsers, configuration, self-healing cache statistics, and MCP tool count",
    inputSchema: {},
    annotations: {
      title: "Browser Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => {
      const toolCount = getToolCount?.();
      const info = await getStatusInfo(VERSION, toolCount);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("browser_health", {
    title: "Browser Health Check",
    description: "Check if the browser is healthy and responsive. Use this before operations if you suspect the browser may have crashed.",
    inputSchema: {},
    annotations: {
      title: "Browser Health Check",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => {
      const b = await getBrowser();
      const result = await b.isBrowserHealthy();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("browser_recover", {
    title: "Recover Browser",
    description: "Attempt to recover from a browser crash by restarting the browser process. Use this when browser_health returns unhealthy.",
    inputSchema: {
      restoreUrl: z.string().url().optional().describe("URL to restore after recovery (uses last known URL if not provided)"),
      maxAttempts: z.number().optional().default(3).describe("Maximum recovery attempts"),
    },
    annotations: {
      title: "Recover Browser",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ restoreUrl, maxAttempts }) => {
      const b = await getBrowser();
      const result = await b.recoverBrowser({ restoreUrl, maxAttempts });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("reset_browser", {
    title: "Reset Browser",
    description: "Reset the browser to a clean state. Clears all cookies, localStorage, sessionStorage, and browser state. Use this when you need a fresh browser environment.",
    inputSchema: {},
    annotations: {
      title: "Reset Browser",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => {
      const b = await getBrowser();
      await b.reset();
      await b.launch();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Browser reset to clean state and relaunched",
            }, null, 2),
          },
        ],
      };
    }
  );

  // ── manage_tabs ──
  server.registerTool("manage_tabs", {
    title: "Manage Browser Tabs",
    description: "List, create, switch, or close browser tabs. Useful for multi-page workflows.",
    inputSchema: {
      action: z.enum(["list", "create", "switch", "close"]).describe("Action: list (show all tabs), create (new tab), switch (focus tab), close (close tab)"),
      url: z.string().optional().describe("URL for new tab (create action)"),
      index: z.number().optional().describe("Tab index to switch to or close (0-based)"),
    },
    annotations: { title: "Manage Tabs", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ action, url, index }) => {
    const b = await getBrowser();
    const context = (b as any).context;
    if (!context) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No browser context. Navigate to a URL first." }) }] };
    }

    if (action === "list") {
      const pages = context.pages();
      const tabs = pages.map((p: any, i: number) => ({ index: i, url: p.url(), title: p.url() }));
      // Get titles async
      for (const tab of tabs) {
        try { tab.title = await context.pages()[tab.index].title(); } catch { /* keep URL */ }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ tabs, count: tabs.length }) }] };
    }

    if (action === "create") {
      const page = await context.newPage();
      if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      // Switch to new tab
      (b as any).page = page;
      const title = await page.title().catch(() => "");
      return { content: [{ type: "text" as const, text: JSON.stringify({ created: true, url: page.url(), title, index: context.pages().length - 1 }) }] };
    }

    if (action === "switch" && index !== undefined) {
      const pages = context.pages();
      if (index < 0 || index >= pages.length) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Tab ${index} doesn't exist. ${pages.length} tabs open (0-${pages.length - 1}).` }) }] };
      }
      (b as any).page = pages[index];
      const title = await pages[index].title().catch(() => "");
      return { content: [{ type: "text" as const, text: JSON.stringify({ switched: true, index, url: pages[index].url(), title }) }] };
    }

    if (action === "close" && index !== undefined) {
      const pages = context.pages();
      if (index < 0 || index >= pages.length) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Tab ${index} doesn't exist.` }) }] };
      }
      if (pages.length <= 1) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Can't close the last tab." }) }] };
      }
      await pages[index].close();
      // If we closed the active tab, switch to first remaining
      const remaining = context.pages();
      (b as any).page = remaining[0];
      return { content: [{ type: "text" as const, text: JSON.stringify({ closed: index, remainingTabs: remaining.length }) }] };
    }

    return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid params. 'switch'/'close' require index, 'create' optionally takes url." }) }] };
  });
}
