/**
 * assertion-value.ts — pull the expected value out of a natural-language assertion.
 *
 * WHY THIS EXISTS (bug found 2026-07-27, present in shipped 18.72.3)
 *
 * `evaluateAssertion` extracted the expected value with a quoted-string regex
 * and fell back to the empty string:
 *
 *     const match = assertion.match(/["']([^"']+)["']/);
 *     const expected = match?.[1] || "";
 *
 * Every string contains "", so `content.includes(expected)` was unconditionally
 * true. Any assertion written without quotes PASSED, whatever the page said:
 *
 *     assert page contains 'ZZQQXNOTPRESENT'   -> FAIL   (correct)
 *     assert page contains ZZQQXNOTPRESENT     -> PASS   (asserted nothing)
 *
 * Four branches shared the defect - title, url, page-contains and element-exists.
 * It is the worst shape a testing tool can have: the suite is green and the
 * greenness carries no information. Natural-language test suites are the feature
 * most likely to be written unquoted, and `verify page contains "results"` -
 * one of the vacuous forms - is the canonical example in our own CLI help.
 *
 * Note that the FINAL fallback in evaluateAssertion was always correct: no
 * quoted value meant `passed: false` with "Could not parse assertion." The fix
 * is to make every branch behave the way that one already did, and to actually
 * understand the unquoted phrasing rather than only rejecting it.
 *
 * TWO RULES, in order:
 *   1. A quoted value wins. Unchanged behaviour, so every passing assertion that
 *      was written correctly keeps its exact meaning.
 *   2. Otherwise take the text after the comparison word. `assert page contains
 *      Welcome back` means what it plainly says.
 *
 * And when neither yields anything, return null so the caller FAILS the
 * assertion. Never "" - that is the bug.
 */

/** Comparison words that separate the subject from the expected value. */
const COMPARATORS =
  /\b(?:contains?|containing|has|have|shows?|displays?|includes?|reads?|says?|is|are|was|equals?|matches?|starts? with|ends? with)\b\s*:?\s+(.+)$/i;

/** Filler that can sit between the comparator and the value in plain English. */
const LEADING_FILLER = /^(?:the\s+|a\s+|an\s+)?(?:text|string|word|words|value|content|title|url|link)\s+/i;

/** Trailing punctuation a human leaves on the end of a sentence. */
const TRAILING_PUNCT = /[.;,!?]+$/;

/**
 * The expected value in an assertion, or null when there isn't one.
 *
 * Returning null is load-bearing: the caller must fail the assertion rather than
 * compare against "", which every string contains.
 */
export function extractExpected(assertion: string): string | null {
  if (!assertion) return null;

  // 1. A quoted value always wins.
  const quoted = assertion.match(/["']([^"']+)["']/);
  if (quoted?.[1]) return quoted[1];

  // 2. Otherwise, whatever follows the comparison word.
  const rest = assertion.match(COMPARATORS)?.[1];
  if (!rest) return null;

  const cleaned = rest.replace(LEADING_FILLER, "").replace(TRAILING_PUNCT, "").trim();
  return cleaned.length ? cleaned : null;
}

/**
 * The selector in an existence assertion ("<selector> exists"), or null.
 *
 * Shaped differently from the others: the value comes BEFORE the keyword, as in
 * `assert login button exists`, so the comparator split does not apply.
 */
export function extractSubject(assertion: string): string | null {
  if (!assertion) return null;

  const quoted = assertion.match(/["']([^"']+)["']/);
  if (quoted?.[1]) return quoted[1];

  const before = assertion.match(/^(.*?)\b(?:exists?|is\s+visible|visible|is\s+present|present)\b/i)?.[1];
  if (!before) return null;

  // Only leading scaffolding is removed. Trailing nouns are NOT stripped: in
  // "signup link is visible" the word "link" is part of what findElement
  // resolves on (text, label, role), so dropping it changes the selector.
  const cleaned = before
    .replace(/^\s*(?:assert|verify|check|expect|ensure|confirm)\s+/i, "")
    .replace(/^\s*(?:that\s+)?(?:the\s+|a\s+|an\s+)?/i, "")
    .trim();

  return cleaned.length ? cleaned : null;
}

/** The message shown when nothing usable could be extracted. */
export const UNPARSEABLE_MESSAGE =
  'Could not read an expected value from this assertion. Put the value in quotes, e.g. assert page contains "Welcome".';
