/**
 * CBrowser MCP Tools - Extraction Tools
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import type { McpServer, ToolRegistrationContext } from "../types.js";
import { buildContentWithScreenshots } from "../screenshot-utils.js";

/**
 * Register extraction tools (2 tools: screenshot, extract)
 */
export function registerExtractionTools(
  server: McpServer,
  { getBrowser, getBrowserByToken }: ToolRegistrationContext
): void {
  server.registerTool("screenshot", {
    title: "Take Screenshot",
    description: "Take a screenshot of the current page. IMPORTANT: If you received a _browserToken from a previous tool call (navigate, cognitive_journey_init), you MUST pass it here to see the same page. Without it, you get a blank new browser.",
    inputSchema: {
      path: z.string().optional().describe("Optional path to save the screenshot"),
      _browserToken: z.string().optional().describe("Browser session token from a previous tool call"),
    },
    annotations: {
      title: "Take Screenshot",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ path, _browserToken }) => {
      let b: Awaited<ReturnType<typeof getBrowser>>;
      let token: string | undefined;
      if (getBrowserByToken) {
        const result = await getBrowserByToken(_browserToken);
        b = result.browser;
        token = result.token;
      } else {
        b = await getBrowser();
      }
      const file = await b.screenshot(path);
      return {
        content: buildContentWithScreenshots({ screenshot: file, ...(token ? { _browserToken: token } : {}) }, file),
      };
    }
  );

  server.registerTool("extract", {
    title: "Extract Page Data",
    description: "Extract data from the page. Pass _browserToken to use the same browser session.",
    inputSchema: {
      what: z.enum(["links", "headings", "forms", "images", "text"]).describe("What to extract"),
      _browserToken: z.string().optional().describe("Browser session token from a previous tool call"),
    },
    annotations: {
      title: "Extract Page Data",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ what, _browserToken }) => {
      let b: Awaited<ReturnType<typeof getBrowser>>;
      if (getBrowserByToken) {
        const result = await getBrowserByToken(_browserToken);
        b = result.browser;
      } else {
        b = await getBrowser();
      }
      const result = await b.extract(what);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    }
  );
}
