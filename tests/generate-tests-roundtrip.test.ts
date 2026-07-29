/**
 * generate_tests -> nl_test_inline round-trip.
 *
 * generate_tests emits a `cbrowserScript` and its own `usage` field tells the
 * caller to paste it into nl_test_inline. For a while it emitted a dialect of
 * its own invention — `navigate "url"`, `click "selector"` — which the parser
 * resolved to action:"unknown" on every line, so following the tool's own
 * instruction failed every step.
 *
 * The reason that shipped is worth stating: the check at the time asked whether
 * nl_test_inline ERRORED, not whether it PARSED. It did not error. It parsed
 * everything as unknown and reported 0% pass.
 *
 * This test asserts the two grammars agree, without a browser: it feeds a script
 * in the emitted shape straight through parseNLTestSuite and requires that no
 * step comes back unknown.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect } from "bun:test";
import { parseNLTestSuite } from "../src/testing/nl-test-suite.js";

/** The exact shapes generateCBrowserScript emits, one per action it supports. */
const EMITTED_SCRIPT = `# CBrowser Test Script
# Generated for: https://example.com

# Smoke Test
# Verify page loads
go to https://example.com/
click [data-testid="nav-docs"]
assert url contains '/docs/'
assert title contains 'Example'
fill #email with "user@example.com"
wait 2 seconds
# expected: no console errors
`;

describe("generate_tests -> nl_test_inline round-trip", () => {
  const suite = parseNLTestSuite(EMITTED_SCRIPT, "roundtrip");
  const steps = suite.tests.flatMap((t) => t.steps);

  test("the emitted script produces at least one parseable step", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("no emitted step parses as unknown", () => {
    const unknown = steps.filter((s) => s.action === "unknown");
    expect(unknown.map((s) => s.instruction)).toEqual([]);
  });

  test("each supported action survives the round-trip", () => {
    const actions = new Set(steps.map((s) => s.action));
    for (const expected of ["navigate", "click", "assert", "fill", "wait"]) {
      expect(actions.has(expected as never)).toBe(true);
    }
  });

  test("a selector keeps its quotes intact rather than nesting them", () => {
    // `click "[data-testid="x"]"` used to leave literal quotes in the target.
    const click = steps.find((s) => s.action === "click");
    expect(click?.target).toBe('[data-testid="nav-docs"]');
  });

  test("a url is not wrapped in quotes", () => {
    const nav = steps.find((s) => s.action === "navigate");
    expect(nav?.target).toBe("https://example.com/");
  });
});
