/**
 * Did we land on the content, or on something standing in front of it?
 *
 * `navigate` answered a narrower question than callers assumed. It reported whether
 * the request completed, and every cognitive tool downstream read that as "the page
 * is here". Two failures in one external session, neither surfaced:
 *
 *   claude.ai/code/artifact/<uuid>       reported success, 200, zero console errors
 *                                        -- rendered the SPA not-found branch
 *   <uuid>.frame.claudeusercontent.com   reported success
 *                                        -- rendered a Cloudflare Turnstile challenge
 *
 * The second is the instructive one, because the browser layer had ALREADY decided it
 * was a failure: it compared hosts, set `success: false` and `desyncDetected`, and
 * emitted "Expected domain: X, Actual domain: Y". The tool layer forwarded the warning
 * and dropped the verdict. The signal existed, was computed, and was discarded one
 * function above where it was produced.
 *
 * That matters more than a wrong status. `cognitive_effort` would have scored the
 * Turnstile interstitial as a page and called it comfortable, because an interstitial
 * genuinely IS low-effort: one button, no text, no choices. Every layer would have
 * been correct about the DOM it was given and wrong about the page it claimed to
 * describe. A wrong page analysed silently beats a refusal only in the sense that it
 * produces numbers.
 *
 * Deliberately NOT a bot-detection module. It answers one question -- "is there reason
 * to think this is not the requested content?" -- from signals navigation already has
 * in hand: requested URL vs landed URL, the title, the DOM size, and the browser's own
 * desync verdict. No new instrumentation, no network calls, no heuristics that need
 * tuning against a corpus. A caller that gets `ok: false` should decide for itself;
 * this never blocks a navigation.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

/** What `navigate` needs to expose for this to be decidable. */
export interface IntegrityInput {
  /** Where the browser actually ended up. */
  url: string;
  /** Document title as rendered. */
  title?: string;
  /** The browser layer's own verdict, when it reached one. */
  success?: boolean;
  /** Set by the browser layer when the landed host differs from the requested host. */
  desyncDetected?: boolean;
  /** Rendered HTML length, when the caller has it. Optional: absence is not evidence. */
  contentLength?: number;
}

export interface ContentIntegrity {
  /** False when there is positive reason to doubt this is the requested content. */
  ok: boolean;
  /** Machine-readable reasons. Empty iff ok. */
  reasons: string[];
  /** One sentence a caller can show a human. Absent when ok. */
  note?: string;
  /** Where the caller asked to go, when it differs from where it arrived. */
  requestedUrl?: string;
  landedUrl?: string;
}

/**
 * Titles interstitials use. Matched case-insensitively against the whole title, and
 * kept short on purpose: a list long enough to catch everything is long enough to
 * catch real pages, and a false "this is a challenge page" on a legitimate site is a
 * worse failure than a missed challenge. Cloudflare's own wording is the anchor.
 */
const CHALLENGE_TITLES = [
  "just a moment",
  "attention required",
  "checking your browser",
  "please wait...",
  "access denied",
  "verifying you are human",
  "one more step",
];

/**
 * Below this many characters of rendered HTML, a 200 is not plausibly a content page.
 * A challenge or an error stub is typically a few hundred bytes of shell; the smallest
 * real pages this tool is pointed at run to several thousand. Set where a miss is more
 * likely than a false positive, because this only ever ADDS a caveat -- it never
 * refuses a navigation, so the cost of the two errors is not symmetric.
 */
const IMPLAUSIBLY_SMALL_DOM = 500;

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

/** True when two hosts are the same site, treating sub/parent domains as the same. */
function sameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Judge a completed navigation. Never throws: an integrity check that can fail is a
 * new way for navigate to fail, which is not a trade worth making for a caveat field.
 */
export function describeContentIntegrity(
  requestedUrl: string,
  result: IntegrityInput,
): ContentIntegrity {
  const reasons: string[] = [];
  try {
    const wanted = hostOf(requestedUrl);
    const landed = hostOf(result.url);

    // The browser layer's verdict is authoritative where it has one. Recomputing the
    // host comparison here instead of reading it would let the two disagree, and two
    // sources of truth for one fact is how the original defect became invisible.
    if (result.desyncDetected || (wanted && landed && !sameSite(wanted, landed))) {
      reasons.push("cross-origin-landing");
    }

    const title = (result.title ?? "").trim().toLowerCase();
    if (title && CHALLENGE_TITLES.some((t) => title.includes(t))) {
      reasons.push("challenge-page-title");
    }

    // Absent length is UNKNOWN, not small. A check that treats missing data as a
    // finding manufactures findings on every caller that does not measure.
    if (typeof result.contentLength === "number" && result.contentLength < IMPLAUSIBLY_SMALL_DOM) {
      reasons.push("implausibly-small-dom");
    }

    if (result.success === false && reasons.length === 0) {
      reasons.push("navigation-reported-failure");
    }

    if (reasons.length === 0) return { ok: true, reasons: [] };

    return {
      ok: false,
      reasons,
      note: noteFor(reasons, requestedUrl, result.url),
      requestedUrl,
      landedUrl: result.url,
    };
  } catch {
    // Undecidable is not a finding. Saying "ok" here is the correct failure
    // direction only because this field exists to RAISE doubt, never to certify:
    // no caller should read `ok: true` as "verified content".
    return { ok: true, reasons: [] };
  }
}

function noteFor(reasons: string[], requested: string, landed: string): string {
  if (reasons.includes("challenge-page-title")) {
    return `This looks like an interstitial or challenge page, not ${requested}. Anything measured from it describes the interstitial.`;
  }
  if (reasons.includes("cross-origin-landing")) {
    return `Requested ${requested} but landed on ${landed}. The content is from a different origin than was asked for.`;
  }
  if (reasons.includes("implausibly-small-dom")) {
    return `The response rendered almost no content. A 200 with an near-empty DOM is usually an error or challenge stub.`;
  }
  return `The browser reported this navigation as failed.`;
}
