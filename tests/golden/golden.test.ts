/**
 * Golden-corpus regression tests for the CIF scoring engine.
 *
 * Each fixture in tests/golden/fixtures/ is scored with computeCIFScore and
 * deep-compared against its pinned result in golden-scores.json. Any change
 * to the scoring logic -- weights, thresholds, wording of `details` strings,
 * grade/certification bands -- fails here. If the change is intentional,
 * re-pin with: bun tests/golden/regenerate-pins.ts
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCIFScore, type CIFInput, type CIFScore } from "../../src/cif-score.js";

const goldenDir = fileURLToPath(new URL(".", import.meta.url));
const fixturesDir = join(goldenDir, "fixtures");

const fixtureNames = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

const pins = JSON.parse(
  readFileSync(join(goldenDir, "golden-scores.json"), "utf8"),
) as Record<string, Omit<CIFScore, "timestamp">>;

describe("CIF golden corpus", () => {
  test("pin file covers exactly the fixture set", () => {
    expect(Object.keys(pins).sort()).toEqual(fixtureNames);
  });

  for (const name of fixtureNames) {
    test(`${name} matches pinned CIFScore`, () => {
      const input = JSON.parse(
        readFileSync(join(fixturesDir, `${name}.json`), "utf8"),
      ) as CIFInput;
      const { timestamp, ...rest } = computeCIFScore(input);
      // timestamp is the one volatile field -- assert shape, not value
      expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
      expect(rest).toEqual(pins[name]!);
    });
  }
});
