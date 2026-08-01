/**
 * persona_lookup and persona_values_lookup must answer the same question the
 * same way, for every persona, whatever the values came from.
 *
 * This exists because a fix rotted silently. persona_values_lookup used to
 * hard-error on any persona whose values lived on its own file rather than in
 * the shared registry; the fix routed it through resolvePersonaValues and was
 * verified by hand at the time. A later change then added a third source
 * ("derived", for personas whose values the trait derivation wrote) and the
 * fallback still read `source === "persona"`, so every regenerated custom
 * persona stopped matching and fell straight back into the error the fallback
 * existed to prevent. The by-hand verification could not catch it: it ran
 * before the third source existed.
 *
 * So the assertion here is deliberately not "these two names work". It is
 * "no persona resolves values in one tool and errors in the other", quantified
 * over whatever personas exist at run time — which covers sources nobody has
 * thought of yet, and is the only shape that survives someone adding a fourth.
 */
import { describe, expect, test } from "bun:test";
import { listPersonas, listEmotionalPersonas, getAnyPersona } from "../src/personas.js";
import { registerValuesTools, resolvePersonaValues } from "../src/mcp-tools/base/values-tools.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

function loadTools(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  registerValuesTools(
    {
      registerTool: (name: string, _cfg: unknown, fn: Handler) => { handlers[name] = fn; },
      tool: () => {}, registerResource: () => {}, resource: () => {},
    } as never,
    {} as never,
  );
  return handlers;
}

const personaNames = (): string[] =>
  [...listPersonas(), ...(listEmotionalPersonas() ?? [])]
    .map((p: unknown) => (typeof p === "string" ? p : (p as { name: string }).name))
    .filter((n): n is string => typeof n === "string" && !!getAnyPersona(n));

describe("persona values parity", () => {
  test("no persona resolves values in one tool and errors in the other", async () => {
    const tools = loadTools();
    const disagreements: string[] = [];

    for (const name of personaNames()) {
      const resolved = resolvePersonaValues(name);
      const raw = await tools.persona_values_lookup({ persona: name, includeInfluencePatterns: false });
      const payload = JSON.parse(raw.content.find((c) => c.type === "text")!.text);
      const lookupHasValues = resolved.source !== "none";
      const valuesToolErrored = !!payload.error;

      if (lookupHasValues && valuesToolErrored) {
        disagreements.push(`${name}: resolver source="${resolved.source}" but persona_values_lookup errored`);
      }
    }

    expect(disagreements).toEqual([]);
  });

  test("every non-registry source still yields a full ten-value profile", async () => {
    const tools = loadTools();
    const SCHWARTZ = ["selfDirection", "stimulation", "hedonism", "achievement", "power",
      "security", "conformity", "tradition", "benevolence", "universalism"];

    for (const name of personaNames()) {
      const resolved = resolvePersonaValues(name);
      if (resolved.source === "none" || resolved.source === "registry") continue;

      const raw = await tools.persona_values_lookup({ persona: name, includeInfluencePatterns: false });
      const payload = JSON.parse(raw.content.find((c) => c.type === "text")!.text);
      expect(payload.error).toBeUndefined();
      const returned = Object.keys(payload.schwartzValues ?? {});
      for (const key of SCHWARTZ) expect(returned).toContain(key);
    }
  });

  test("a persona with no values at all still reports it rather than inventing any", () => {
    const resolved = resolvePersonaValues("definitely-not-a-persona-xyz");
    expect(resolved.source).toBe("none");
    expect(resolved.values).toBeNull();
  });
});
