/**
 * Writing and checking files that hold credentials.
 *
 * `writeFileSync(path, data)` creates a file with mode 0666 masked by the
 * process umask -- 0644 on a default umask, i.e. readable by every account on
 * the machine. That is how the Anthropic API key came to be written: the call
 * site passed no mode, so the key's permissions were decided by whatever umask
 * happened to be in effect.
 *
 * Two traps this module exists to close:
 *
 *   1. `mode:` in writeFileSync options only applies when the file is CREATED.
 *      Writing to an existing 0644 file leaves it 0644, so a "fix" that only
 *      adds `{ mode: 0o600 }` silently does nothing for every user who already
 *      has the file -- which is all of them. An explicit chmod is required.
 *
 *   2. Credential files this tool only ever READS (geo-proxy.json is written by
 *      hand) have no write site to harden, so the only place to notice loose
 *      permissions is at load time.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { writeFileSync, chmodSync, statSync, existsSync } from "node:fs";

/** Owner read/write only. */
export const SECRET_MODE = 0o600;

/** POSIX permission bits, i.e. mode without the file-type bits. */
export function permissionBits(mode: number): number {
  return mode & 0o777;
}

/**
 * True when a mode grants any access to group or other.
 *
 * Checked as bits rather than by comparing to 0o600, because 0o400 (read-only
 * for the owner) is also perfectly safe and should not be reported as a leak.
 */
export function isGroupOrWorldAccessible(mode: number): boolean {
  return (permissionBits(mode) & 0o077) !== 0;
}

/** Windows has no POSIX mode bits; chmod there is meaningless, not merely unnecessary. */
function posix(): boolean {
  return process.platform !== "win32";
}

/**
 * Write a file containing a secret, owner-only.
 *
 * Chmods AFTER writing rather than relying on the `mode` option alone, so an
 * existing world-readable file is repaired instead of being written back at its
 * old permissions.
 */
export function writeSecretFile(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: SECRET_MODE });
  if (posix()) {
    try {
      chmodSync(path, SECRET_MODE);
    } catch {
      // A file we cannot chmod is still written. Failing the whole operation
      // because the tightening failed would be worse than proceeding: the
      // caller was trying to save the user's credential.
    }
  }
}

/**
 * Describe a credential file's permissions, or null when there is nothing to
 * report (absent, unreadable, Windows, or already owner-only).
 *
 * Returns a string rather than logging, so the caller decides whether this is a
 * warning, a hard failure, or a line in a report.
 */
export function describeLoosePermissions(path: string): string | null {
  if (!posix() || !existsSync(path)) return null;
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return null;
  }
  if (!isGroupOrWorldAccessible(mode)) return null;
  const octal = permissionBits(mode).toString(8).padStart(3, "0");
  return `${path} is mode ${octal} — readable beyond its owner. It holds a credential. Fix with: chmod 600 ${path}`;
}

/** Tighten an existing credential file. Returns true when a change was made. */
export function tightenPermissions(path: string): boolean {
  if (!posix() || !existsSync(path)) return false;
  try {
    if (!isGroupOrWorldAccessible(statSync(path).mode)) return false;
    chmodSync(path, SECRET_MODE);
    return true;
  } catch {
    return false;
  }
}
