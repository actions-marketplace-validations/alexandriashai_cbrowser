/**
 * Artifact fetch for MCP Apps views.
 *
 * Views cannot load images the ordinary way. The widget sandbox allowlists a
 * fixed set of origins that does not include cbrowser.ai, so an <img> pointed
 * at an artifact URL renders broken; and the image cannot ride in the tool
 * result either, because hosts truncate results near 150k characters and
 * substitute a file pointer, which reaches the widget as unparseable text.
 *
 * The remaining channel is callServerTool: the view fetches the bytes itself,
 * after mount, over the MCP connection. This tool is that endpoint.
 */
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { artifactDir } from "../../artifact-store.js";
import type { McpServer } from "../types.js";

/** Largest artifact returned inline. Base64 adds a third on top of this. */
const MAX_BYTES = 3_500_000;

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};

export function registerArtifactTools(server: McpServer): void {
  server.registerTool("artifact_fetch", {
    title: "Fetch Artifact",
    description: "Fetch a generated image artifact (heatmap, diff, capture frame) as inline image data. Called by interactive views to display images the widget sandbox cannot load by URL; not usually needed directly.",
    inputSchema: {
      file: z.string().describe("Artifact filename as returned by the producing tool, e.g. 'heatmap-abc123.png'"),
    },
    annotations: {
      title: "Fetch Artifact",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    // Hidden from the model's tool list: it exists for views to call, and an
    // agent reaching for it directly would be fetching bytes it cannot use.
    _meta: { ui: { visibility: ["app"] } },
  }, async ({ file }) => {
      // basename strips any directory component, so a traversal attempt
      // resolves to a plain name inside the artifact dir rather than escaping it.
      // The name is then re-validated, because basename alone would happily
      // return something like ".." on its own.
      const safe = basename(String(file));
      const ext = extname(safe).toLowerCase();
      if (!/^[A-Za-z0-9._-]+$/.test(safe) || safe.startsWith(".") || !MIME[ext]) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Invalid artifact name." }) }],
          isError: true,
        };
      }
      const path = join(artifactDir(), safe);
      if (!existsSync(path)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `No such artifact: ${safe}` }) }],
          isError: true,
        };
      }
      const size = statSync(path).size;
      if (size > MAX_BYTES) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: `Artifact is ${(size / 1e6).toFixed(1)}MB, over the ${(MAX_BYTES / 1e6).toFixed(1)}MB inline limit.`,
          }) }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "image" as const,
          data: readFileSync(path).toString("base64"),
          mimeType: MIME[ext] as string,
        }],
      };
    }
  );
}
