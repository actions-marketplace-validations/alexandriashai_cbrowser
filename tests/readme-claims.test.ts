// Pin the README against the code, so the region list cannot drift again.
import { describe, test, expect } from "bun:test";
const README = await Bun.file(new URL("../README.md", import.meta.url)).text();
const SRC = await Bun.file(new URL("../src/geo-proxy.ts", import.meta.url)).text();

describe("README advertises only what the package ships", () => {
  test("the region list matches DEFAULT_REGIONS exactly", () => {
    // It advertised 12 including india and singapore; the package ships 10, so
    // both resolved to nothing on a clean install. They existed only in one
    // machine's local config file, which merges OVER the defaults — so the claim
    // was true on the author's box and false everywhere else.
    const blk = SRC.slice(SRC.indexOf("const DEFAULT_REGIONS"),
                          SRC.indexOf("};", SRC.indexOf("const DEFAULT_REGIONS")));
    const shipped = [...blk.matchAll(/"([a-z-]+)":\s*\{/g)].map((m) => m[1]).sort();
    const line = README.split("\n").find((l) => l.startsWith("**Regions:**"))!;
    const advertised = [...line.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).sort();
    expect(advertised).toEqual(shipped);
  });

  test("the stated count matches the list", () => {
    const line = README.split("\n").find((l) => l.startsWith("**Regions:**"))!;
    const n = [...line.matchAll(/`([a-z-]+)`/g)].length;
    expect(README).toContain(`Test from ${n} global regions`);
  });
});

describe("README does not advertise removed keys", () => {
  test("no stale accessibility axis in the tool table", () => {
    expect(README).not.toContain("findability, stability, accessibility, semantics");
    expect(README).toContain("agent-perceivability");
  });
});
