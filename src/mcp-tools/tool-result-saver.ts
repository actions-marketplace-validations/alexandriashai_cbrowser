/**
 * Tool Result Auto-Saver
 *
 * Saves structured tool results to the CMS for the per-site analytics dashboard.
 * Fire-and-forget — never blocks tool execution.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

export interface ToolResultParams {
  apiKey: string | undefined;
  toolName: string;
  targetUrl: string;
  result: Record<string, unknown>;
  persona?: string;
  scope?: string;
  durationMs?: number;
}

/**
 * Save a tool result to the CMS. Fire-and-forget — never blocks tool execution.
 */
export function saveToolResult(params: ToolResultParams): void {
  if (!params.apiKey || !params.targetUrl) return;

  const cmsUrl = process.env.CMS_URL || "http://localhost:3200";

  fetch(`${cmsUrl}/api/tool-results`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tool_name: params.toolName,
      target_url: params.targetUrl,
      result: params.result,
      persona: params.persona,
      scope: params.scope,
      duration_ms: params.durationMs,
    }),
  }).then(async (res) => {
    if (res.ok) {
      console.log(`[ToolResult] Saved ${params.toolName} for ${params.targetUrl}`);
    } else {
      console.debug(`[ToolResult] Save failed (${res.status})`);
    }
  }).catch(() => {
    // CMS unreachable — silent fail
  });
}
