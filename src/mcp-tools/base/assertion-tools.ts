/**
 * CBrowser MCP Tools - Assertion Tools
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import type { McpServer, ToolRegistrationContext } from "../types.js";

/**
 * Register assertion tools (1 tool: assert)
 */
export function registerAssertionTools(
  server: McpServer,
  { getBrowser, getBrowserByToken }: ToolRegistrationContext
): void {
  server.registerTool("assert", {
    title: "Assert Page State",
    description: "Assert a condition using natural language",
    inputSchema: {
      assertion: z.string().describe("Natural language assertion like \"page contains 'Welcome'\" or \"title is 'Home'\""),
      // Without this, assert could not bind to the session navigate created on the
      // HTTP transport: it asserted against a blank page and returned
      // `passed:false, actual:""`. Worse than a crash — a NEGATIVE assertion
      // ("page does not contain 'error'") then PASSED against nothing, so a whole
      // suite could report green while testing an empty browser. (2026-07-28)
      _browserToken: z.string().optional().describe("Browser session token from a previous tool call"),
    },
    annotations: {
      title: "Assert Page State",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ assertion, _browserToken }) => {
      let b;
      let token: string | undefined;
      if (getBrowserByToken) {
        const resolved = await getBrowserByToken(_browserToken);
        b = resolved.browser;
        token = resolved.token;
      } else {
        b = await getBrowser();
      }
      const result = await b.assert(assertion);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              passed: result.passed,
              message: result.message,
              actual: result.actual,
              expected: result.expected,
              ...(token ? { _browserToken: token } : {}),
            }, null, 2),
          },
        ],
      };
    }
  );
}
