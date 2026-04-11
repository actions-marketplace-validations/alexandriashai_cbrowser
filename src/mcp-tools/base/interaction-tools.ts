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
  server.tool(
    "click",
    "Click an element on the page. MUST pass _browserToken from previous tool call to click on the same page. Without it, clicks go to a blank new browser.",
    {
      selector: z.string().describe("Element to click (text content, CSS selector, or description)"),
      force: z.boolean().optional().describe("Allow clicking red-zone elements"),
      verbose: z.boolean().optional().describe("Return available elements on failure"),
      _browserToken: z.string().optional().describe("Browser session token from a previous tool call"),
    },
    async ({ selector, force, verbose, _browserToken }) => {
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
      return {
        content: buildContentWithScreenshots(response, result.screenshot, result.debugScreenshot),
      };
    }
  );

  server.tool(
    "smart_click",
    "Click with auto-retry and self-healing selectors. v11.8.0: Added confidence gating - only reports success if healed selector has >= 60% confidence.",
    {
      selector: z.string().describe("Element to click"),
      maxRetries: z.number().optional().default(3).describe("Maximum retry attempts"),
      dismissOverlays: z.boolean().optional().default(false).describe("Dismiss overlays before clicking"),
    },
    async ({ selector, maxRetries, dismissOverlays }) => {
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

  server.tool(
    "dismiss_overlay",
    "Detect and dismiss modal overlays (cookie consent, age verification, newsletter popups). Constitutional Yellow zone.",
    {
      type: z.enum(["auto", "cookie", "age-verify", "newsletter", "custom"]).optional().default("auto").describe("Overlay type to detect"),
      customSelector: z.string().optional().describe("Custom CSS selector for overlay close button"),
    },
    async ({ type, customSelector }) => {
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

  server.tool(
    "fill",
    "Fill a form field with text. MUST pass _browserToken from previous tool call to interact with the same page.",
    {
      selector: z.string().describe("Input field to fill (name, placeholder, label, or selector)"),
      value: z.string().describe("Value to enter"),
      verbose: z.boolean().optional().describe("Return available inputs on failure"),
      _browserToken: z.string().optional().describe("Browser session token"),
    },
    async ({ selector, value, verbose, _browserToken }) => {
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
      return {
        content: buildContentWithScreenshots(response, result.debugScreenshot),
      };
    }
  );

  server.tool(
    "scroll",
    "Scroll the page. MUST pass _browserToken from previous tool call to scroll the same page.",
    {
      direction: z.enum(["down", "up", "top", "bottom"]).default("down").describe("Scroll direction"),
      amount: z.number().optional().describe("Custom scroll amount in pixels"),
      _browserToken: z.string().optional().describe("Browser session token"),
    },
    async ({ direction, amount, _browserToken }) => {
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
