/**
 * MCP UI resources (mcp-ui / MCP Apps).
 *
 * cbrowser's tools return JSON. That is right for a CLI or a CI job and wrong
 * for what the tools actually produce — a barrier overlay is a picture of a
 * page with rectangles on it, and describing it in coordinates makes the reader
 * take it on faith.
 *
 * The useful discovery is that the HTML already exists. Nine modules export a
 * `generate*HtmlReport` function for the CLI's `--html` flag, and they are
 * self-contained by construction (no CDN, no remote font, no fetch) because
 * they were always meant to be opened as a local file. So reaching an MCP Apps
 * host is not a rendering project; it is a transport seam. This module is that
 * seam, and it is deliberately the only one.
 *
 * Three rules encoded here rather than left to each call site:
 *
 *  1. **The adapter stays off.** `createUIResource({adapters: {mcpApps: …}})`
 *     injects a measured 18,672-byte shim whose job is to make *pre-existing*
 *     mcp-ui widgets work in MCP Apps hosts. Our HTML is written fresh against
 *     the spec, so the shim is pure weight on every response.
 *  2. **No remote references.** A UI resource renders in a sandboxed iframe
 *     whose CSP we do not control. Anything fetched from another origin may
 *     silently not load, which turns a report into a blank rectangle — worse
 *     than no report, because it looks like a product defect rather than a
 *     missing feature.
 *  3. **Never advertise what was not produced.** A resource pointing at an
 *     artifact that failed to write is the same class of defect as the dead
 *     `/heatmaps/` URLs this codebase shipped for ten days.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { createUIResource } from "@mcp-ui/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Ceiling on a single UI resource. An MCP response travels through the same
 * transport that a 622,812-byte base64 screenshot once overflowed; the point of
 * moving images out of the payload is lost if the HTML grows to replace them.
 */
export const UI_RESOURCE_MAX_BYTES = 400_000;

/**
 * A content block as the MCP SDK defines it. Taken from the SDK rather than
 * hand-written: a parallel local union drifts from the wire format silently,
 * and the compiler is the only thing that would have caught it.
 */
export type ToolContentBlock = CallToolResult["content"][number];

export interface HtmlUiResourceOptions {
  /** Suggested iframe size, e.g. ["100%", "720px"]. */
  frameSize?: [string, string];
}

/**
 * Patterns that would make the HTML depend on a network the iframe may not be
 * allowed to reach. `src="https://cbrowser.ai/heatmaps/…"` is the deliberate
 * exception: our own served artifacts are the entire point of the overlay, and
 * they are same-site with the product.
 */
const REMOTE_REF = /(?:\bsrc\s*=\s*["']https?:\/\/(?!cbrowser\.ai\/)|@import\s|<link[^>]+href\s*=\s*["']https?:|\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket)/i;

/** True when the HTML reaches outside itself for something it needs. */
export function hasRemoteReference(html: string): boolean {
  return REMOTE_REF.test(html);
}

/**
 * Wrap a self-contained HTML document as a `ui://` resource.
 *
 * Returns `null` — never a partial or placeholder resource — when the HTML is
 * absent, oversized, or reaches off-origin. A caller that gets null omits the
 * block and its text output is unchanged, which is why every non-UI consumer of
 * these tools is unaffected by this module existing.
 */
export function htmlUiResource(
  uri: `ui://${string}`,
  html: string | undefined,
  options: HtmlUiResourceOptions = {},
): ToolContentBlock | null {
  if (!html || html.length === 0) return null;
  if (Buffer.byteLength(html, "utf8") > UI_RESOURCE_MAX_BYTES) return null;
  if (hasRemoteReference(html)) return null;

  try {
    return createUIResource({
      uri,
      content: { type: "rawHtml", htmlString: html },
      encoding: "text",
      ...(options.frameSize ? { uiMetadata: { "preferred-frame-size": options.frameSize } } : {}),
      // adapters deliberately omitted — see rule 1 in the module header.
    }) as unknown as ToolContentBlock;
  } catch {
    return null;
  }
}

/**
 * Point a UI resource at an already-served artifact (heatmap, overlay, GIF)
 * rather than embedding it. Returns null for anything that is not an absolute
 * http(s) URL, so a local filesystem path can never be advertised as one.
 */
export function urlUiResource(
  uri: `ui://${string}`,
  url: string | undefined,
): ToolContentBlock | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }
  try {
    return createUIResource({
      uri,
      content: { type: "externalUrl", iframeUrl: url },
      encoding: "text",
    }) as unknown as ToolContentBlock;
  } catch {
    return null;
  }
}

/**
 * Append a UI resource to a tool's content array if one was produced.
 *
 * Append, never replace: the text block stays exactly where it was, so a caller
 * reading `content[0].text` — every CLI and CI consumer — sees no difference.
 */
export function attachUiResource(
  content: ToolContentBlock[],
  resource: ToolContentBlock | null,
): ToolContentBlock[] {
  if (resource) content.push(resource);
  return content;
}

/**
 * Whether a tool call asked for UI resources.
 *
 * Default ON, because a host that does not understand a resource block ignores
 * it, whereas a customer who never learns the overlay exists gets nothing. The
 * opt-out exists for scripted callers that diff whole responses.
 */
export function uiResourcesEnabled(arg: unknown): boolean {
  return arg !== false;
}
