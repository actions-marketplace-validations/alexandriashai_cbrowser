/**
 * Content integrity: the three shapes that reported success and were not the page.
 *
 * Each case here is one an external client actually hit and was not told about.
 * The Cloudflare one is the sharpest, because `navigate` had already decided it was a
 * failure and the tool layer published `success: true` next to the warning explaining
 * why it wasn't.
 *
 * The last two tests matter more than the first three. A doubt-raising check that
 * fires on healthy pages gets switched off, and one that certifies pages it never
 * examined is worse than nothing.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect } from "bun:test";
import { describeContentIntegrity } from "../src/content-integrity.js";

describe("content integrity", () => {
  test("a Cloudflare interstitial is not the page that was requested", () => {
    const r = describeContentIntegrity("https://example.test/report", {
      url: "https://example.test/report",
      title: "Just a moment...",
      success: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("challenge-page-title");
    expect(r.note).toContain("interstitial");
  });

  test("a cross-origin landing is reported, using the browser's own verdict", () => {
    // The exact case: a frame host requested, the parent app served instead. The
    // browser layer set desyncDetected; this reads that rather than recomputing it,
    // so the two can never disagree.
    const r = describeContentIntegrity("https://abc123.frame.example.test/f/x", {
      url: "https://example.test/",
      title: "Example",
      success: false,
      desyncDetected: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("cross-origin-landing");
    expect(r.requestedUrl).toBe("https://abc123.frame.example.test/f/x");
    expect(r.landedUrl).toBe("https://example.test/");
  });

  test("a 200 that rendered almost nothing is flagged", () => {
    // The SPA not-found branch: same host, HTTP 200, no console errors, no content.
    // Nothing else in the pipeline would have questioned it.
    const r = describeContentIntegrity("https://example.test/artifact/abc", {
      url: "https://example.test/artifact/abc",
      title: "Example",
      success: true,
      contentLength: 120,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("implausibly-small-dom");
  });

  test("a subdomain of the requested host is not a cross-origin landing", () => {
    // The false-positive that would make this unusable. www. redirects and CDN
    // subdomains are the overwhelmingly common case, and flagging them would train
    // every caller to ignore the field.
    const r = describeContentIntegrity("https://example.test/x", {
      url: "https://www.example.test/x",
      title: "Example",
      success: true,
      contentLength: 40_000,
    });
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  test("an unmeasured DOM is unknown, not small", () => {
    // Absence of a measurement is not a finding. A check that treats missing data as
    // evidence manufactures findings on every caller that does not measure, which is
    // most of them.
    const r = describeContentIntegrity("https://example.test/x", {
      url: "https://example.test/x",
      title: "Example",
      success: true,
    });
    expect(r.ok).toBe(true);
  });

  test("ok never means verified — it means no reason to doubt", () => {
    // Stated as a test because the field's name invites the opposite reading. A
    // caller that treats ok:true as proof of content has the same bug the tool
    // layer had: taking the absence of a complaint for a positive result.
    const undecidable = describeContentIntegrity("not-a-url", { url: "also-not-a-url" });
    expect(undecidable.ok).toBe(true);
    expect(undecidable.reasons).toEqual([]);
    // ...and it carries no note, so nothing in the payload asserts the page is good.
    expect(undecidable.note).toBeUndefined();
  });
});
