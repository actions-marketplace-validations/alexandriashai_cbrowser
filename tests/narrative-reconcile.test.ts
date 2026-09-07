/**
 * The narrative must not silently contradict the metrics shipped beside it.
 *
 * Live repro, cbrowser.ai, 2026-08-05, one payload:
 *   ctaCaptureRate: 0
 *   interpretation: "CTAs are invisible to this persona..."
 *   attentionReasoning: "Clear, plainly-labeled CTAs like 'Try Free' and 'See
 *                        Example Report' stand out as safe next steps..."
 *
 * The bar for firing is deliberately high. A false "these disagree" note on a
 * narrative that was fine is its own defect, so the negative cases below matter
 * as much as the positive one.
 */
import { describe, test, expect } from "bun:test";
import {
  reconcileAttentionNarrative,
  CTA_INVISIBLE_THRESHOLD,
} from "../src/visual/narrative-reconcile.js";

const LIVE_NARRATIVE =
  "High curiosity and security concern pull this first-timer toward the explanatory "
  + "headings, product-description paragraphs, and the Security nav link, while low "
  + "comprehension and risk tolerance make unlabeled icon links and the top-nav clutter "
  + "nearly invisible. Clear, plainly-labeled CTAs like 'Try Free' and 'See Example "
  + "Report' stand out as safe next steps, but pricing/enterprise/blog links get only "
  + "glancing attention since they don't clarify what CBrowser does.";

describe("reconcileAttentionNarrative — fires on the real contradiction", () => {
  test("the exact live payload is flagged", () => {
    const r = reconcileAttentionNarrative(LIVE_NARRATIVE, { ctaCaptureRate: 0 });
    expect(r?.contradictsMetrics).toBe(true);
    expect(r?.reconciliationNote).toContain("ctaCaptureRate");
  });

  test("it quotes the offending sentence rather than asserting one exists", () => {
    const r = reconcileAttentionNarrative(LIVE_NARRATIVE, { ctaCaptureRate: 0 });
    expect(r?.contradictingClaims?.length).toBe(1);
    expect(r!.contradictingClaims![0]).toContain("stand out");
  });

  test("the narrative itself is returned unchanged — annotated, never rewritten", () => {
    const r = reconcileAttentionNarrative(LIVE_NARRATIVE, { ctaCaptureRate: 0 });
    expect(r?.narrative).toBe(LIVE_NARRATIVE);
  });
});

describe("reconcileAttentionNarrative — stays quiet when it should", () => {
  test("no flag when the metric agrees that CTAs captured attention", () => {
    const r = reconcileAttentionNarrative(LIVE_NARRATIVE, { ctaCaptureRate: 0.42 });
    expect(r?.contradictsMetrics).toBe(false);
    expect(r?.reconciliationNote).toBeUndefined();
  });

  test("no flag at exactly the threshold — the boundary is not a contradiction", () => {
    const r = reconcileAttentionNarrative(LIVE_NARRATIVE, { ctaCaptureRate: CTA_INVISIBLE_THRESHOLD });
    expect(r?.contradictsMetrics).toBe(false);
  });

  test("a narrative that AGREES the CTAs were missed is not flagged", () => {
    const agreeing =
      "This persona never reaches the calls to action; attention pools on the headline "
      + "and the security copy instead.";
    const r = reconcileAttentionNarrative(agreeing, { ctaCaptureRate: 0 });
    expect(r?.contradictsMetrics).toBe(false);
  });

  test("matching is sentence-scoped, so a split claim does not trip it", () => {
    // "CTAs are ignored." + "The headline stands out." would trip a whole-string
    // match. It must not: nothing here says the CTAs captured anything.
    const split = "CTAs are ignored entirely. The headline stands out instead.";
    const r = reconcileAttentionNarrative(split, { ctaCaptureRate: 0 });
    expect(r?.contradictsMetrics).toBe(false);
  });

  test("a salience claim about something OTHER than a CTA is not flagged", () => {
    const other = "The hero image is eye-catching and dominates the fold.";
    const r = reconcileAttentionNarrative(other, { ctaCaptureRate: 0 });
    expect(r?.contradictsMetrics).toBe(false);
  });
});

describe("reconcileAttentionNarrative — degenerate inputs", () => {
  test("no narrative means nothing to reconcile", () => {
    expect(reconcileAttentionNarrative(undefined, { ctaCaptureRate: 0 })).toBeUndefined();
  });

  test("a missing metric is not treated as zero", () => {
    // Absent evidence must never be read as evidence of invisibility — that is
    // the failure mode that produces confident wrong flags.
    const r = reconcileAttentionNarrative(LIVE_NARRATIVE, {});
    expect(r?.contradictsMetrics).toBe(false);
  });

  test("null quality is safe", () => {
    const r = reconcileAttentionNarrative(LIVE_NARRATIVE, null);
    expect(r?.contradictsMetrics).toBe(false);
  });
});
