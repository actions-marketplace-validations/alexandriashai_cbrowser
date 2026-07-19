/**
 * Cookie domain resolution + Chromium SingletonLock staleness
 *
 * Pure-helper tests for two v18.72.3 fixes:
 *  - `cookie set --url https://site` must scope the cookie to the site host,
 *    not the hardcoded "localhost" default (which left the page anonymous).
 *  - A hard-killed browser leaves a stale SingletonLock symlink that wedges the
 *    next persistent launch; it is safe to remove ONLY when the target pid is
 *    provably dead.
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  hostFromUrl,
  resolveCookieDomain,
  parseSingletonLockPid,
  isStaleSingletonLock,
} from "../src/utils.js";

describe("hostFromUrl", () => {
  test("extracts host from a full URL", () => {
    expect(hostFromUrl("https://example.com/path?q=1")).toBe("example.com");
  });

  test("extracts a multi-label host", () => {
    expect(hostFromUrl("https://dev.blackbook.reviews")).toBe("dev.blackbook.reviews");
  });

  test("drops the port", () => {
    expect(hostFromUrl("http://localhost:3000/x")).toBe("localhost");
  });

  test("returns null for an unparseable string", () => {
    expect(hostFromUrl("not a url")).toBeNull();
    expect(hostFromUrl("")).toBeNull();
  });
});

describe("resolveCookieDomain", () => {
  test("explicit --domain wins over --url", () => {
    expect(resolveCookieDomain("foo.com", "https://bar.com")).toBe("foo.com");
  });

  test("derives the host from --url when no --domain", () => {
    expect(resolveCookieDomain(undefined, "https://dev.blackbook.reviews/x")).toBe(
      "dev.blackbook.reviews",
    );
  });

  test("defaults to localhost when neither flag is given", () => {
    expect(resolveCookieDomain(undefined, undefined)).toBe("localhost");
  });

  test("falls back to localhost when --url is unparseable", () => {
    expect(resolveCookieDomain(undefined, "garbage")).toBe("localhost");
  });

  test("property: a non-empty explicit domain always wins", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        fc.option(fc.webUrl(), { nil: undefined }),
        (domain, url) => {
          expect(resolveCookieDomain(domain, url)).toBe(domain);
        },
      ),
    );
  });

  test("property: with no --domain, the resolved domain is the --url host", () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const host = hostFromUrl(url);
        // fc.webUrl() always yields a parseable URL, so host is non-null.
        expect(resolveCookieDomain(undefined, url)).toBe(host as string);
      }),
    );
  });
});

describe("parseSingletonLockPid", () => {
  test("parses the trailing pid off a hostname-pid target", () => {
    expect(parseSingletonLockPid("myhost-12345")).toBe(12345);
  });

  test("parses when the hostname itself contains dashes", () => {
    expect(parseSingletonLockPid("my-host-name-4567")).toBe(4567);
  });

  test("trims surrounding whitespace", () => {
    expect(parseSingletonLockPid("  host-99  ")).toBe(99);
  });

  test("rejects a zero or non-positive pid", () => {
    expect(parseSingletonLockPid("host-0")).toBeNull();
  });

  test("rejects targets with no trailing integer", () => {
    expect(parseSingletonLockPid("host--")).toBeNull();
    expect(parseSingletonLockPid("nodigits")).toBeNull();
    expect(parseSingletonLockPid("")).toBeNull();
  });

  test("property: round-trips any positive pid appended to a host", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4194304 }), (pid) => {
        expect(parseSingletonLockPid(`somehost-${pid}`)).toBe(pid);
      }),
    );
  });
});

describe("isStaleSingletonLock", () => {
  test("stale when the target pid is dead", () => {
    expect(isStaleSingletonLock("host-123", () => false)).toBe(true);
  });

  test("NOT stale when the target pid is alive", () => {
    expect(isStaleSingletonLock("host-123", () => true)).toBe(false);
  });

  test("conservative: NOT stale when the target is unparseable", () => {
    // Never remove a lock we can't prove is dead.
    expect(isStaleSingletonLock("garbage", () => false)).toBe(false);
  });

  test("property: parseable target is stale iff the pid is not alive", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4194304 }), fc.boolean(), (pid, alive) => {
        expect(isStaleSingletonLock(`h-${pid}`, () => alive)).toBe(!alive);
      }),
    );
  });

  test("property: an unparseable target is never stale, whatever liveness says", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => parseSingletonLockPid(s) === null),
        fc.boolean(),
        (target, alive) => {
          expect(isStaleSingletonLock(target, () => alive)).toBe(false);
        },
      ),
    );
  });
});
