/**
 * What counts as a call to action.
 *
 * `ctaCount: 0` was reported on a page carrying a program-finder with three
 * selects and a submit button. The report suspected the viewport scope and
 * asked for a re-test at `full_page` before touching the classifier. That was
 * the right order and it explained PART of it:
 *
 *   page        scope      before  after
 *   /           viewport        0      1   ← the reported button
 *   /           full_page       0      3
 *   /academics  viewport        0      0   (genuinely nothing above the fold)
 *   /academics  full_page       0      7
 *
 * The rest was vocabulary. The keyword list held MARKETING language -- sign up,
 * get started, buy, subscribe, learn more -- which is what a landing page says
 * and not what a form says. A form's button is the most literal call to action
 * on a page and matched none of it.
 *
 * Two hypotheses were eliminated by measurement before that one survived, and
 * both are pinned below because both are easy to reintroduce.
 *
 * @since 2026-08-03
 */
import { test, expect, describe } from "bun:test";
import { detectCTAs, isFormSubmitControl } from "../src/analysis/page-understanding.js";

type El = Parameters<typeof isFormSubmitControl>[0];
const el = (over: Partial<El>): El => ({
  tag: "button", type: "submit", typeAttr: "", text: "", href: "", name: "", id: "",
  className: "", role: "", ariaLabel: "", disabled: false, formIndex: -1, nthOfType: 1,
  uniqueSelector: "", rect: { top: 100, left: 0, width: 120, height: 40 },
  ...over,
} as El);
const ctas = (els: El[]) => detectCTAs({ interactiveElements: els } as never).map((c) => c.text);

describe("the reported case", () => {
  test("a bare <button>Submit</button> outside a form is a CTA", () => {
    // The actual element on the page: no type attribute, no <form> ancestor,
    // 68x50 and fully visible. Nothing structural declares it; the label does.
    expect(ctas([el({ text: "Submit", typeAttr: "", formIndex: -1 })])).toEqual(["Submit"]);
  });

  test("an input[type=submit] is labelled by its value, not its textContent", () => {
    // <input type="submit" value="Apply"> has no textContent at all, so it read
    // as unlabelled and every classifier skipped it.
    expect(ctas([el({ tag: "input", typeAttr: "submit", text: "Apply", formIndex: 2 })])).toEqual(["Apply"]);
  });

  test("the university's primary CTA is recognised", () => {
    expect(ctas([el({ tag: "a", type: "", typeAttr: "", text: "Apply Now" })])).toEqual(["Apply Now"]);
  });
});

describe("the two hypotheses that measurement killed", () => {
  test("the IDL `type` is NOT an author declaration", () => {
    // HTMLButtonElement.type returns "submit" for ANY bare <button>, form or
    // no form. Testing it turned every menu toggle, search toggle and video
    // pause button on the page into a conversion point -- measured, 5 false
    // positives on one homepage.
    const menu = el({ text: "Menu", type: "submit", typeAttr: "", formIndex: -1 });
    expect(isFormSubmitControl(menu)).toBe(false);
    expect(ctas([menu])).toEqual([]);
  });

  test("requiring a <form> ancestor would miss the reported button entirely", () => {
    // The first attempt. It changed nothing, because the widget is JS-driven
    // and its submit sits outside any form.
    expect(isFormSubmitControl(el({ typeAttr: "submit", formIndex: -1 }))).toBe(true);
  });

  test("but a bare <button> INSIDE a form does submit by default, per spec", () => {
    expect(isFormSubmitControl(el({ tag: "button", typeAttr: "", formIndex: 0 }))).toBe(true);
    expect(isFormSubmitControl(el({ tag: "button", typeAttr: "", formIndex: -1 }))).toBe(false);
  });

  test("an explicit type=button is never a submit control", () => {
    expect(isFormSubmitControl(el({ typeAttr: "button", formIndex: 0 }))).toBe(false);
  });
});

describe("what is deliberately NOT a CTA", () => {
  test("a disclosure control is excluded even when its verb matches", () => {
    // "search toggle" opens a search box; it does not perform a search. Adding
    // `search` to the vocabulary made it a CTA on both test pages until this.
    for (const t of ["search toggle", "menu toggle", "expand section", "pause video", "close"]) {
      expect({ t, ctas: ctas([el({ text: t })]) }).toEqual({ t, ctas: [] });
    }
  });

  test("generic verbs stay out of the vocabulary", () => {
    // go / view / see / browse match a large share of ordinary link text and
    // would trade one false negative for a flood of false positives.
    for (const t of ["Go", "View details", "See all", "Browse the catalog", "More"]) {
      expect({ t, ctas: ctas([el({ tag: "a", type: "", typeAttr: "", text: t })]) }).toEqual({ t, ctas: [] });
    }
  });

  test("a disabled control is not a CTA", () => {
    expect(ctas([el({ text: "Submit", disabled: true })])).toEqual([]);
  });

  test("an unlabelled control is not a CTA", () => {
    expect(ctas([el({ text: "", ariaLabel: "", typeAttr: "submit" })])).toEqual([]);
  });

  test("an aria-label counts as a label, for icon-only submits", () => {
    expect(ctas([el({ text: "", ariaLabel: "Apply for admission", typeAttr: "submit" })]))
      .toEqual(["Apply for admission"]);
  });
});

describe("the marketing vocabulary still works", () => {
  test("the original keywords are unchanged", () => {
    const originals = ["Sign up", "Get started", "Subscribe", "Download", "Learn more", "Contact us", "Explore programs"];
    for (const t of originals) {
      expect({ t, found: ctas([el({ tag: "a", type: "", typeAttr: "", text: t })]).length })
        .toEqual({ t, found: 1 });
    }
  });

  test("a submit control ranks above tertiary, since submitting is the point", () => {
    const below = { top: 2000, left: 0, width: 100, height: 40 };
    const r = detectCTAs({ interactiveElements: [el({ text: "Submit", typeAttr: "submit", rect: below })] } as never);
    expect(r[0].prominence).not.toBe("tertiary");
  });
});
