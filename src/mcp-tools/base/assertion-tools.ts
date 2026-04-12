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
  { getBrowser }: ToolRegistrationContext
): void {
  server.registerTool("assert", {
    title: "Assert Page State",
    description: "Assert a condition using natural language",
    inputSchema: {
      assertion: z.string().describe("Natural language assertion like \"page contains 'Welcome'\" or \"title is 'Home'\""),
    },
    annotations: {
      title: "Assert Page State",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ assertion }) => {
      const b = await getBrowser();
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
            }, null, 2),
          },
        ],
      };
    }
  );
}
