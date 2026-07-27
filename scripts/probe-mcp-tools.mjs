#!/usr/bin/env node
// ============================================================================
// probe-mcp-tools — a REAL probe for the local MCP tool contract
// ============================================================================
//
// Why this exists: the project ISA's MCP criteria (tool count, schema validity)
// carried the probe string `bash`, which the ISA probe runner executed literally.
// `bash` with no arguments and a closed stdin exits 0, so those criteria reported
// PASS for months without ever counting a tool. This script is the probe those
// criteria should have had: it drives dist/mcp-server.js over stdio exactly as an
// MCP client does, and exits non-zero on a real contract violation.
//
// Usage:
//   node scripts/probe-mcp-tools.mjs                 # report, exit 0 unless the contract breaks
//   node scripts/probe-mcp-tools.mjs --expect 72     # also require an exact served count
//   node scripts/probe-mcp-tools.mjs --json          # machine-readable
//
// Exit codes: 0 contract holds · 1 contract violated · 2 server never answered.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const expectIdx = argv.indexOf('--expect');
const expected = expectIdx >= 0 ? Number(argv[expectIdx + 1]) : null;

const child = spawn('node', ['dist/mcp-server.js'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
child.stdout.on('data', (d) => { stdout += d.toString(); });
child.stderr.on('data', () => {});

const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/initialized' }), 300);
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 700);

setTimeout(() => {
  child.kill();

  const nonJsonStdout = [];
  const msgs = [];
  for (const line of stdout.split('\n').filter((l) => l.trim())) {
    try { msgs.push(JSON.parse(line)); } catch { nonJsonStdout.push(line.slice(0, 160)); }
  }

  const listed = msgs.find((m) => m.id === 2);
  if (!listed) {
    console.error('probe-mcp-tools: server never answered tools/list');
    process.exit(2);
  }
  const tools = listed.result?.tools ?? [];
  const names = tools.map((t) => t.name);

  const violations = [];
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupes.length) violations.push(`duplicate tool names: ${dupes.join(', ')}`);

  const noDesc = tools.filter((t) => !String(t.description ?? '').trim()).map((t) => t.name);
  if (noDesc.length) violations.push(`tools with no description: ${noDesc.join(', ')}`);

  // inputSchema must be JSON Schema on the wire. A raw zod instance (keys like
  // _def / ~standard) is what a client sees when conversion silently fails.
  const badSchema = tools
    .filter((t) => !t.inputSchema || typeof t.inputSchema !== 'object' || Array.isArray(t.inputSchema) || t.inputSchema.type !== 'object')
    .map((t) => t.name);
  if (badSchema.length) violations.push(`tools whose inputSchema is not JSON Schema: ${badSchema.join(', ')}`);

  // Anything non-JSON-RPC on stdout corrupts the MCP stdio stream.
  if (nonJsonStdout.length) violations.push(`non-JSON-RPC lines on stdout: ${nonJsonStdout.length}`);

  if (expected !== null && tools.length !== expected) {
    violations.push(`served tool count ${tools.length} != expected ${expected}`);
  }

  if (asJson) {
    console.log(JSON.stringify({ served: tools.length, expected, violations }, null, 2));
  } else {
    console.log(`served tools: ${tools.length}${expected !== null ? ` (expected ${expected})` : ''}`);
    console.log(`duplicates: ${dupes.length} · missing descriptions: ${noDesc.length} · bad inputSchema: ${badSchema.length} · stdout noise: ${nonJsonStdout.length}`);
    for (const v of violations) console.error(`VIOLATION: ${v}`);
  }
  process.exit(violations.length ? 1 : 0);
}, 6000);
