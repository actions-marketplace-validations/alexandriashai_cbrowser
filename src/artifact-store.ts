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

/** The directory nginx serves at `/heatmaps/`, when nothing overrides it. */
const DEFAULT_ARTIFACT_DIR = "/var/www/cbrowser-data/heatmaps";

/** Public origin that directory is exposed under, when nothing overrides it. */
const DEFAULT_ARTIFACT_BASE_URL = "https://cbrowser.ai/heatmaps";

/**
 * Resolved per call, NOT captured at import.
 *
 * These were `export const`, read once when the module was first evaluated. The
 * override then worked or not depending on whether anything else in the process
 * had imported this file first -- which in a test run is decided by file order,
 * something no test controls. tests/artifact-url.test.ts documented the hazard
 * in a comment and worked around it rather than removing it.
 *
 * The workaround held only because this box runs the suite as root, so a write
 * that escaped to the production default succeeded anyway. On a CI runner the
 * same escape is EACCES, `writeArtifact` returns null, and three tests fail --
 * which is what blocked 25 consecutive releases from 2026-08-03. A green suite
 * that is green because of an ambient privilege is not evidence.
 *
 * Reading the variable at call time makes the override authoritative in every
 * import order, and makes the tests hermetic instead of order-dependent.
 */
export function artifactDir(): string {
  return process.env.CBROWSER_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR;
}

/** Public origin the artifact directory is exposed under. Resolved per call. */
export function artifactBaseUrl(): string {
  return process.env.CBROWSER_ARTIFACT_BASE_URL || DEFAULT_ARTIFACT_BASE_URL;
}

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
  const dir = artifactDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const path = join(dir, safe);
    writeFileSync(path, typeof data === "string" ? Buffer.from(data, "base64") : data);
    return { path, url: `${artifactBaseUrl()}/${safe}`, filename: safe };
  } catch (err) {
    // Say WHY, and say WHERE. Swallowing this is how the original defect
    // survived ten days: every caller saw a bare null and reported "no
    // artifact", which reads as "nothing to show" rather than "the write
    // failed". A silent null is the same class of defect as a URL to a file
    // that was never written -- both hide the failure from whoever could fix
    // it. stderr, not the tool payload, so a customer response is unaffected.
    console.error(
      `[artifact-store] write failed: ${filename} -> ${dir}: ${(err as Error).message}`,
    );
    return null;
  }
}

/** URL for a filename already known to live in the artifact directory. */
export function artifactUrl(filename: string): string {
  return `${artifactBaseUrl()}/${filename.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
}
