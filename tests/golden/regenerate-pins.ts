/**
 * Golden-pin regenerator for the CIF scoring engine.
 *
 * Recomputes tests/golden/golden-scores.json from the fixtures in
 * tests/golden/fixtures/. Run this ONLY when a scoring change is
 * intentional -- the whole point of the pins is that unintentional
 * changes fail golden.test.ts.
 *
 *   bun tests/golden/regenerate-pins.ts
 *
 * The volatile `timestamp` field is stripped before pinning; everything
 * else computeCIFScore returns is captured literally.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCIFScore, type CIFInput, type CIFScore } from "../../src/cif-score.js";

const goldenDir = fileURLToPath(new URL(".", import.meta.url));
const fixturesDir = join(goldenDir, "fixtures");

const pins: Record<string, Omit<CIFScore, "timestamp">> = {};
for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort()) {
  const input = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as CIFInput;
  const { timestamp: _timestamp, ...pinned } = computeCIFScore(input);
  pins[file.replace(/\.json$/, "")] = pinned;
}

writeFileSync(join(goldenDir, "golden-scores.json"), JSON.stringify(pins, null, 2) + "\n");
console.log(`Pinned ${Object.keys(pins).length} fixtures to tests/golden/golden-scores.json`);
