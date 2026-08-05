/**
 * The semantic classifier must match WORDS, not substrings.
 *
 * `classifySemanticType` feeds `computeValueRelevance`, which weights an
 * element by the persona's Schwartz values for that semantic type. So a
 * misclassification does not just mislabel a row in `topAttentionTargets` — it
 * routes the element through the wrong value weights and changes how much
 * attention the model predicts the persona gives it.
 *
 * Measured 2026-08-05 against the shipped patterns: 17 of 18 sampled UI strings
 * misclassified, every one of them because an alternative was an unanchored
 * substring. The worst was "Get started" -> social-proof (`star` inside
 * "started"), which meant every persona deliberately set LOW on social proof had
 * its attention to the most common CTA string on the web suppressed by a trait
 * that should never have been in that path.
 *
 * These are regression tests for a defect CLASS, so the negative corpus is
 * deliberately broad — one entry per pattern that had a substring alternative,
 * not just the one that was reported.
 */
import { describe, test, expect } from "bun:test";
import { classifySemanticType } from "../src/visual/attention-quality.js";

describe("classifySemanticType — word boundaries, not substrings", () => {
  // Each entry: [string, the pattern whose substring used to swallow it]
  const substringTraps: Array<[string, string]> = [
    ["Get started", "star"],
    ["Restart the run", "star"],
    ["Startup guide", "star"],
    ["Operating system", "rating"],
    ["Integrating with CI", "rating"],
    ["Generating report", "rating"],
    ["Unlock advanced mode", "lock"],
    ["Block a domain", "lock"],
    ["Clock skew", "lock"],
    ["Remember my choice", "member"],
    ["Pending invitations", "ending"],
    ["Sending results", "ending"],
    ["Extending trial", "ending"],
    ["Unsafe content warning", "safe"],
    ["Leaderboard", "leader"],
    ["Improvise a flow", "improv"],
    ["Live stream capture", "team"],
  ];

  test.each(substringTraps)("%p is not classified (was matching %p as a substring)", (text) => {
    expect(classifySemanticType(text)).toBe("none");
  });

  test("'unlimited' is not urgency — it is the opposite of scarcity", () => {
    expect(classifySemanticType("Unlimited tests on every plan")).toBe("none");
  });

  test("'Preview' reaches novelty instead of being swallowed by `review`", () => {
    // SOCIAL_PROOF is tested before NOVELTY, so an unanchored `review` claimed
    // this string before the novelty branch ever ran.
    expect(classifySemanticType("Preview your report")).toBe("novelty");
  });
});

describe("classifySemanticType — true positives still fire", () => {
  const positives: Array<[string, string]> = [
    ["Trusted by 400 companies", "trust-signal"],
    ["4.9 star rating", "social-proof"],
    ["Read our reviews", "social-proof"],
    ["10,000 users can't be wrong", "social-proof"],
    ["Join 5k users", "social-proof"],
    ["500+ customers", "social-proof"],
    ["Join the community", "community"],
    ["SSL encrypted", "trust-signal"],
    ["Verified and certified", "trust-signal"],
    ["Limited time offer", "urgency"],
    ["New in beta", "novelty"],
    ["40% faster", "metrics"],
    ["Award winner", "authority"],
  ];

  test.each(positives)("%p classifies as %p", (text, expected) => {
    expect(classifySemanticType(text)).toBe(expected);
  });
});

describe("classifySemanticType — a count is social proof only when it is boastable", () => {
  // The reported case. The numeral was a red herring: bare `users` was its own
  // alternative, so removing "17" changed nothing. Both halves are pinned here
  // so a future edit cannot fix one and reintroduce the other.
  test("'Test like 17 users, not like you' is a differentiation claim, not social proof", () => {
    expect(classifySemanticType("Test like 17 users, not like you")).not.toBe("social-proof");
  });

  test("the bare noun alone is never social proof", () => {
    expect(classifySemanticType("Test like users, not like you")).toBe("none");
    expect(classifySemanticType("Manage your customers")).toBe("none");
    expect(classifySemanticType("Client settings")).toBe("none");
  });

  test("small counts are not a boast; large ones are", () => {
    expect(classifySemanticType("17 users")).toBe("none");
    expect(classifySemanticType("400 users")).toBe("social-proof");
    expect(classifySemanticType("12k users")).toBe("social-proof");
    expect(classifySemanticType("50+ users")).toBe("social-proof");
  });

  test("explicit framing counts regardless of magnitude", () => {
    // "trusted by" is a claim about other people's judgement, which is what
    // social proof actually is. The magnitude rule only governs a BARE count.
    expect(classifySemanticType("Trusted by 12 companies")).not.toBe("none");
  });
});

describe("classifySemanticType — the class invariant", () => {
  // The property the fix establishes, stated once as a universal rather than as
  // 17 examples: prefixing a classified keyword with letters must not preserve
  // the classification, because that is precisely a substring match.
  const keywords = [
    "star", "rating", "review", "lock", "safe", "member",
    "ending", "leader", "team", "improv", "limited",
  ];

  test.each(keywords)("no classification survives prefixing %p with letters", (kw) => {
    // "xx" + keyword is never a real word we classify, so if it still matches,
    // the alternative is unanchored.
    expect(classifySemanticType(`xx${kw}`)).toBe("none");
  });
});
