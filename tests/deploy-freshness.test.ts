/**
 * The deploy-freshness probe, and the property that makes it worth running.
 *
 * `scripts/check-deploy-freshness.mjs` was written 2026-07-26 after the hosted MCP
 * services drifted twice in a fortnight. It is correct. It had ZERO consumers — no
 * workflow step, no timer, no test, no script referenced it — so on 2026-08-03 the
 * same drift recurred and again nobody was told: /health served 18.79.0 while the
 * repo was 18.80.0, and the probe sat on disk reporting exactly that to nobody.
 *
 * A guard nothing runs is indistinguishable from a guard that does not exist. These
 * tests are the first consumer; `deployment/cbrowser-deploy-freshness.timer` is the
 * second, and the one that runs when no human is looking.
 *
 * The load-bearing property is the third test. A freshness check that reported
 * success when it could not reach the server would be worse than none — it would
 * assert freshness in exactly the situation where the server is unreachable because
 * it died. "I could not tell" must never render as "everything is fine."
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const PROBE = join(REPO, "scripts", "check-deploy-freshness.mjs");
const onDisk = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version as string;

/** A stand-in /health, so these tests never depend on the real hosted servers. */
function fakeHealth(version: string | null) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/health")) return new Response("no", { status: 404 });
      return Response.json(version === null ? { status: "ok" } : { status: "ok", version });
    },
  });
}

async function runProbe(url: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["node", PROBE, "--url", url], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  return { code, out };
}

const servers: ReturnType<typeof fakeHealth>[] = [];
afterAll(() => servers.forEach((s) => s.stop(true)));

describe("deploy-freshness probe", () => {
  test("a server running the on-disk version is fresh (exit 0)", async () => {
    const s = fakeHealth(onDisk);
    servers.push(s);
    const { code, out } = await runProbe(`http://127.0.0.1:${s.port}/health`);
    expect(out).toContain("fresh");
    expect(code).toBe(0);
  });

  test("a server running an older version is STALE (exit 1)", async () => {
    // The exact shape of the 2026-08-03 recurrence: published, built, not restarted.
    const s = fakeHealth("0.0.1-older");
    servers.push(s);
    const { code, out } = await runProbe(`http://127.0.0.1:${s.port}/health`);
    expect(out).toContain("STALE");
    expect(out).toContain(onDisk);
    expect(code).toBe(1);
  });

  test("unreachable is NOT fresh — the probe must read the running process", async () => {
    // THE load-bearing property. Port 1 is reserved and nothing listens there, so the
    // probe cannot learn anything about a running server. Any exit code of 0 here
    // would mean the probe can report freshness without having observed a process,
    // and it would report it loudest when the server is down.
    const { code, out } = await runProbe("http://127.0.0.1:1/health");
    expect(out).toContain("unreachable");
    expect(code).not.toBe(0);
    expect(code).toBe(2);
  });

  test("a 200 with no version field is unreachable, not fresh", async () => {
    // A degraded /health that answers but says nothing is the same epistemic state as
    // no answer: unknown. Treating a reply as evidence merely because it arrived is
    // how a health check comes to certify a server it never actually identified.
    const s = fakeHealth(null);
    servers.push(s);
    const { code, out } = await runProbe(`http://127.0.0.1:${s.port}/health`);
    expect(out).toContain("unreachable");
    expect(code).toBe(2);
  });

  test("the probe has a consumer that runs unattended", () => {
    // The defect was never the probe. It was that nothing invoked it, which is why it
    // reported the 2026-08-03 drift to nobody for the fifty minutes before a human
    // happened to look. This asserts the timer exists and points at the probe.
    const unit = readFileSync(
      join(REPO, "deployment", "cbrowser-deploy-freshness.service"),
      "utf8",
    );
    expect(unit).toContain("check-deploy-freshness.mjs");
    expect(unit).toContain("OnFailure=");

    const timer = readFileSync(
      join(REPO, "deployment", "cbrowser-deploy-freshness.timer"),
      "utf8",
    );
    expect(timer).toContain("[Timer]");
    expect(timer).toMatch(/OnUnitActiveSec|OnCalendar/);
  });
});
