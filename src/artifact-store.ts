/**
 * Served artifact store.
 *
 * Every tool that produces an image — heatmaps, motor overlays, comparison
 * heatmaps, journey GIFs — writes it somewhere and hands the caller back a
 * `https://cbrowser.ai/heatmaps/<file>` URL. Four call sites each hard-coded
 * their own directory, and none of them was the directory nginx serves:
 *
 *   nginx:  location ^~ /heatmaps/  ->  alias /var/www/cbrowser-data/heatmaps/
 *   code:   /home/wyld-web/static/cbrowser-web/out/heatmaps   (x4)
 *           /var/www/cbrowser-web/heatmaps                    (x1, first in a
 *                                                              fallback list)
 *
 * Measured 2026-07-29: the served directory's newest file was from Jul 19 and
 * fetched 200; a file written that morning by the live code fetched 404. So for
 * ten days every artifact URL the product returned to a paying customer was
 * dead, and nothing caught it, because each tool's notion of success was "the
 * write did not throw" rather than "the URL I am about to return resolves".
 *
 * The fix is not four corrected literals — that reproduces the same failure the
 * next time someone adds a fifth writer. Directory and URL are derived from ONE
 * constant here, and `writeArtifact` is the only sanctioned way to produce a
 * public artifact.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

/**
 * The directory nginx serves at `/heatmaps/`. Overridable so tests never write
 * into the production served root.
 */
export const ARTIFACT_DIR =
  process.env.CBROWSER_ARTIFACT_DIR || "/var/www/cbrowser-data/heatmaps";

/** Public origin the artifact directory is exposed under. */
export const ARTIFACT_BASE_URL =
  process.env.CBROWSER_ARTIFACT_BASE_URL || "https://cbrowser.ai/heatmaps";

export interface WrittenArtifact {
  /** Absolute path on disk. */
  path: string;
  /** Public URL that resolves to `path`, assuming the server is up. */
  url: string;
  /** Bare filename, for callers that build their own links. */
  filename: string;
}

/**
 * Write bytes into the served artifact directory and return both the on-disk
 * path and the URL that serves it.
 *
 * Returns `null` rather than throwing when the write fails: an artifact is
 * never worth failing a whole audit over. Callers MUST treat null as "no URL to
 * offer" and omit the field — handing back a URL for a file that was not
 * written is the defect this module exists to end.
 */
export function writeArtifact(
  data: Buffer | string,
  filename: string,
): WrittenArtifact | null {
  try {
    if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true });
    const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const path = join(ARTIFACT_DIR, safe);
    writeFileSync(path, typeof data === "string" ? Buffer.from(data, "base64") : data);
    return { path, url: `${ARTIFACT_BASE_URL}/${safe}`, filename: safe };
  } catch {
    return null;
  }
}

/** URL for a filename already known to live in the artifact directory. */
export function artifactUrl(filename: string): string {
  return `${ARTIFACT_BASE_URL}/${filename.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
}
