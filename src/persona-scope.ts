/**
 * Per-request persona scope for multi-tenant servers.
 *
 * THE PROBLEM THIS SOLVES, AND THE ONE IT REFUSES TO REINTRODUCE
 *
 * `personas.ts` resolves its data directory once, at module load, from
 * `CBROWSER_DATA_DIR`. That is correct for the CLI and for a single-user local
 * install, where one process serves one person. It cannot work for a hosted
 * server, where one process serves many accounts and each request needs a
 * different directory.
 *
 * The obvious shortcut — a module-level `let currentDataDir` that each request
 * assigns before doing its work — is the bug this file exists to avoid. This
 * codebase already made that mistake once and removed it: billing identity was
 * a module global until 2026-07-26, and `resolveRequestKeyHash` replaced it
 * precisely because a global cannot be right when two requests overlap. Applied
 * to personas the same shortcut is worse than a wrong charge: request A's tool
 * call would read request B's account directory, which is a cross-tenant read
 * of customer data, and it would only happen under concurrency — the condition
 * least likely to show up in a manual test and most likely in production.
 *
 * `AsyncLocalStorage` binds the value to the async context of one request
 * instead of to the process, so overlapping requests each see their own. That
 * is the only shape of this that is safe.
 *
 * DEFAULT BEHAVIOUR IS UNCHANGED. With no scope entered, `scopedDataDir()`
 * returns undefined and `personas.ts` falls back to exactly what it did before.
 * The CLI, the stdio server, and every local install are unaffected.
 *
 * @since 2026-08-01
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

export interface PersonaScope {
  /** The account whose personas this async context may read. */
  accountId: number;
  /** Data dir for that account: `<root>/accounts/<id>`. */
  dataDir: string;
}

const storage = new AsyncLocalStorage<PersonaScope>();

/** Where the CMS mirror writes. Must agree with cbrowser-web's persona-mirror.ts. */
export function accountDataDir(accountId: number, root?: string): string {
  const base = root
    ?? process.env.CBROWSER_MIRROR_ROOT
    ?? join(process.env.HOME || process.env.USERPROFILE || ".", ".cbrowser");
  return join(base, "accounts", String(accountId));
}

/**
 * Run `fn` with persona reads scoped to one account.
 *
 * Everything awaited inside — including tool handlers several frames deep — sees
 * this scope, and nothing outside it does.
 */
export function withPersonaScope<T>(accountId: number, fn: () => T): T {
  return storage.run({ accountId, dataDir: accountDataDir(accountId) }, fn);
}

/** The current context's data dir, or undefined when unscoped. */
export function scopedDataDir(): string | undefined {
  return storage.getStore()?.dataDir;
}

/** The current context's account, or undefined when unscoped. Diagnostics only. */
export function scopedAccountId(): number | undefined {
  return storage.getStore()?.accountId;
}
