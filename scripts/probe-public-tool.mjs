#!/usr/bin/env node
/**
 * Assert a named tool is registered by the PUBLIC registration path — the one
 * the hosted MCP server uses. Keyless, no server, no network.
 *
 *   node scripts/probe-public-tool.mjs cognitive_effort
 *
 * Exit 0 = registered, 1 = not.
 *
 * WHY THIS EXISTS
 *
 * ISC-5.1 claimed `cognitive_effort` is exposed by the hosted enterprise MCP,
 * and probed it by curling :3100 for tools/list. That port requires a bearer
 * token, so the probe got {"error":"Unauthorized"}, the grep found zero
 * matches, and the ISC was reported REFUTED — a verdict about our auth
 * configuration wearing the costume of a verdict about the product. It drove an
 * agency proposal to "fix cbrowser" against a tool that was never broken. That
 * is the second probe on this ISC to fail for a reason unrelated to the thing
 * it was measuring; the first invoked a CLI verb that never existed.
 *
 * A probe that cannot pass is worse than no probe: it produces a red that reads
 * like a finding, and the noise trains you to ignore the channel.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT
 *
 * Proves: the tool survives the registration path the hosted server runs, so
 * deleting it, renaming it, or dropping its registrar from that path goes red
 * here. That is the failure mode worth catching automatically.
 *
 * Does NOT prove: that a deployed server on a given port is serving it right
 * now. That needs a key and a live call, which is ISC-5.2's job and is verified
 * by hand. Two claims, two probes, neither pretending to be the other.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const wanted = process.argv[2];
if (!wanted) {
  console.error("usage: probe-public-tool.mjs <tool_name>");
  process.exit(2);
}

const seen = new Set();
const server = new McpServer({ name: "isa-probe", version: "0.0.0" });

// Record every name either registration API is asked for. Registration itself
// may throw on a stub context; the NAME is what this probe is about, so a throw
// after the name is captured must not lose it.
for (const method of ["registerTool", "tool"]) {
  const original = server[method]?.bind(server);
  if (!original) continue;
  server[method] = (name, ...rest) => {
    seen.add(name);
    try {
      return original(name, ...rest);
    } catch {
      return null;
    }
  };
}

try {
  const mod = await import("../dist/mcp-tools/index.js");
  await mod.registerAllPublicTools(server, {});
} catch (err) {
  // A partial registration still tells us whether we got far enough to see the
  // tool. Only report the error when the answer is no, so a late unrelated
  // throw cannot turn a real pass into a false red.
  if (!seen.has(wanted)) {
    console.error(`registration threw before reaching ${wanted}: ${err?.message ?? err}`);
    process.exit(1);
  }
}

if (seen.has(wanted)) {
  console.log(`${wanted} registered (${seen.size} tools on the public path)`);
  process.exit(0);
}
console.error(`${wanted} NOT registered — ${seen.size} tools seen on the public path`);
process.exit(1);
