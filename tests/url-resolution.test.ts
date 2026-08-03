/**
 * The domain gate must run on where a URL GOES, not where it was typed.
 *
 * `ucdenver.edu` is a registered domain and 301s to `cudenver.edu`, which is
 * not. Reproduced 2026-08-03 with curl: one hop from the www host, two from the
 * apex. So an entire session's analyses were accepted against the registered
 * domain and performed against the unregistered one -- unregistered domains
 * reachable by redirect were analysable at no charge, and the results named the
 * requested URL while describing a different site.
 *
 * Resolution is a server-side fetch of a caller-supplied URL, which is its own
 * hazard, so these tests pin the constraints as hard as the behaviour.
 *
 * @since 2026-08-03
 */
import { test, expect, describe } from "bun:test";
import { resolveFinalUrl, isPrivateHost, sameSite } from "../src/url-resolution.js";

/** A fetch stand-in driven by a hop table, so no test touches the network. */
function fakeFetch(chain: Record<string, { status: number; location?: string }>) {
  const seen: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    seen.push(u);
    (impl as unknown as { lastInit: RequestInit | undefined }).lastInit = init;
    const hop = chain[u];
    if (!hop) throw new Error(`no stub for ${u}`);
    return {
      status: hop.status,
      headers: { get: (h: string) => (h.toLowerCase() === "location" ? hop.location ?? null : null) },
    } as unknown as Response;
  }) as unknown as typeof fetch & { seen: string[]; lastInit?: RequestInit };
  (impl as unknown as { seen: string[] }).seen = seen;
  return impl;
}

describe("the reported case", () => {
  test("a cross-domain redirect is followed and reported as a host change", async () => {
    const f = fakeFetch({
      "https://www.ucdenver.edu/academics": { status: 301, location: "https://www.cudenver.edu/academics" },
      "https://www.cudenver.edu/academics": { status: 200 },
    });
    const r = await resolveFinalUrl("https://www.ucdenver.edu/academics", f);
    expect(r.finalUrl).toBe("https://www.cudenver.edu/academics");
    expect(r.hostChanged).toBe(true);
    expect(r.finalHost).toBe("www.cudenver.edu");
    expect(r.hops).toBe(1);
    expect(r.error).toBeUndefined();
  });

  test("multiple hops resolve to the end of the chain", async () => {
    const f = fakeFetch({
      "https://ucdenver.edu/": { status: 301, location: "https://www.ucdenver.edu/" },
      "https://www.ucdenver.edu/": { status: 301, location: "https://www.cudenver.edu/" },
      "https://www.cudenver.edu/": { status: 200 },
    });
    const r = await resolveFinalUrl("https://ucdenver.edu/", f);
    expect(r.finalHost).toBe("www.cudenver.edu");
    expect(r.hops).toBe(2);
  });

  test("a www redirect within one site is NOT a host change", async () => {
    // Gating must not start denying example.com because it redirects to
    // www.example.com, which is most of the web.
    const f = fakeFetch({
      "https://example.com/": { status: 301, location: "https://www.example.com/" },
      "https://www.example.com/": { status: 200 },
    });
    const r = await resolveFinalUrl("https://example.com/", f);
    expect(r.hops).toBe(1);
    expect(r.hostChanged).toBe(false);
  });

  test("no redirect leaves everything alone", async () => {
    const f = fakeFetch({ "https://cbrowser.ai/": { status: 200 } });
    const r = await resolveFinalUrl("https://cbrowser.ai/", f);
    expect(r.finalUrl).toBe("https://cbrowser.ai/");
    expect(r.hostChanged).toBe(false);
    expect(r.hops).toBe(0);
  });
});

describe("failure returns the input, because denying on failure breaks the web", () => {
  test("a server that rejects HEAD ends the chain rather than erroring", async () => {
    const f = fakeFetch({ "https://example.com/": { status: 405 } });
    const r = await resolveFinalUrl("https://example.com/", f);
    expect(r.finalUrl).toBe("https://example.com/");
    expect(r.error).toBeUndefined();
  });

  test("a network failure returns the input with the reason attached", async () => {
    const f = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await resolveFinalUrl("https://example.com/", f);
    expect(r.finalUrl).toBe("https://example.com/");
    expect(r.error).toContain("ECONNREFUSED");
  });

  test("a redirect loop stops at the hop cap", async () => {
    const f = fakeFetch({
      "https://a.example/": { status: 302, location: "https://b.example/" },
      "https://b.example/": { status: 302, location: "https://a.example/" },
    });
    const r = await resolveFinalUrl("https://a.example/", f);
    expect(r.error).toContain("more than");
    expect(r.hops).toBeLessThanOrEqual(6);
  });

  test("a non-http scheme is refused before any request is made", async () => {
    const f = fakeFetch({});
    const r = await resolveFinalUrl("file:///etc/passwd", f);
    expect(r.error).toContain("unsupported protocol");
    expect((f as unknown as { seen: string[] }).seen).toEqual([]);
  });
});

describe("resolution does not become an SSRF primitive", () => {
  test("a redirect into private space is refused, not followed", async () => {
    const f = fakeFetch({
      "https://evil.example/": { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
    });
    const r = await resolveFinalUrl("https://evil.example/", f);
    expect(r.error).toContain("private address space");
    // The decisive assertion: the metadata endpoint was never requested.
    expect((f as unknown as { seen: string[] }).seen).toEqual(["https://evil.example/"]);
  });

  test("redirects are followed manually so a hop can be inspected before it runs", async () => {
    const f = fakeFetch({
      "https://example.com/": { status: 301, location: "https://www.example.com/" },
      "https://www.example.com/": { status: 200 },
    });
    await resolveFinalUrl("https://example.com/", f);
    // With redirect:"follow" the runtime walks the chain itself and a hop into
    // private space is already requested by the time we see the result.
    expect((f as unknown as { lastInit?: RequestInit }).lastInit?.redirect).toBe("manual");
    expect((f as unknown as { lastInit?: RequestInit }).lastInit?.credentials).toBe("omit");
  });

  test("every private range is covered, and public addresses are not", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "172.31.255.255",
      "169.254.169.254", "100.64.0.1", "0.0.0.0", "localhost", "foo.internal", "::1", "fd00::1", "fe80::1"]) {
      expect({ h, private: isPrivateHost(h) }).toEqual({ h, private: true });
    }
    for (const h of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "192.169.0.1",
      "100.128.0.1", "example.com", "www.cudenver.edu"]) {
      expect({ h, private: isPrivateHost(h) }).toEqual({ h, private: false });
    }
  });
});

describe("same-site comparison", () => {
  test("subdomains and parents count as the same site, unrelated hosts do not", () => {
    expect(sameSite("www.example.com", "example.com")).toBe(true);
    expect(sameSite("example.com", "www.example.com")).toBe(true);
    expect(sameSite("EXAMPLE.com", "example.COM")).toBe(true);
    expect(sameSite("ucdenver.edu", "cudenver.edu")).toBe(false);
    expect(sameSite("notexample.com", "example.com")).toBe(false);
  });
});
