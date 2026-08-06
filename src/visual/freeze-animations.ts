/**
 * Pause CSS animation before a saliency screenshot.
 *
 * WHY THIS EXISTS
 *
 * Two `attention_analysis` runs of the same page, same persona, back to back,
 * disagreed:
 *
 *   attentionReasoning   byte-identical (the LLM judgement is cached)
 *   heading basis        252.89805 / 252.89805   identical
 *   cta     basis        88.651654 / 88.487639   0.18% apart
 *
 * The element that stayed identical is a static H1. The elements that moved sit
 * in and beside a promo banner running `promo-shift 8s infinite`. The page
 * carries 122 running CSS animations, 119 of them infinite, so two screenshots
 * taken milliseconds apart are not the same image — and the saliency layer reads
 * the image.
 *
 * That variance was briefly mistaken for LLM nondeterminism, which it is not:
 * the judgement is cached on the screenshot bytes among other things, so it is
 * the stable half. The image is the moving half.
 *
 * WHY PAUSING IS ARGUABLY MORE CORRECT, NOT JUST MORE REPRODUCIBLE
 *
 * An infinite animation has no canonical frame. Sampling one at random measures
 * where attention would go during 1/N of a loop, and reports it as where
 * attention goes. Pausing at least makes the sampled state explicit and
 * repeatable. It is not free of judgement — a frozen frame is still one frame —
 * which is why this is opt-in and the response says which mode ran.
 *
 * NOT the default: every attention number published so far was measured with
 * animation live, and silently changing that would move every historical
 * comparison. Same reasoning as the `scope` parameter on cognitive_effort.
 *
 * @since 2026-08-05
 */

/** What ran, for the response to report rather than the caller to assume. */
export type AnimationState = "frozen" | "live";

/** Marker so the injected rule is identifiable and removable. */
export const FREEZE_STYLE_ID = "cbrowser-freeze-animations";

/**
 * Pause every CSS animation and transition, and hold animations at their first
 * frame so the result does not depend on when the pause landed.
 *
 * `animation-play-state: paused` alone freezes wherever the loop happened to be,
 * which is reproducible only within a single page load. `animation-delay` with a
 * large negative value would jump to a fixed offset; `-0.0001s` plus
 * `animation-iteration-count: 1` holds the opening frame, which is the one state
 * every load shares.
 */
export async function freezeAnimations(page: {
  addStyleTag: (o: { content: string }) => Promise<unknown>;
  emulateMedia?: (o: { reducedMotion?: "reduce" | "no-preference" }) => Promise<unknown>;
  evaluate: <T>(fn: () => T) => Promise<T>;
}): Promise<AnimationState> {
  // Ask the page nicely first: a site honouring prefers-reduced-motion will
  // disable its own animation, which is better than overriding it, because the
  // result is a state the site actually ships to real users.
  try {
    await page.emulateMedia?.({ reducedMotion: "reduce" });
  } catch { /* not every driver exposes it; the stylesheet below still applies */ }

  await page.addStyleTag({
    content: `
      /* ${FREEZE_STYLE_ID} */
      *, *::before, *::after {
        animation-play-state: paused !important;
        animation-delay: -0.0001s !important;
        animation-duration: 0.0001s !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
    `,
  });

  // Web Animations API instances ignore the stylesheet above entirely — this
  // page had 122 of them, all reported running, and a CSS-only freeze would have
  // looked like it worked while they kept playing.
  await page.evaluate(() => {
    try {
      for (const a of (document.getAnimations?.() ?? [])) {
        try { a.pause(); a.currentTime = 0; } catch { /* some are not seekable */ }
      }
    } catch { /* older engines */ }
  });

  return "frozen";
}

/**
 * How many animations are still running. Zero after a successful freeze.
 *
 * Reported rather than assumed: a freeze that silently failed would produce
 * exactly the variance it was asked to remove, under a label saying it had been
 * removed — which is the defect shape this codebase keeps finding in its own
 * metrics.
 */
export async function countRunningAnimations(page: {
  evaluate: <T>(fn: () => T) => Promise<T>;
}): Promise<number> {
  try {
    return await page.evaluate(() => {
      try {
        return (document.getAnimations?.() ?? []).filter((a) => a.playState === "running").length;
      } catch { return -1; }
    });
  } catch {
    return -1;
  }
}
