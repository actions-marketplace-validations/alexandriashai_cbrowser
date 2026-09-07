/**
 * What `npm uninstall -g cbrowser` leaves behind, and how to remove it.
 *
 * npm removes the package. It does not remove anything the package wrote, and
 * this tool writes a lot: measured on one real install, 403MB under
 * ~/.cbrowser including an Anthropic API key, an IPRoyal proxy password, and
 * 253MB of Chrome profile data with live session cookies for every site the
 * user had tested. It also installs a Claude skill into ~/.claude/skills, which
 * is outside the package entirely and which npm therefore cannot know about.
 *
 * A user who uninstalls reasonably believes they are done. They are not, and
 * what survives is exactly the sensitive part.
 *
 * Design notes:
 *
 *   - Reporting is separate from deleting. `planUninstall()` is pure -- it
 *     stats the filesystem and returns a plan -- so the command can show the
 *     user what will happen, and so tests can assert the target set without
 *     removing anything.
 *   - Dry run is the default at the CLI. Deleting a user's captured work
 *     because they typed a command to see what it did is not recoverable.
 *   - Credentials are listed first and labelled, because they are the reason
 *     this exists. Disk space is the least interesting thing here.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { existsSync, statSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getDataDir } from "./config.js";

/** Why a target matters, which drives ordering and labelling. */
export type TargetKind = "credential" | "session" | "artifact" | "integration";

export interface UninstallTarget {
  path: string;
  kind: TargetKind;
  /** What this is, in the user's terms, not the filesystem's. */
  description: string;
  exists: boolean;
  bytes: number;
  /** Retained by --keep-config, which exists for the reinstall case. */
  isConfig: boolean;
}

export interface UninstallPlan {
  targets: UninstallTarget[];
  totalBytes: number;
  /** Credentials and sessions, i.e. what makes this a security matter. */
  sensitiveCount: number;
}

/** Recursive size. Returns 0 for anything unreadable rather than throwing. */
export function directorySize(path: string): number {
  let total = 0;
  let entries: string[];
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    total += directorySize(join(path, entry));
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Everything this tool writes outside its own npm package.
 *
 * Declared as data so it can be reviewed and tested. A hand-written deletion
 * sequence is how a target gets forgotten, and a forgotten credential is the
 * failure this module exists to prevent.
 */
function targetSpecs(
  dataDir: string,
  skillDir: string,
): Array<Omit<UninstallTarget, "exists" | "bytes">> {
  return [
    {
      path: join(dataDir, "config.json"),
      kind: "credential",
      description: "Anthropic API key",
      isConfig: true,
    },
    {
      path: join(dataDir, "geo-proxy.json"),
      kind: "credential",
      description: "residential proxy credentials",
      isConfig: true,
    },
    {
      path: join(dataDir, "accounts"),
      kind: "credential",
      description: "saved account credentials and keys",
      isConfig: false,
    },
    {
      path: join(dataDir, "browser-state"),
      kind: "session",
      description: "browser profile: cookies and logged-in sessions",
      isConfig: false,
    },
    {
      path: join(dataDir, "sessions"),
      kind: "session",
      description: "saved browser sessions",
      isConfig: false,
    },
    {
      path: join(dataDir, "har"),
      kind: "session",
      description: "HAR captures (include request headers, so may contain auth tokens)",
      isConfig: false,
    },
    {
      path: skillDir,
      kind: "integration",
      description: "Claude skill installed by `cbrowser install-skill`",
      isConfig: false,
    },
  ];
}

/**
 * Directories under the data dir that hold generated output rather than
 * anything sensitive. Enumerated by reading the data dir, so a capture type
 * added later is still removed -- the alternative is a hand-kept list that goes
 * stale exactly the way the WCAG list did.
 */
function artifactTargets(
  dataDir: string,
  claimed: Set<string>,
): Array<Omit<UninstallTarget, "exists" | "bytes">> {
  if (!existsSync(dataDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return [];
  }
  return entries
    .map((e) => join(dataDir, e))
    .filter((p) => !claimed.has(p))
    .map((p) => ({
      path: p,
      kind: "artifact" as const,
      description: "captured output (screenshots, baselines, reports)",
      isConfig: false,
    }));
}

/** Stat the filesystem and describe what removal would do. Deletes nothing. */
export function defaultSkillDir(): string {
  return join(homedir(), ".claude", "skills", "CBrowser");
}

export function planUninstall(
  opts: { dataDir?: string; skillDir?: string; keepConfig?: boolean } = {},
): UninstallPlan {
  const dataDir = opts.dataDir ?? getDataDir();
  // Injectable, and not merely for tidiness. This path used to be computed from
  // homedir() inside targetSpecs, so a test that passed a temporary dataDir
  // still got the REAL ~/.claude/skills/CBrowser in its plan -- and a test that
  // then called executeUninstall deleted it off the developer's machine. It
  // did, here, on the first run.
  //
  // Any path a deletion module can reach must be injectable, or its tests are
  // live fire against the machine running them.
  const skillDir = opts.skillDir ?? defaultSkillDir();
  const specs = targetSpecs(dataDir, skillDir);
  const claimed = new Set(specs.map((s) => s.path));
  const all = [...specs, ...artifactTargets(dataDir, claimed)];

  const order: Record<TargetKind, number> = {
    credential: 0,
    session: 1,
    integration: 2,
    artifact: 3,
  };

  const targets = all
    .filter((s) => !(opts.keepConfig && s.isConfig))
    .map((s) => {
      const exists = existsSync(s.path);
      return { ...s, exists, bytes: exists ? directorySize(s.path) : 0 };
    })
    .filter((t) => t.exists)
    .sort((a, b) => order[a.kind] - order[b.kind] || b.bytes - a.bytes);

  return {
    targets,
    totalBytes: targets.reduce((sum, t) => sum + t.bytes, 0),
    sensitiveCount: targets.filter((t) => t.kind === "credential" || t.kind === "session").length,
  };
}

export interface UninstallResult {
  removed: string[];
  failed: Array<{ path: string; error: string }>;
  bytesFreed: number;
}

/** Execute a plan. The caller is responsible for having confirmed it. */
export function executeUninstall(plan: UninstallPlan): UninstallResult {
  const removed: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  let bytesFreed = 0;

  for (const target of plan.targets) {
    try {
      rmSync(target.path, { recursive: true, force: true });
      // Confirm rather than assume: rmSync with force:true does not throw for a
      // path it could not remove, so trusting it would report a credential as
      // deleted while it is still on disk. That is the precise failure this
      // whole module exists to prevent, so it is checked.
      if (existsSync(target.path)) {
        failed.push({ path: target.path, error: "still present after removal" });
        continue;
      }
      removed.push(target.path);
      bytesFreed += target.bytes;
    } catch (e) {
      failed.push({ path: target.path, error: (e as Error).message });
    }
  }

  return { removed, failed, bytesFreed };
}

/** The human-facing report for a plan. Returned rather than printed, so it is testable. */
export function renderPlan(plan: UninstallPlan, dryRun: boolean): string {
  if (plan.targets.length === 0) {
    return "Nothing to remove — no CBrowser data found on this machine.";
  }

  const lines: string[] = [];
  lines.push(dryRun ? "The following would be removed:" : "Removing:");
  lines.push("");

  const labels: Record<TargetKind, string> = {
    credential: "CREDENTIAL",
    session: "SESSION   ",
    integration: "INTEGRATION",
    artifact: "artifact  ",
  };

  for (const t of plan.targets) {
    lines.push(`  [${labels[t.kind]}] ${t.path}`);
    lines.push(`      ${t.description} — ${formatBytes(t.bytes)}`);
  }

  lines.push("");
  lines.push(`  ${plan.targets.length} items, ${formatBytes(plan.totalBytes)}`);
  if (plan.sensitiveCount > 0) {
    lines.push(
      `  ${plan.sensitiveCount} contain credentials or live session cookies — ` +
        `these survive \`npm uninstall\`.`,
    );
  }

  if (dryRun) {
    lines.push("");
    lines.push("  This was a dry run. Nothing has been removed.");
    lines.push("  Run `cbrowser uninstall --yes` to remove it.");
  }

  return lines.join("\n");
}
