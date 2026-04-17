/**
 * Visual Report Auto-Saver
 *
 * Saves heatmaps, overlays, and screenshots to the CMS for the user's
 * Visual Reports gallery. Fire-and-forget — never blocks tool execution.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

export interface VisualReportParams {
  apiKey: string | undefined;
  imageUrl: string;
  toolName: string;
  targetUrl?: string;
  persona?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Auto-generate a description from tool context.
 */
function generateDescription(params: VisualReportParams): string {
  const hostname = params.targetUrl ? (() => {
    try {
      const u = new URL(params.targetUrl);
      return u.hostname.replace(/^www\d*\./, '') + (u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '');
    } catch { return params.targetUrl; }
  })() : "unknown";

  const personaLabel = params.persona || "";

  switch (params.toolName) {
    case "attention_analysis":
      return `Attention heatmap for ${personaLabel} on ${hostname}. Red = high attention, blue = low.`;
    case "visual_cognitive_story":
      return `Visual cognitive story for ${personaLabel} on ${hostname}.`;
    case "visual_cognitive_story_attention":
      return `Attention overlay for ${personaLabel} on ${hostname}. Shows where this persona's eyes focus.`;
    case "visual_cognitive_story_motor":
      return `Motor accessibility overlay for ${personaLabel} on ${hostname}. Shows clickable element reach.`;
    case "visual_cognitive_story_quality":
      return `Attention quality overlay for ${personaLabel} on ${hostname}. Shows CTA capture effectiveness.`;
    case "visual_cognitive_story_combined":
      return `Combined cognitive overlay for ${personaLabel} on ${hostname}. Attention + motor + quality composite.`;
    case "navigate":
    case "screenshot":
      return `Screenshot of ${hostname} captured at ${new Date().toISOString().split("T")[0]}.`;
    case "empathy_audit":
      return `Empathy audit screenshot for ${personaLabel} on ${hostname}.`;
    default:
      return `Visual report from ${params.toolName} on ${hostname}.`;
  }
}

/**
 * Save a visual report to the CMS. Fire-and-forget — never blocks tool execution.
 */
export function saveVisualReport(params: VisualReportParams): void {
  if (!params.apiKey || !params.imageUrl) return;

  const cmsUrl = process.env.CMS_URL || "http://localhost:3200";
  const description = params.description || generateDescription(params);

  // Fire and forget
  fetch(`${cmsUrl}/api/visual-reports`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image_url: params.imageUrl,
      tool_name: params.toolName,
      target_url: params.targetUrl,
      persona: params.persona,
      description,
      metadata: params.metadata,
    }),
  }).then(async (res) => {
    if (res.ok) {
      console.log(`[VisualReport] Saved ${params.toolName} report for ${params.targetUrl || "unknown"}`);
    } else {
      const err = await res.text().catch(() => "");
      console.debug(`[VisualReport] Save failed (${res.status}): ${err.substring(0, 100)}`);
    }
  }).catch(() => {
    // CMS unreachable — silent fail, never blocks tools
  });
}
