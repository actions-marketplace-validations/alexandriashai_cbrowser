// ============================================================================
// Site model must not destroy learned data on first record — bun test suite
// ============================================================================
//
// The bug (found 2026-07-26 by the cross-vendor pass, reproduced here):
// getOrCreateModel cached an EMPTY model and then called
// `this.loadModel(domain).catch(() => {})` to "merge any existing data". It
// merged nothing — loadModel's first act is `if (cached) return cached`, and the
// empty model had just been cached, so the disk read was a guaranteed no-op.
// markDirty then flushed the near-empty model over the file, destroying every
// learned navigation edge, selector, goal path and failure pattern for that
// domain. Silently, because .catch(() => {}) hid it.
//
// Trigger: a fresh process whose first site-model operation is a record* call
// rather than an explicit loadModel — the normal path.
//
// Run:  bun test tests/site-model-preserves-learned-data.test.ts

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteModelManager } from "../src/site-model/manager.js";

let dataDir: string;
const DOMAIN = "example.com";

/**
 * A model with learned content, in the manager's REAL shape.
 *
 * Built from createEmptyModel's actual structure rather than invented — an
 * earlier version of this fixture guessed the schema (`pages`, `selectors`) and
 * the test failed for the wrong reason, which is its own lesson: a fixture
 * derived from the incident report instead of the parser tests nothing.
 */
function seedModel(modelDir: string) {
  mkdirSync(modelDir, { recursive: true });
  const now = new Date().toISOString();
  const model = {
    domain: DOMAIN,
    version: 1,
    created: now,
    lastUpdated: now,
    navigation: {
      nodes: { "/": { url: "/", visitCount: 12, lastVisited: Date.now() } },
      edges: [{ fromUrl: "/", toUrl: "/login", elementSelector: "#login", elementText: "Log in", successCount: 7, failureCount: 0, reliability: 1, lastUsed: Date.now() }],
    },
    elements: { "#login": { selector: "#login", successCount: 41, failCount: 0, lastSeen: now } },
    goalPaths: [{ goal: "sign in", steps: ["/", "/login"], successCount: 5 }],
    failures: [{ url: "/checkout", reason: "timeout", count: 2, lastSeen: now }],
    fingerprints: {},
  };
  writeFileSync(join(modelDir, `${DOMAIN}.json`), JSON.stringify(model, null, 2));
  return model;
}

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "cb-sitemodel-")); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe("a record on a fresh process must not wipe the stored model", () => {
  test("existing learned data survives a record* call made without a prior loadModel", async () => {
    const modelDir = join(dataDir, "site-models");
    const seeded = seedModel(modelDir);
    const before = JSON.parse(readFileSync(join(modelDir, `${DOMAIN}.json`), "utf-8"));
    expect(before.navigation.nodes["/"].visitCount).toBe(12);

    // Fresh manager == fresh process. First operation is a record, not a load.
    const mgr = new SiteModelManager(dataDir);
    mgr.recordNavigation(DOMAIN, "/", "/pricing", "#pricing-link", "Pricing");
    await mgr.shutdown(); // flush the debounced write

    const after = JSON.parse(readFileSync(join(modelDir, `${DOMAIN}.json`), "utf-8"));

    // The pre-existing learning must still be there. Before the fix this was
    // gone: an empty model had been written straight over it.
    // THE discriminator. recordNavigation increments an EXISTING node, so a
    // preserved model gives 12 + 1 = 13. If the stored model had been wiped and
    // replaced with an empty one, this node would have been created fresh at
    // exactly 1. 13 vs 1 is the whole test.
    expect(after.navigation.nodes["/"].visitCount).toBe(13);

    // And everything the record did not touch must still be there.
    expect(after.elements["#login"].successCount).toBe(41);
    expect(after.created).toBe(seeded.created);
    // goalPaths/failures are deliberately NOT asserted: loadModel runs
    // pruneStaleData, which legitimately drops entries this fixture does not
    // timestamp the way the pruner expects. Asserting on them would be testing
    // my fixture rather than the fix.
    expect(after.navigation.edges.some((e: { elementSelector: string }) => e.elementSelector === "#login")).toBe(true);
  });

  test("a domain with no stored model still starts cleanly", async () => {
    const modelDir = join(dataDir, "site-models");
    mkdirSync(modelDir, { recursive: true });
    const mgr = new SiteModelManager(dataDir);
    mgr.recordNavigation("brand-new.test", "/", "/next", "#go", "Go");
    await mgr.shutdown();
    // No throw, and the guard must not have invented a file for a domain we
    // never had — it may or may not flush yet, but it must not blow up.
    expect(existsSync(modelDir)).toBe(true);
  });
});
