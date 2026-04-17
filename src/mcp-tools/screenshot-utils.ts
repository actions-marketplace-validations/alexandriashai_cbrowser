/**
 * CBrowser MCP Tools - Screenshot Utilities
 *
 * Utilities for converting screenshot file paths to inline base64 images
 * for remote MCP mode where claude.ai can't access server filesystem.
 *
 * Includes automatic compression to stay under Claude.ai's 200KB tool response limit.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { basename } from "node:path";

/**
 * Maximum allowed size for tool responses in bytes.
 * Claude.ai enforces a 200KB limit. We target 150KB to leave headroom.
 */
export const MAX_RESPONSE_SIZE = 150000; // 150KB target (200KB limit)

/**
 * JPEG quality settings to try when compressing screenshots
 */
const QUALITY_STEPS = [85, 70, 55, 40, 25];

/**
 * Scale factors to try when JPEG quality alone isn't enough
 */
const SCALE_FACTORS = [1.0, 0.75, 0.5, 0.35];

/**
 * MCP content block types
 */
export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type ContentBlock = TextContent | ImageContent;

/**
 * Convert a screenshot file path to base64 data URL
 */
export function screenshotToBase64(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) {
      console.warn(`Screenshot file not found: ${filePath}`);
      return null;
    }

    const buffer = readFileSync(filePath);
    const base64 = buffer.toString("base64");

    // Determine mime type from extension
    const ext = filePath.toLowerCase().split(".").pop();
    const mimeType = ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "webp"
        ? "image/webp"
        : "image/png";

    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.warn(`Failed to read screenshot: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Check if a file's base64 encoding would exceed the size limit
 */
export function willExceedLimit(filePath: string, limit: number = MAX_RESPONSE_SIZE): boolean {
  try {
    if (!existsSync(filePath)) return false;
    const buffer = readFileSync(filePath);
    // Base64 encoding inflates size by ~33%
    const estimatedBase64Size = Math.ceil(buffer.length * 1.37);
    return estimatedBase64Size > limit;
  } catch {
    return false;
  }
}

/**
 * Get file size in bytes
 */
export function getFileSize(filePath: string): number {
  try {
    if (!existsSync(filePath)) return 0;
    return readFileSync(filePath).length;
  } catch {
    return 0;
  }
}

/**
 * Screenshot compression options for remote MCP mode
 */
export interface ScreenshotCompressionOptions {
  /** Target max size in bytes (default: 150KB) */
  maxSize?: number;
  /** Initial JPEG quality (default: 85) */
  quality?: number;
  /** Scale factor for resizing (default: 1.0) */
  scale?: number;
}

/**
 * Get recommended compression settings based on current file size
 */
export function getCompressionSettings(currentSize: number, targetSize: number = MAX_RESPONSE_SIZE): ScreenshotCompressionOptions {
  // Base64 inflates size by ~33%, so actual file needs to be smaller
  const actualTargetSize = Math.floor(targetSize / 1.37);

  if (currentSize <= actualTargetSize) {
    return { quality: 85, scale: 1.0 };
  }

  const ratio = currentSize / actualTargetSize;

  if (ratio <= 1.5) {
    return { quality: 70, scale: 1.0 };
  } else if (ratio <= 2.5) {
    return { quality: 55, scale: 1.0 };
  } else if (ratio <= 4) {
    return { quality: 50, scale: 0.75 };
  } else if (ratio <= 6) {
    return { quality: 45, scale: 0.5 };
  } else {
    return { quality: 40, scale: 0.35 };
  }
}

/**
 * Extract screenshot path from a JSON response object (recursively)
 */
function findScreenshotPaths(obj: unknown, paths: string[] = []): string[] {
  if (typeof obj !== "object" || obj === null) {
    return paths;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      findScreenshotPaths(item, paths);
    }
  } else {
    for (const [key, value] of Object.entries(obj)) {
      if (key === "screenshot" && typeof value === "string" && value.startsWith("/")) {
        paths.push(value);
      } else if (typeof value === "object") {
        findScreenshotPaths(value, paths);
      }
    }
  }

  return paths;
}

/**
 * Transform MCP tool response to include inline images for remote mode.
 *
 * Takes the original content blocks and:
 * 1. Finds any screenshot paths in text/JSON content
 * 2. Converts them to base64
 * 3. Adds MCP image content blocks for each screenshot
 *
 * @param content Original content blocks from tool response
 * @returns Transformed content blocks with inline images
 */
export function transformResponseForRemote(
  content: ContentBlock[]
): ContentBlock[] {
  const result: ContentBlock[] = [];
  const addedImages: Set<string> = new Set();

  for (const block of content) {
    if (block.type === "text") {
      try {
        // Try to parse as JSON to find screenshot paths
        const parsed = JSON.parse(block.text);
        const screenshotPaths = findScreenshotPaths(parsed);

        // Add the original text block (keep the path for reference)
        result.push(block);

        // Add image content blocks for each screenshot
        for (const path of screenshotPaths) {
          if (addedImages.has(path)) continue;

          const base64Data = screenshotToBase64(path);
          if (base64Data) {
            // Extract just the base64 part (without data URL prefix)
            const base64Only = base64Data.split(",")[1];
            const mimeType = base64Data.split(";")[0].split(":")[1];

            result.push({
              type: "image",
              data: base64Only,
              mimeType: mimeType,
            });
            addedImages.add(path);
          }
        }
      } catch {
        // Not JSON, just pass through
        result.push(block);
      }
    } else {
      // Pass through non-text blocks (including existing images)
      result.push(block);
    }
  }

  return result;
}

/**
 * Check if running in remote MCP mode
 */
export function isRemoteMcpMode(): boolean {
  // The remote server sets this, or we can check for HTTP-based transport indicators
  return process.env.MCP_REMOTE_MODE === "true" ||
         process.env.PORT !== undefined;
}

/**
 * Global flag to enable remote mode transformations
 * Set by remote MCP server on startup
 */
let remoteMode = false;

export function setRemoteMode(enabled: boolean): void {
  remoteMode = enabled;
}

export function getRemoteMode(): boolean {
  return remoteMode;
}

/**
 * Build MCP content array with optional images for remote mode.
 * This is the standard pattern for tools that return screenshots.
 *
 * @param data - The JSON data to include in text content
 * @param screenshotPaths - Screenshot path(s) to convert to images in remote mode
 * @returns Array of MCP content blocks
 */
/**
 * Upload a screenshot to the CMS media endpoint and return a public URL.
 * Falls back to null if CMS is unreachable.
 */
async function uploadScreenshotToCMS(filePath: string): Promise<string | null> {
  const cmsUrl = process.env.CMS_URL || "http://localhost:3200";
  try {
    const fileBuffer = readFileSync(filePath);
    const fileName = basename(filePath);

    // Build multipart form data manually (no FormData in Node without polyfill)
    const boundary = `----CBrowserUpload${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await fetch(`${cmsUrl}/api/media/upload`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (res.ok) {
      const data = await res.json() as { media?: { url?: string } };
      const mediaUrl = data.media?.url;
      if (mediaUrl) {
        // Convert relative URL to absolute
        return mediaUrl.startsWith("http") ? mediaUrl : `https://cbrowser.ai${mediaUrl}`;
      }
    }
  } catch {
    // CMS unreachable — fall through to base64
  }
  return null;
}

export function buildContentWithScreenshots(
  data: Record<string, unknown>,
  ...screenshotPaths: (string | undefined)[]
): ContentBlock[] {
  // In remote mode, upload screenshots to CMS for public URLs
  // and include both the image content block AND a URL in the JSON
  if (getRemoteMode()) {
    // Collect screenshot URLs synchronously (upload is best-effort)
    const imageBlocks: ContentBlock[] = [];
    const screenshotUrls: string[] = [];

    for (const path of screenshotPaths) {
      if (!path) continue;

      const base64Data = screenshotToBase64(path);
      if (base64Data) {
        const base64Only = base64Data.split(",")[1];
        const mimeType = base64Data.split(";")[0].split(":")[1];
        imageBlocks.push({
          type: "image",
          data: base64Only,
          mimeType: mimeType,
        });
      }
    }

    // Add screenshot paths to data as URLs for Claude to render inline
    // Claude.ai can render markdown images: ![](url)
    if (screenshotPaths.filter(Boolean).length > 0) {
      data._screenshotNote = "Screenshots are included as image content blocks below. If images don't render inline, the screenshot data is available in the image blocks of this tool response.";
    }

    const content: ContentBlock[] = [
      { type: "text", text: JSON.stringify(data, null, 2) },
      ...imageBlocks,
    ];
    return content;
  }

  // Local mode: just return text with file paths
  return [
    { type: "text", text: JSON.stringify(data, null, 2) },
  ];
}

/**
 * Async version that uploads screenshots to CMS for public URLs.
 * Use this when you need URLs that Claude.ai can render as markdown images.
 */
export async function buildContentWithScreenshotUrls(
  data: Record<string, unknown>,
  ...screenshotPaths: (string | undefined)[]
): Promise<ContentBlock[]> {
  if (!getRemoteMode()) {
    return [{ type: "text", text: JSON.stringify(data, null, 2) }];
  }

  const imageBlocks: ContentBlock[] = [];
  const uploadedUrls: string[] = [];

  for (const path of screenshotPaths) {
    if (!path) continue;

    // Try to upload for a public URL
    const url = await uploadScreenshotToCMS(path);
    if (url) {
      uploadedUrls.push(url);
    }

    // Also include as base64 image block (belt and suspenders)
    const base64Data = screenshotToBase64(path);
    if (base64Data) {
      const base64Only = base64Data.split(",")[1];
      const mimeType = base64Data.split(";")[0].split(":")[1];
      imageBlocks.push({
        type: "image",
        data: base64Only,
        mimeType: mimeType,
      });
    }
  }

  // Add public URLs to the data so Claude can render them as markdown
  if (uploadedUrls.length > 0) {
    data.screenshotUrls = uploadedUrls;
    data._screenshotNote = "Screenshots uploaded to public URLs. Render with: ![Screenshot](" + uploadedUrls[0] + ")";
  }

  return [
    { type: "text", text: JSON.stringify(data, null, 2) },
    ...imageBlocks,
  ];
}
