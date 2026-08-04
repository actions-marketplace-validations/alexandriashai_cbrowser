/**
 * Scope-dependent PROSE has to vary with scope, not only the numbers.
 *
 * ISC-39 asserted that a declared scope changes the measurement. It did, and
 * `scope: "sequential"` still returned whole-document numbers under first-screen
 * prose: "VIEWPORT ONLY", "most of it was not measured", and an abandonment figure
 * explained as conditional on the first screen while it was conditional on the whole
 * document.
 *
 * The criteria covering it passed. The response DID state a scope and DID state its
 * conditional. Both statements were false. So the guard has to assert what the
 * sentences claim, not that sentences exist -- which is the same lesson as the echoed
 * scope, one field type over.
 *
 * Written as a property over every enum value rather than three hand-written cases, so
 * a fourth scope is covered the day it is added rather than the day someone remembers.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { describe, test, expect } from "bun:test";
import { scopeProse, SCOPE_PROSE_VALUES } from "../src/visual/scope-prose.js";

describe("scope-dependent prose", () => {
  test("every scope produces distinct prose", () => {
    // The defect, stated directly: two scopes returned byte-identical strings because
    // one fell through to the other's branch.
    const notes = new Set(SCOPE_PROSE_VALUES.map((s) => scopeProse(s).scopeNote));
    const bases = new Set(SCOPE_PROSE_VALUES.map((s) => scopeProse(s).abandonmentBasis));
    expect(notes.size).toBe(SCOPE_PROSE_VALUES.length);
    expect(bases.size).toBe(SCOPE_PROSE_VALUES.length);
  });

  test("only the viewport scope may claim it measured the viewport", () => {
    // The specific false statement a caller acted on. Any scope that extracts the whole
    // document must not describe itself as first-screen, in any of its sentences.
    for (const scope of SCOPE_PROSE_VALUES) {
      const p = scopeProse(scope);
      if (scope === "viewport") continue;
      const claims = `${p.scopeNote} ${p.abandonmentBasis} ${p.subject}`.toLowerCase();
      expect(claims).not.toContain("viewport only");
      expect(claims).not.toContain("first screen");
      expect(claims).not.toContain("not measured");
      expect(p.subject).toBe("this page");
      expect(p.wholeDocument).toBe(true);
    }
  });

  test("the viewport scope still says so, plainly", () => {
    // The other direction. A fix that made every scope sound whole-page would pass the
    // test above and reintroduce the original undeclared-viewport defect.
    const p = scopeProse("viewport");
    expect(p.scopeNote).toContain("VIEWPORT ONLY");
    expect(p.abandonmentBasis).toContain("FIRST SCREEN");
    expect(p.subject).toBe("the top of this page");
    expect(p.wholeDocument).toBe(false);
  });

  test("sequential points at the block that holds its per-screen answers", () => {
    // Its aggregate is the full_page aggregate, which is exactly the thing a caller
    // would otherwise mistake for a per-screen number -- so the prose has to send them
    // to `sequential` rather than leave the envelope looking like the answer.
    const p = scopeProse("sequential");
    expect(p.abandonmentBasis).toContain("sequential");
    expect(p.abandonmentBasis).toContain("expectedDepthScreens");
    expect(p.abandonmentBasis).toContain("WHOLE-DOCUMENT");
  });

  test("the handler uses this module rather than its own copy", () => {
    // Extraction only helps if the served payload actually goes through it. Two copies
    // of the same sentences, one tested and one served, is the exact failure the layer
    // count already demonstrated.
    const src = require("node:fs").readFileSync(
      require("node:path").join(import.meta.dir, "..", "src", "mcp-tools", "base", "persona-comparison-tools.ts"),
      "utf8",
    ) as string;
    expect(src).toContain("scope-prose.js");
    // And no orphaned inline copy of the viewport sentence survives in the handler.
    expect(src.split("VIEWPORT ONLY: demand is computed").length - 1).toBe(0);
  });
});
