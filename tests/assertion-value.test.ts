/**
 * Assertion value extraction
 *
 * Regression tests for a bug shipped in 18.72.3: `evaluateAssertion` extracted
 * the expected value with a quoted-string regex and fell back to `|| ""`. Every
 * string contains "", so any unquoted assertion passed no matter what the page
 * said:
 *
 *     assert page contains 'ZZQQXNOTPRESENT'   -> FAIL   (correct)
 *     assert page contains ZZQQXNOTPRESENT     -> PASS   (asserted nothing)
 *
 * Four branches shared it: title, url, page-contains, element-exists. This is
 * the worst failure shape a testing tool can have - the suite is green and the
 * greenness means nothing. Natural-language suites are exactly where people
 * write unquoted, and `verify page contains "results"` was one of the vacuous
 * forms while also being the example in our own CLI help.
 *
 * The tests that matter most here are the ones asserting null, because null is
 * what makes the caller FAIL rather than compare against "".
 */

import { describe, test, expect } from "bun:test";
import {
  extractExpected,
  extractSubject,
} from "../src/browser/assertion-value.js";

describe("extractExpected — quoted values (unchanged behaviour)", () => {
  test("double quotes", () => {
    expect(extractExpected('assert page contains "Welcome back"')).toBe("Welcome back");
  });

  test("single quotes", () => {
    expect(extractExpected("assert page contains 'Welcome back'")).toBe("Welcome back");
  });

  test("a quoted value wins over the unquoted tail", () => {
    // Guarantees every correctly-written assertion keeps its exact meaning.
    expect(extractExpected("assert page contains 'Welcome' now")).toBe("Welcome");
  });
});

describe("extractExpected — unquoted values now actually parse", () => {
  test("page contains", () => {
    expect(extractExpected("assert page contains Welcome back")).toBe("Welcome back");
  });

  test("title is", () => {
    expect(extractExpected("assert title is Home")).toBe("Home");
  });

  test("url contains", () => {
    expect(extractExpected("assert url contains /dashboard")).toBe("/dashboard");
  });

  test("strips filler between the comparator and the value", () => {
    expect(extractExpected("assert page has text Welcome")).toBe("Welcome");
    expect(extractExpected("assert page contains the text Welcome")).toBe("Welcome");
  });

  test("strips trailing sentence punctuation", () => {
    expect(extractExpected("assert page contains Welcome.")).toBe("Welcome");
  });
});

describe("extractExpected — returns null instead of empty string", () => {
  // THE BUG. Each of these previously yielded "" and therefore passed.
  test("no value after the comparator", () => {
    expect(extractExpected("assert page contains")).toBeNull();
  });

  test("no comparator at all", () => {
    expect(extractExpected("assert the page")).toBeNull();
  });

  test("empty input", () => {
    expect(extractExpected("")).toBeNull();
  });

  test("REGRESSION: never returns empty string, which every page contains", () => {
    // The minimal pair for the shipped defect. If this ever returns "", the
    // vacuous-pass bug is back, because `content.includes("")` is always true.
    for (const a of ["assert page contains", "assert title is", "assert url contains", ""]) {
      const got = extractExpected(a);
      expect(got).not.toBe("");
      expect(got).toBeNull();
    }
  });

  test("the empty-string comparison it prevents is genuinely vacuous", () => {
    // Positive control for the test above: proves why "" is the dangerous value
    // rather than merely an odd one.
    expect("any page text whatsoever".includes("")).toBe(true);
  });
});

describe("extractSubject — existence assertions put the value first", () => {
  test("quoted selector", () => {
    expect(extractSubject("assert '#login' exists")).toBe("#login");
  });

  test("unquoted subject", () => {
    expect(extractSubject("assert login form exists")).toBe("login form");
  });

  test("visible and present phrasings", () => {
    expect(extractSubject("assert signup link is visible")).toBe("signup link");
    expect(extractSubject("assert banner is present")).toBe("banner");
  });

  test("returns null when there is no subject", () => {
    expect(extractSubject("exists")).toBeNull();
    expect(extractSubject("")).toBeNull();
  });

  test("REGRESSION: never returns empty string", () => {
    // An empty selector fed to findElement is a different vacuous path to the
    // same place - it must fail, not resolve to "some element".
    for (const a of ["exists", "is visible", ""]) {
      expect(extractSubject(a)).not.toBe("");
    }
  });
});
