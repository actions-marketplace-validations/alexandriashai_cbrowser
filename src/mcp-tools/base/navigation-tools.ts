/**
 * CBrowser MCP Tools - Navigation Tools
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import type { McpServer, ToolRegistrationContext } from "../types.js";
import { buildContentWithScreenshots } from "../screenshot-utils.js";

/**
 * Register navigation tools (1 tool: navigate)
 */
export function registerNavigationTools(
  server: McpServer,
  { getBrowser, getBrowserByToken }: ToolRegistrationContext
): void {
  server.tool(
    "navigate",
    "Navigate to a URL and take a screenshot. Pass _browserToken from a previous tool call to reuse the same browser session.",
    {
      url: z.string().url().describe("The URL to navigate to"),
      _browserToken: z.string().optional().describe("Browser session token from a previous tool call. Pass this to maintain browser state (cookies, page) across calls."),
    },
    async ({ url, _browserToken }) => {
      let b: Awaited<ReturnType<typeof getBrowser>>;
      let token: string | undefined;
      if (getBrowserByToken) {
        const result = await getBrowserByToken(_browserToken);
        b = result.browser;
        token = result.token;
      } else {
        b = await getBrowser();
      }
      let result = await b.navigate(url);

      // v18.30.0: Auto-recover from corrupted browser state with retry
      if (!result.title && !result.screenshot) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            console.warn(`[navigate] Blank page on attempt ${attempt + 1} for ${url}. Resetting browser (persistent state preserved).`);
            await b.close();
            await b.launch();
            result = await b.navigate(url);
            if (result.title || result.screenshot) break;
          } catch {}
        }
      }

      // v18.35.0: Update site model with navigation edge
      try {
        const { SiteModelManager } = await import("../../site-model/manager.js");
        const siteModel = SiteModelManager.getInstance();
        const fromUrl = _browserToken ? "previous-page" : "direct";
        const toUrl = result.url || url;
        const toDomain = new URL(toUrl).hostname;
        siteModel.recordNavigation(toDomain, fromUrl, toUrl, "navigate", result.title || "");
        console.log(`[site-model] Recorded navigation to ${toDomain}: ${toUrl}`);
      } catch (e) {
        console.warn(`[site-model] Navigation hook error: ${(e as Error).message}`);
      }

      return {
        content: buildContentWithScreenshots(
          {
            success: true,
            url: result.url,
            title: result.title,
            loadTime: result.loadTime,
            screenshot: result.screenshot,
            ...(token ? { _browserToken: token } : {}),
          },
          result.screenshot
        ),
      };
    }
  );
}
