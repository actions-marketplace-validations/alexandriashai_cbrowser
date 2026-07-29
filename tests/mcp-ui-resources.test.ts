/**
 * MCP UI resource seam.
 *
 * These pin the three rules that make a UI resource safe to append to a tool
 * response, each of which exists because the alternative has already cost this
 * codebase something:
 *
 *  - the mcpApps adapter injects a measured 18,672-byte shim, and the whole
 *    point of moving screenshots out of the payload was to stop overflowing an
 *    MCP client's context (a 622,812-byte base64 blob did exactly that);
 *  - a remote reference inside a sandboxed iframe may silently not load, which
 *    renders as a blank rectangle and reads as a broken product;
 *  - a resource must never be advertised for an artifact that was not produced,
 *    which is the same defect class as the ten days of dead /heatmaps/ URLs.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect } from "bun:test";
import {
  htmlUiResource,
  urlUiResource,
  attachUiResource,
  uiResourcesEnabled,
  hasRemoteReference,
  UI_RESOURCE_MAX_BYTES,
  type ToolContentBlock,
} from "../src/mcp-ui-resources.js";

const SELF_CONTAINED = `<!doctype html><html><head><style>body{font:14px system-ui}</style></head><body><h1>Empathy report</h1><p>3 barriers</p></body></html>`;

/** Reach into the resource block without fighting the SDK's union type. */
function res(block: ToolContentBlock | null) {
  return (block as unknown as { resource: { uri: string; mimeType: string; text: string } } | null)
    ?.resource;
}

describe("htmlUiResource", () => {
  test("produces an MCP Apps resource block", () => {
    const block = htmlUiResource("ui://cbrowser/test/one", SELF_CONTAINED);
    expect(block).not.toBeNull();
    expect(block!.type).toBe("resource");
    expect(res(block)!.mimeType).toBe("text/html;profile=mcp-app");
    expect(res(block)!.uri).toBe("ui://cbrowser/test/one");
  });

  test("the adapter shim is NOT injected", () => {
    // With adapters enabled this HTML comes back ~18,672 bytes heavier. The
    // resource must carry the document and nothing else.
    const block = htmlUiResource("ui://cbrowser/test/two", SELF_CONTAINED);
    expect(res(block)!.text).toBe(SELF_CONTAINED);
    expect(res(block)!.text.length).toBeLessThan(SELF_CONTAINED.length + 200);
  });

  test("carries a preferred frame size when asked", () => {
    const block = htmlUiResource("ui://cbrowser/test/three", SELF_CONTAINED, {
      frameSize: ["100%", "760px"],
    });
    const meta = (block as unknown as { resource: { _meta?: Record<string, unknown> } }).resource
      ._meta;
    expect(JSON.stringify(meta)).toContain("760px");
  });

  test("empty or missing HTML yields no resource, not an empty one", () => {
    expect(htmlUiResource("ui://cbrowser/test/four", undefined)).toBeNull();
    expect(htmlUiResource("ui://cbrowser/test/four", "")).toBeNull();
  });

  test("oversized HTML is refused rather than shipped", () => {
    const huge = "<p>" + "x".repeat(UI_RESOURCE_MAX_BYTES + 1) + "</p>";
    expect(htmlUiResource("ui://cbrowser/test/five", huge)).toBeNull();
  });

  test("HTML that reaches off-origin is refused", () => {
    const cases = [
      `<script src="https://cdn.example.com/x.js"></script>`,
      `<style>@import url(https://fonts.example.com/f.css);</style>`,
      `<link rel="stylesheet" href="https://example.com/a.css">`,
      `<script>fetch("/api")</script>`,
      `<script>new WebSocket("wss://x")</script>`,
    ];
    for (const html of cases) {
      expect({ html, block: htmlUiResource("ui://cbrowser/test/six", html) }).toEqual({
        html,
        block: null,
      });
    }
  });

  test("our own served artifacts are allowed — they are the point", () => {
    const html = `<img src="https://cbrowser.ai/heatmaps/story-attn-x.png" alt="overlay">`;
    expect(hasRemoteReference(html)).toBe(false);
    expect(htmlUiResource("ui://cbrowser/test/seven", html)).not.toBeNull();
  });
});

describe("urlUiResource", () => {
  test("wraps an absolute https artifact URL", () => {
    const block = urlUiResource("ui://cbrowser/heatmap/x", "https://cbrowser.ai/heatmaps/a.png");
    expect(block).not.toBeNull();
    expect(res(block)!.text).toBe("https://cbrowser.ai/heatmaps/a.png");
  });

  test("a local filesystem path is never advertised as a URL", () => {
    // This is the ten-days-of-404s defect in miniature: the tool has a path and
    // is tempted to hand it over as if a host could fetch it.
    expect(urlUiResource("ui://cbrowser/heatmap/y", "/var/www/cbrowser-data/heatmaps/a.png")).toBeNull();
    expect(urlUiResource("ui://cbrowser/heatmap/y", "file:///tmp/a.png")).toBeNull();
    expect(urlUiResource("ui://cbrowser/heatmap/y", undefined)).toBeNull();
  });
});

describe("non-UI callers are unaffected", () => {
  test("attaching appends and never disturbs the text block", () => {
    const text = JSON.stringify({ url: "https://x", overallScore: 71 });
    const content: ToolContentBlock[] = [{ type: "text", text }];
    const before = JSON.stringify(content[0]);

    attachUiResource(content, htmlUiResource("ui://cbrowser/test/eight", SELF_CONTAINED));

    expect(content).toHaveLength(2);
    expect(JSON.stringify(content[0])).toBe(before);
    expect(content[1].type).toBe("resource");
  });

  test("a null resource leaves the response exactly as it was", () => {
    const content: ToolContentBlock[] = [{ type: "text", text: "{}" }];
    attachUiResource(content, null);
    expect(content).toHaveLength(1);
  });

  test("the opt-out suppresses UI resources", () => {
    expect(uiResourcesEnabled(false)).toBe(false);
    // Default-on: absent and true both mean yes.
    expect(uiResourcesEnabled(undefined)).toBe(true);
    expect(uiResourcesEnabled(true)).toBe(true);
  });
});

describe("no base64 image re-enters the payload", () => {
  test("a data:image URI in the HTML is not what makes it in", () => {
    // ISC-59 removed a 622,812-byte inline blob. A UI resource that embeds the
    // same bytes reintroduces it under a new name, so the size ceiling has to
    // bite on exactly that shape.
    const withBlob = `<img src="data:image/png;base64,${"A".repeat(UI_RESOURCE_MAX_BYTES)}">`;
    expect(htmlUiResource("ui://cbrowser/test/nine", withBlob)).toBeNull();
  });
});
