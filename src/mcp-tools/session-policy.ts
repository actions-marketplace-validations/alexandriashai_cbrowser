/**
 * CBrowser MCP Tools - Omitted-session policy
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import type { ToolRegistrationContext } from "./types.js";

/**
 * On the multi-session HTTP transport, a tool called WITHOUT a `_browserToken`
 * resolves to a brand-new blank browser. For action tools that is merely useless
 * — the click goes nowhere and the caller can see it did. For tools that ANSWER
 * A QUESTION about the page it is actively harmful, because a blank page is a
 * valid-looking subject and the tool reports a confident wrong answer:
 *
 *   navigate("https://cbrowser.ai")             -> cb_plq5bk79
 *   assert("page contains 'CBrowser'")          // token omitted
 *   -> { passed: false, actual: "", _browserToken: "cb_ulo7887d" }
 *
 * The negative form is worse still: `assert page does not contain 'error'`
 * PASSES against a blank page, so an entire suite can report green while
 * testing an empty browser. Returning a fresh `_browserToken` in that response
 * also makes the blank-session result look like a legitimate session result.
 *
 * So the policy splits by tool kind:
 *
 *   action tools   (click, fill, hover, scroll, press_key)  -> may auto-create
 *   read/assert    (assert, extract, page_understand, ...)  -> refuse
 *   state tools    (save_session, load_session)             -> refuse
 *
 * This only applies where sessions exist. On the stdio transport there is one
 * process, one client and one browser, so `getBrowserByToken` is undefined and
 * there is nothing to bind — the guard correctly does nothing there.
 *
 * (2026-07-29)
 */
export function refuseUnboundSession(
  toolName: string,
  ctx: Pick<ToolRegistrationContext, "getBrowserByToken">,
  browserToken: string | undefined,
): { isError: true; content: Array<{ type: "text"; text: string }> } | null {
  // Single-session transport, or the caller named a session: nothing to refuse.
  if (!ctx.getBrowserByToken || browserToken) return null;

  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: "no_session",
        tool: toolName,
        message:
          `${toolName} reports on the state of a page, so it will not run without a _browserToken. ` +
          `Without one it would answer about a new blank browser rather than your page, and the ` +
          `answer would look legitimate — a negative assertion would pass against nothing. ` +
          `Call navigate() first and pass the _browserToken it returns.`,
      }, null, 2),
    }],
  };
}
