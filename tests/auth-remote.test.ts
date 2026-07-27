// ============================================================================
// Remote MCP account-key authentication — bun test suite
// ============================================================================
//
// Regression cover for the 2026-07-26 authentication bypass on the hosted
// enterprise MCP server (enterprise.cbrowser.ai -> :3100).
//
// The bug: validateAuth authenticated with
//     const tier = await resolveApiKeyTier(rawKey);
//     if (tier) return { valid: true };
// and resolveApiKeyTier returns the STRING "free" on every failure path (key
// unknown, CMS non-2xx, CMS unreachable). "free" is truthy, so every string
// starting with "cbk_" authenticated and the `valid: false` line under that
// call was unreachable. Probed live: `Bearer cbk_x` -> HTTP 200 + a real browser
// navigation; `Bearer x` -> 401. The prefix WAS the whole check.
//
// These tests drive validateAccountKey with an injected fetch so they are
// hermetic — no CMS, no network, no server.
//
// Run:  bun test tests/auth-remote.test.ts
//
// ---------------------------------------------------------------------------
// THIS FILENAME IS LOAD-BEARING, AND WE DO NOT FULLY KNOW WHY.
//
// It was `remote-auth.test.ts`, which sorts at position 25 — immediately after
// the ten `recording-*.test.ts` browser-capture files. In that position it
// reproduces 180s capture timeouts in OTHER files, 4 runs out of 4. Renamed to
// sort before that cluster: 4 runs out of 4 clean, with byte-identical content.
//
//   file at position 25   571 pass / 2 fail / 707.64s
//   same bytes, position 1   573 pass / 0 fail / 264.95s
//
// Ruled out by experiment, not by argument: the module import itself (an
// import-only probe at position 1 was clean, 265.61s), a global console patch
// (bisected clean, 264.03s), the AbortSignal.timeout in validateAccountKey
// (removing it changed 707.64s to 713.25s), shared CBROWSER_DATA_DIR contention
// (isolating it made things WORSE — 5 fails, 763s), orphaned Chrome
// accumulation (measured mid-suite: 1 process, 42GB free), and Bun test
// concurrency (`--max-concurrency=1` changed nothing).
//
// The real defect is upstream of this file: the recording-* tests do real
// wall-clock captures against 180s budgets with no headroom, so anything added
// near them tips them over. Renaming is a mitigation, not a cure — if you add a
// test file and the capture suite starts timing out, this is why. (2026-07-27)
// ---------------------------------------------------------------------------

import { describe, test, expect } from "bun:test";
import { validateAccountKey, _clearTierCache } from "../src/mcp-server-remote.js";

/** Build a fake CMS that answers with the given status + body. */
function cmsReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** A CMS that is down: the fetch itself rejects. */
const cmsDown: typeof fetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

// Distinct key per case — validateAccountKey memoises successful lookups.
let n = 0;
const freshKey = () => `cbk_test_${Date.now()}_${n++}`;

describe("validateAccountKey — identity is not pricing", () => {
  test("a key the CMS reports as INVALID is rejected", async () => {
    const v = await validateAccountKey(freshKey(), {
      fetch: cmsReturning(200, { valid: false }),
      cmsUrl: "http://cms.invalid",
    });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reason).toBe("unknown_key");
  });

  // The live CMS answers an unknown or revoked key with 401, not
  // 200-with-valid:false (cbrowser-web/cms/routes/accounts.ts:403). An explicit
  // rejection must be distinguished from an outage, or a key revoked seconds ago
  // rides the stale-serve grace for five minutes.
  test("a CMS 400/401/403 is an explicit rejection, not an outage", async () => {
    for (const status of [400, 401, 403]) {
      const v = await validateAccountKey(freshKey(), {
        fetch: cmsReturning(status, { error: "Invalid or revoked API key" }),
        cmsUrl: "http://cms.invalid",
      });
      expect(v.valid).toBe(false);
      if (!v.valid) expect(v.reason).toBe("unknown_key");
    }
  });

  test("a CMS 5xx is an outage, and still does NOT authenticate", async () => {
    for (const status of [500, 502, 503, 504]) {
      const v = await validateAccountKey(freshKey(), {
        fetch: cmsReturning(status, { valid: true, tier: "enterprise" }),
        cmsUrl: "http://cms.invalid",
      });
      expect(v.valid).toBe(false);
      if (!v.valid) expect(v.reason).toBe("backend_unreachable");
    }
  });

  test("a revoked key is evicted by the CMS 401 and cannot ride the outage grace", async () => {
    const key = freshKey();
    expect((await validateAccountKey(key, {
      fetch: cmsReturning(200, { valid: true, tier: "pro" }),
      cmsUrl: "http://cms.invalid",
    })).valid).toBe(true);

    _clearTierCache(); // stand in for TTL expiry so the CMS is consulted

    const revoked = await validateAccountKey(key, {
      fetch: cmsReturning(401, { error: "Invalid or revoked API key" }),
      cmsUrl: "http://cms.invalid",
    });
    expect(revoked.valid).toBe(false);
    if (!revoked.valid) expect(revoked.reason).toBe("unknown_key");

    const after = await validateAccountKey(key, { fetch: cmsDown, cmsUrl: "http://cms.invalid" });
    expect(after.valid).toBe(false);
  });

  test("an unreachable CMS fails CLOSED, never open", async () => {
    const v = await validateAccountKey(freshKey(), { fetch: cmsDown, cmsUrl: "http://cms.invalid" });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reason).toBe("backend_unreachable");
  });

  test("an unparseable CMS body does NOT authenticate", async () => {
    const v = await validateAccountKey(freshKey(), {
      fetch: cmsReturning(200, "<html>gateway</html>"),
      cmsUrl: "http://cms.invalid",
    });
    expect(v.valid).toBe(false);
  });

  test("a missing `valid` field does NOT authenticate (absence is not consent)", async () => {
    const v = await validateAccountKey(freshKey(), {
      fetch: cmsReturning(200, { tier: "enterprise" }),
      cmsUrl: "http://cms.invalid",
    });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reason).toBe("unknown_key");
  });

  test("`valid` that is merely truthy but not `true` does NOT authenticate", async () => {
    for (const truthy of [1, "yes", {}, []]) {
      const v = await validateAccountKey(freshKey(), {
        fetch: cmsReturning(200, { valid: truthy, tier: "pro" }),
        cmsUrl: "http://cms.invalid",
      });
      expect(v.valid).toBe(false);
    }
  });

  test("the live bypass shape — any cbk_-prefixed string — is rejected without CMS assent", async () => {
    for (const key of ["cbk_", "cbk_x", "cbk_zzzzzzzzzzzzzzzz", "cbk_00000000000000000000000000000000"]) {
      const v = await validateAccountKey(key, {
        fetch: cmsReturning(200, { valid: false }),
        cmsUrl: "http://cms.invalid",
      });
      expect(v.valid).toBe(false);
    }
  });

  test("a non-account key is not an account key", async () => {
    const v = await validateAccountKey("sk_something", {
      fetch: cmsReturning(200, { valid: true, tier: "enterprise" }),
      cmsUrl: "http://cms.invalid",
    });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reason).toBe("not_an_account_key");
  });

  test("an explicitly valid key authenticates and carries its tier", async () => {
    const v = await validateAccountKey(freshKey(), {
      fetch: cmsReturning(200, { valid: true, tier: "enterprise" }),
      cmsUrl: "http://cms.invalid",
    });
    expect(v.valid).toBe(true);
    if (v.valid) expect(v.tier).toBe("enterprise");
  });

  test("a valid key with no tier defaults to free rather than failing", async () => {
    const v = await validateAccountKey(freshKey(), {
      fetch: cmsReturning(200, { valid: true }),
      cmsUrl: "http://cms.invalid",
    });
    expect(v.valid).toBe(true);
    if (v.valid) expect(v.tier).toBe("free");
  });
});

// --------------------------------------------------------------------------
// Availability, from the 2026-07-26 cross-vendor audit OF THIS FIX. Failing
// closed is right, but with a 30s cache TTL and no grace it turned a routine
// CMS redeploy into a total auth outage; and with no fetch timeout, a CMS whose
// event loop was blocked hung every request instead of rejecting it. A hang is
// worse than what it replaced, because clients retry and pile up.
// --------------------------------------------------------------------------
describe("outage behaviour: bounded grace, never a reopened bypass", () => {
  test("a key the CMS already validated survives a subsequent outage", async () => {
    const key = freshKey();
    const first = await validateAccountKey(key, {
      fetch: cmsReturning(200, { valid: true, tier: "pro" }),
      cmsUrl: "http://cms.invalid",
    });
    expect(first.valid).toBe(true);
    const during = await validateAccountKey(key, { fetch: cmsDown, cmsUrl: "http://cms.invalid" });
    expect(during.valid).toBe(true);
    if (during.valid) expect(during.tier).toBe("pro");
  });

  test("a key the CMS NEVER validated is still rejected during an outage", async () => {
    const v = await validateAccountKey(freshKey(), { fetch: cmsDown, cmsUrl: "http://cms.invalid" });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reason).toBe("backend_unreachable");
  });

  // Documents an accepted trade rather than asserting a property the design does
  // not have: while a cache entry is fresh, validateAccountKey returns before
  // asking the CMS, so a revoked key keeps working for up to the cache TTL. The
  // first version of this test asserted immediate revocation and correctly
  // failed. The invariant that DOES hold, and is what protects us, is below.
  test("a fresh cache entry short-circuits the CMS — revocation is delayed, not instant", async () => {
    const key = freshKey();
    await validateAccountKey(key, {
      fetch: cmsReturning(200, { valid: true, tier: "pro" }),
      cmsUrl: "http://cms.invalid",
    });
    let cmsWasCalled = false;
    const spy = (async () => {
      cmsWasCalled = true;
      return new Response(JSON.stringify({ valid: false }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const during = await validateAccountKey(key, { fetch: spy, cmsUrl: "http://cms.invalid" });
    expect(cmsWasCalled).toBe(false);
    expect(during.valid).toBe(true);
  });

  test("once the CMS says invalid, the entry is evicted and the grace cannot resurrect it", async () => {
    const key = freshKey();
    expect((await validateAccountKey(key, {
      fetch: cmsReturning(200, { valid: true, tier: "enterprise" }),
      cmsUrl: "http://cms.invalid",
    })).valid).toBe(true);

    _clearTierCache(); // stand in for TTL expiry, so the CMS is actually consulted

    const revoked = await validateAccountKey(key, {
      fetch: cmsReturning(200, { valid: false }),
      cmsUrl: "http://cms.invalid",
    });
    expect(revoked.valid).toBe(false);
    if (!revoked.valid) expect(revoked.reason).toBe("unknown_key");

    // The outage grace must not bring a revoked key back.
    const after = await validateAccountKey(key, { fetch: cmsDown, cmsUrl: "http://cms.invalid" });
    expect(after.valid).toBe(false);
    if (!after.valid) expect(after.reason).toBe("backend_unreachable");
  });

  test("the CMS call carries an abort signal, so a wedged CMS cannot hang auth", async () => {
    let sawSignal = false;
    const spy = (async (_url: string, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Response(JSON.stringify({ valid: true, tier: "free" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await validateAccountKey(freshKey(), { fetch: spy, cmsUrl: "http://cms.invalid" });
    expect(sawSignal).toBe(true);
  });
});
