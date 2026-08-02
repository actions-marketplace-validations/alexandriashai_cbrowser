/**
 * The cognitive-effort widget, and the one thing its chain block exists to say.
 *
 * cognitive_effort's whole model is that the six layers run in SEQUENCE: each
 * spends what the last left over, so a cost late in the chain lands on a
 * depleted budget. The payload states it as
 * `cognitiveTransportCost.sequentialAmplification` and buries it in a nested
 * object next to two other numbers.
 *
 * The widget's job is to make that visible rather than asserted, so these tests
 * pin the parts that carry the claim: the bottleneck is labelled in TEXT (not
 * colour alone), and colour and width use different denominators on purpose.
 *
 * That last one is not a style preference. Ramping colour on the shared scale
 * made every layer green -- the largest layer was 0.171 against a 0.742 total,
 * 23% of the ramp -- so a page at 63% abandonment risk rendered as six healthy
 * green bars. Verified by eye in a real browser, which is the only way that
 * class of bug is ever caught.
 *
 * @since 2026-08-02
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const kit = readFileSync(join(SRC, "mcp-tools", "widget-kit.ts"), "utf8");
const uiRes = readFileSync(join(SRC, "mcp-tools", "ui-resources.ts"), "utf8");
const tool = readFileSync(join(SRC, "mcp-tools", "base", "persona-comparison-tools.ts"), "utf8");

describe("the tool and the widget are actually connected", () => {
  test("cognitive_effort declares the effort resource", () => {
    const idx = tool.indexOf('registerTool("cognitive_effort"');
    expect(idx).toBeGreaterThan(-1);
    expect(tool.slice(idx, idx + 300)).toContain('resourceUri: "ui://cbrowser/effort"');
  });

  test("the resource is registered, so the declaration resolves", () => {
    // A tool pointing at a ui:// nobody serves renders as nothing at all, with
    // no error anywhere — the failure mode is silence.
    expect(uiRes).toContain('widgetUri("effort")');
    expect(uiRes).toContain("cbrowser-effort-ui");
    expect(uiRes).toContain("buildEffortTemplate");
  });

  test("the spec reads the fields the tool actually emits", () => {
    const spec = uiRes.slice(uiRes.indexOf("export const EFFORT_SPEC"));
    const head = spec.slice(0, spec.indexOf("export function buildEffortTemplate"));
    for (const field of [
      "layers", "bottleneck",
      "cognitiveTransportCost.additive", "cognitiveTransportCost.total",
      "abandonmentRisk", "interpretation",
    ]) {
      expect(head).toContain(field);
      // and the tool emits it
      expect(tool).toContain(field.split(".").pop()!);
    }
  });
});

describe("the chain block carries the claim", () => {
  test("the bottleneck gets a text label, never colour alone", () => {
    // WCAG 1.4.1. Especially load-bearing in a tool that reports on exactly this.
    expect(kit).toContain('el("span", "peaktag", "bottleneck")');
  });

  test("colour and width use different denominators", () => {
    // width: shared scale, so a layer bar and the sequential-total bar below it
    // are comparable. colour: relative to the largest LAYER, or nothing is hot.
    expect(kit).toContain("var layerMax = Math.max.apply(null, costs);");
    expect(kit).toContain("cost / layerMax");
    expect(kit).toMatch(/fill\.style\.width[\s\S]{0,80}scaleMax/);
  });

  test("the amplification bars share the layer scale", () => {
    // Drawn to a different ruler, the comparison the block exists to make would
    // be a lie told in pixels.
    expect(kit).toMatch(/scaleMax = Math\.max\.apply\(null, costs\.concat\(/);
  });

  test("it says why the total exceeds the sum, in words", () => {
    expect(kit).toContain("The layers run in sequence, so each one spends what the last left over");
    // And does NOT claim amplification when there is none.
    expect(kit).toContain("no layer is arriving on a materially depleted budget");
  });

  test("a chain with no layers renders nothing rather than an empty frame", () => {
    expect(kit).toMatch(/function chainBlock[\s\S]{0,200}if \(!isObjArray\(layers\) \|\| !layers\.length\) return null;/);
  });
});

describe("bars open into their layer's overlay", () => {
  test("a layer with an overlay becomes a real button", () => {
    // Not a styled div. Keyboard operability and the control role come free
    // from the right element; faking them with ARIA on a div does not.
    expect(kit).toContain('? document.createElement("button")');
    expect(kit).toContain('seg.type = "button"; seg.setAttribute("aria-expanded", "false")');
  });

  test("a layer WITHOUT an overlay stays inert and says why", () => {
    // An affordance that does nothing is worse than no affordance. Four
    // clickable bars and two silently dead ones reads as a broken widget.
    expect(kit).toContain('var interactive = !!(ov && ov.available && ov.file)');
    expect(kit).toContain('el("span", "noov", "no overlay")');
    expect(kit).toContain('why.title = String(ov.reason');
  });

  test("opening one layer closes the others", () => {
    expect(kit).toMatch(/querySelectorAll\("button\.seg"\)[\s\S]{0,120}aria-expanded", "false"/);
  });

  test("the image carries alt text naming the layer, not 'overlay image'", () => {
    expect(kit).toContain('node.alt = label + " overlay for this page: "');
  });

  test("a failed fetch says so instead of leaving a spinner", () => {
    expect(kit).toContain("Could not load the ");
    expect(kit).toContain("overlay could not be loaded");
  });

  test("the spec points the block at the payload field the tool emits", () => {
    const spec = uiRes.slice(uiRes.indexOf("export const EFFORT_SPEC"));
    expect(spec.slice(0, spec.indexOf("export function buildEffortTemplate")))
      .toContain('overlaysField: "layerOverlays"');
    expect(tool).toContain("response.layerOverlays = layerOverlays");
  });
});

describe("the server states why a layer has no overlay", () => {
  test("every layer without one carries a reason, not just a false flag", () => {
    for (const layer of ["cognitive-load", "decision", "frustration"]) {
      const idx = tool.indexOf(`layer: "${layer}", available: false`);
      expect(idx).toBeGreaterThan(-1);
      expect(tool.slice(idx, idx + 260)).toContain("reason:");
    }
  });

  test("saliency is computed keylessly, so it is not gated behind an API key", () => {
    // computeLabSaliency is centre-surround over the screenshot: no model call,
    // which is what lets this layer have an overlay on every run.
    expect(tool).toContain("computeLabSaliency");
    expect(tool).toContain("generateHeatmapOverlay");
  });

  test("the screenshot survives long enough to draw every overlay", () => {
    // It used to be deleted right after the motor overlay. Drawing the other
    // layers from it means the delete moves to the end.
    expect(tool).toContain("ssPath is deliberately NOT deleted here any more");
  });
});
