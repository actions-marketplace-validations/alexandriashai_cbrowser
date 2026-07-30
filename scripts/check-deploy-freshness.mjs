#!/usr/bin/env node
/**
 * check-deploy-freshness — is the code that is RUNNING the code that is on DISK?
 *
 * Written 2026-07-26 because this drifted twice in a fortnight with nothing
 * alerting. On 2026-07-20 both hosted MCP services started and then sat there
 * while three releases landed on disk: /health reported 18.72.3 while
 * node_modules/cbrowser was 18.72.6. Shipped-but-not-live fixes included the
 * CMS X-Internal-Secret header and request-scoped billing identity, and the
 * only reason anyone noticed was a by-hand audit.
 *
 * Node loads its modules once at process start, so a `git pull` + `tsc` changes
 * nothing about a running server. mtime is not a usable signal either — the
 * deployed tree is copied with timestamps preserved, so its files can read older
 * than the code they contain. The served version string is the only honest
 * answer, which is why this compares that against package.json.
 *
 * Usage:
 *   node scripts/check-deploy-freshness.mjs                  # default endpoints
 *   node scripts/check-deploy-freshness.mjs --url http://127.0.0.1:3100/health
 *   node scripts/check-deploy-freshness.mjs --json
 *
 * Exit codes: 0 every endpoint matches · 1 at least one is stale · 2 an endpoint
 * could not be reached (unknown, NOT treated as fresh).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

const urls = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url' && argv[i + 1]) urls.push(argv[++i]);
}
if (!urls.length) urls.push('http://127.0.0.1:3000/health', 'http://127.0.0.1:3100/health');

const onDisk = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).version;

const results = [];
for (const url of urls) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      results.push({ url, status: 'unreachable', detail: `HTTP ${res.status}` });
      continue;
    }
    const body = await res.json();
    const served = body.version ?? null;
    if (!served) {
      results.push({ url, status: 'unreachable', detail: 'no version field in /health' });
      continue;
    }
    results.push({ url, served, onDisk, status: served === onDisk ? 'fresh' : 'STALE' });
  } catch (err) {
    results.push({ url, status: 'unreachable', detail: err instanceof Error ? err.message : String(err) });
  }
}

const stale = results.filter((r) => r.status === 'STALE');
const unreachable = results.filter((r) => r.status === 'unreachable');

if (asJson) {
  console.log(JSON.stringify({ onDisk, results, stale: stale.length, unreachable: unreachable.length }, null, 2));
} else {
  console.log(`on disk: ${onDisk}`);
  for (const r of results) {
    if (r.status === 'fresh') console.log(`  fresh       ${r.url} -> ${r.served}`);
    else if (r.status === 'STALE') console.log(`  STALE       ${r.url} -> ${r.served} (disk ${r.onDisk}) — restart to pick up the built code`);
    else console.log(`  unreachable ${r.url} — ${r.detail}`);
  }
}

// Unreachable is deliberately NOT success. A gate whose catch-all passes is the
// failure mode this whole audit kept finding; "I could not tell" must not read
// as "everything is fine".
if (stale.length) process.exit(1);
if (unreachable.length) process.exit(2);
process.exit(0);
