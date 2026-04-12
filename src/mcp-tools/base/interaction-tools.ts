/**
 * CBrowser MCP Tools - Interaction Tools
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import type { McpServer, ToolRegistrationContext } from "../types.js";
import { buildContentWithScreenshots } from "../screenshot-utils.js";

/**
 * Register interaction tools (5 tools: click, smart_click, dismiss_overlay, fill, scroll)
 */
export function registerInteractionTools(
  server: McpServer,
  { getBrowser, getBrowserByToken }: ToolRegistrationContext
): void {
  server.registerTool("click", {
    title: "Click Element",
    description: "Click an element on the page. MUST pass _browserToken from previous tool call to click on the same page. Without it, clicks go to a blank new browser.",
    inputSchema: {
      selector: z.string().describe("Element to click (text content, CSS selector, or description)"),
      force: z.boolean().optional().describe("Allow clicking red-zone elements"),
      verbose: z.boolean().optional().describe("Return available elements on failure"),
      _browserToken: z.string().optional().describe("Browser session token from a previous tool call"),
    },
    annotations: {
      title: "Click Element",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ selector, force, verbose, _browserToken }) => {
      let b: Awaited<ReturnType<typeof getBrowser>>;
      let token: string | undefined;
      if (getBrowserByToken) {
        const result = await getBrowserByToken(_browserToken);
        b = result.browser;
        token = result.token;
      } else {
        b = await getBrowser();
      }
      const result = await b.click(selector, { force, verbose });
      const response: Record<string, unknown> = {
        success: result.success,
        message: result.message,
        screenshot: result.screenshot,
      };
      if (verbose && !result.success) {
        if (result.availableElements) response.availableElements = result.availableElements;
        if (result.aiSuggestion) response.aiSuggestion = result.aiSuggestion;
        if (result.debugScreenshot) response.debugScreenshot = result.debugScreenshot;
      }
      if (token) response._browserToken = token;

      // v18.35.0: Update site model with element interaction result
      try {
        const page = await b.getPage();
        const pageUrl = page.url();
        const domain = new URL(pageUrl).hostname;
        const { SiteModelManager } = await import("../../site-model/manager.js");
        const siteModel = SiteModelManager.getInstance();
        siteModel.recordElementResult(domain, pageUrl, selector, result.success);
        if (!result.success) {
          siteModel.recordFailure(domain, pageUrl, selector, "element_not_found", [result.message || ""]);
        }
      } catch {}

      return {
        content: buildContentWithScreenshots(response, result.screenshot, result.debugScreenshot),
      };
    }
  );

  server.registerTool("smart_click", {
    title: "Smart Click with Self-Healing",
    description: "Click with auto-retry and self-healing selectors. v11.8.0: Added confidence gating - only reports success if healed selector has >= 60% confidence.",
    inputSchema: {
      selector: z.string().describe("Element to click"),
      maxRetries: z.number().optional().default(3).describe("Maximum retry attempts"),
      dismissOverlays: z.boolean().optional().default(false).describe("Dismiss overlays before clicking"),
    },
    annotations: {
      title: "Smart Click with Self-Healing",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ selector, maxRetries, dismissOverlays }) => {
      const b = await getBrowser();
      const result = await b.smartClick(selector, { maxRetries, dismissOverlays });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: result.success,
              attempts: result.attempts.length,
              finalSelector: result.finalSelector,
              message: result.message,
              aiSuggestion: result.aiSuggestion,
              confidence: result.confidence,
              healed: result.healed,
              healReason: result.healReason,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("dismiss_overlay", {
    title: "Dismiss Overlay",
    description: "Detect and dismiss modal overlays (cookie consent, age verification, newsletter popups). Constitutional Yellow zone.",
    inputSchema: {
      type: z.enum(["auto", "cookie", "age-verify", "newsletter", "custom"]).optional().default("auto").describe("Overlay type to detect"),
      customSelector: z.string().optional().describe("Custom CSS selector for overlay close button"),
    },
    annotations: {
      title: "Dismiss Overlay",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ type, customSelector }) => {
      const b = await getBrowser();
      const result = await b.dismissOverlay({ type, customSelector });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              dismissed: result.dismissed,
              overlaysFound: result.overlaysFound,
              overlaysDismissed: result.overlaysDismissed,
              details: result.details,
              suggestion: result.suggestion,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("fill", {
    title: "Fill Form Field",
    description: "Fill a form field with text. MUST pass _browserToken from previous tool call to interact with the same page.",
    inputSchema: {
      selector: z.string().describe("Input field to fill (name, placeholder, label, or selector)"),
      value: z.string().describe("Value to enter"),
      verbose: z.boolean().optional().describe("Return available inputs on failure"),
      _browserToken: z.string().optional().describe("Browser session token"),
    },
    annotations: {
      title: "Fill Form Field",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ selector, value, verbose, _browserToken }) => {
      let b: Awaited<ReturnType<typeof getBrowser>>;
      let token: string | undefined;
      if (getBrowserByToken) {
        const result = await getBrowserByToken(_browserToken);
        b = result.browser;
        token = result.token;
      } else {
        b = await getBrowser();
      }
      const result = await b.fill(selector, value, { verbose });
      const response: Record<string, unknown> = {
        success: result.success,
        message: result.message,
      };
      if (token) response._browserToken = token;
      if (verbose && !result.success) {
        if (result.availableInputs) response.availableInputs = result.availableInputs;
        if (result.aiSuggestion) response.aiSuggestion = result.aiSuggestion;
        if (result.debugScreenshot) response.debugScreenshot = result.debugScreenshot;
      }

      // v18.35.0: Update site model with fill interaction result
      try {
        const page = await b.getPage();
        const pageUrl = page.url();
        const domain = new URL(pageUrl).hostname;
        const { SiteModelManager } = await import("../../site-model/manager.js");
        const siteModel = SiteModelManager.getInstance();
        siteModel.recordElementResult(domain, pageUrl, selector, result.success);
      } catch {}

      return {
        content: buildContentWithScreenshots(response, result.debugScreenshot),
      };
    }
  );

  server.registerTool("scroll", {
    title: "Scroll Page",
    description: "Scroll the page. MUST pass _browserToken from previous tool call to scroll the same page.",
    inputSchema: {
      direction: z.enum(["down", "up", "top", "bottom"]).default("down").describe("Scroll direction"),
      amount: z.number().optional().describe("Custom scroll amount in pixels"),
      _browserToken: z.string().optional().describe("Browser session token"),
    },
    annotations: {
      title: "Scroll Page",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async ({ direction, amount, _browserToken }) => {
      let b: Awaited<ReturnType<typeof getBrowser>>;
      if (getBrowserByToken) {
        const result = await getBrowserByToken(_browserToken);
        b = result.browser;
      } else {
        b = await getBrowser();
      }
      const page = await b.getPage();

      const scrollAmount = amount || 400;
      let scrollPosition = 0;
      let maxScroll = 0;

      try {
        switch (direction) {
          case "top":
            await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
            break;
          case "bottom":
            await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
            break;
          case "up":
            await page.evaluate((amt) => window.scrollBy({ top: -amt, behavior: "smooth" }), scrollAmount);
            break;
          case "down":
          default:
            await page.evaluate((amt) => window.scrollBy({ top: amt, behavior: "smooth" }), scrollAmount);
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, 300));

        const scrollInfo = await page.evaluate(() => ({
          scrollY: window.scrollY,
          maxScroll: document.body.scrollHeight - window.innerHeight,
        }));
        scrollPosition = scrollInfo.scrollY;
        maxScroll = scrollInfo.maxScroll;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                direction,
                scrollPosition,
                maxScroll,
                atTop: scrollPosition <= 0,
                atBottom: scrollPosition >= maxScroll - 10,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }, null, 2),
            },
          ],
        };
      }
    }
  );
}
