/**
 * MCP Apps UI resources.
 *
 * MCP Apps lets a server return HTML that the host renders inline in the chat
 * rather than as a collapsed tool result. The mechanism is a `ui://` resource
 * served as `text/html;profile=mcp-app`, linked from a tool through
 * `_meta.ui.resourceUri`.
 *
 * Whether a given host actually renders it is a separate question from whether
 * the protocol negotiates: modelcontextprotocol/ext-apps#671 reports the full
 * handshake succeeding on claude.ai while the frontend still shows only the text
 * fallback, and it has been open since May 2026 with no maintainer response. So
 * this ships as a static probe first. If it renders, the capture player follows
 * through the same channel; if it does not, no hydration layer was built against
 * a surface that was never going to display.
 *
 * Registered from every server variant rather than one, because the servers the
 * hosted connectors actually run (demo, enterprise) are separate entrypoints from
 * mcp-server-remote, and a resource registered only in the latter is invisible to
 * both of them.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildWidget, widgetUri, MCP_APP_MIME as KIT_MIME, type WidgetSpec } from "./widget-kit.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

export const UI_PROBE_URI = "ui://cbrowser/probe";
export const CAPTURE_UI_PREFIX = "ui://cbrowser/capture/";

/**
 * Built player HTML, keyed by capture slug.
 *
 * The host reads a ui:// resource in a request separate from the tool call, so
 * the resource handler cannot know which capture is being asked about from the
 * call itself -- the slug in the URI is the only link between them. Hence a
 * store, and hence a per-capture URI rather than one fixed template URI.
 *
 * Bounded because these hold hundreds of KB of embedded frames each and a
 * long-lived server would otherwise accumulate every capture it ever ran.
 */
const CAPTURE_HTML_LIMIT = 24;
const captureHtml = new Map<string, string>();

/** Store a built player and return the resource URI that will serve it. */
export function publishCaptureUi(slug: string, html: string): string {
  captureHtml.set(slug, html);
  while (captureHtml.size > CAPTURE_HTML_LIMIT) {
    const oldest = captureHtml.keys().next().value;
    if (oldest === undefined) break;
    captureHtml.delete(oldest);
  }
  return `${CAPTURE_UI_PREFIX}${slug}`;
}
export const MCP_APP_MIME = KIT_MIME;

const PROBE_HTML = `<!doctype html><meta charset="utf-8">
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.55 ui-sans-serif,system-ui,sans-serif;margin:0;padding:18px}
  .card{border:1px solid rgba(128,128,128,.35);border-radius:10px;padding:16px}
  h1{font-size:1rem;margin:0 0 .5rem}
  code{font-family:ui-monospace,monospace;font-size:.85em}
  .ok{color:#1a7f4b;font-weight:600}
  .note{color:#666;font-size:.86rem;margin-top:.8rem}
</style>
<div class="card">
  <h1>CBrowser inline UI probe</h1>
  <p><span class="ok">This rendered as HTML.</span> MCP Apps UI resources display for
  this connector, so the capture player can be delivered the same way instead of as a link.</p>
  <p class="note">Served as <code>text/html;profile=mcp-app</code> from <code>ui://cbrowser/probe</code>.</p>
  <hr style="border:0;border-top:1px solid rgba(128,128,128,.3);margin:14px 0">
  <p><strong>data: URI image test</strong> &mdash; a green bar should appear below.</p>
  <img id="swatch" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAAoCAIAAAC6iKlyAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAo0lEQVR4nO3UQW0EARTD0MExlAxqqZdAr918VU8KAsvx836y9+8hPCi/X1EN6IDuP72N0QHdXENGNwcnHd2cRgd0cw0Z3RycdHRzGh3QzTVkdHNw0tHNaXRAN9eQ0c3BSUc3p9EB3VxDRjcHJx3dnEYHdHMNGd0cnHR0cxod0M01ZHRzcNLRzWl0QDfXkNHNwUlHN6fRAd1cQ0Y3BycdzZn+uh+XmLPx0sfXOwAAAABJRU5ErkJggg==" alt="data URI test swatch" width="120" height="40"
       style="border-radius:4px;display:block">
  <p class="note" id="verdict">If the bar is missing, this sandbox's CSP blocks
  <code>data:</code> in <code>img-src</code>, and capture frames need another channel.</p>
  <script>
    // The capture player embeds frames as data: URIs -- nothing is fetched from an
    // origin, because per-capture data cannot come from a static CDN and the
    // sandbox allowlist does not include cbrowser.ai. Whether that works hinges
    // entirely on img-src permitting data:, so the probe reports it rather than
    // leaving it to be discovered after a player is built on the assumption.
    var img = document.getElementById("swatch");
    img.addEventListener("load", function () {
      document.getElementById("verdict").textContent =
        "data: URIs render here (" + img.naturalWidth + "x" + img.naturalHeight +
        "). Capture frames can be embedded inline.";
    });
    img.addEventListener("error", function () {
      document.getElementById("verdict").textContent =
        "data: URI was BLOCKED by CSP. Capture frames need another channel.";
    });
  </script>
</div>`;

/**
 * Servers that already have these resources.
 *
 * The call site is genuinely ambiguous: startRemoteMcpServer registers them for
 * every server it builds, and the demo/enterprise entrypoints also need to
 * register them because they are separate builds. Whichever one you delete, the
 * other layer is wrong for some variant -- so registration is idempotent instead.
 * The SDK throws on a duplicate URI, which crash-loops the process at boot.
 */
const registered = new WeakSet<McpServer>();

/**
 * Render a status payload as a panel.
 *
 * Deliberately the first UI resource shipped, because it needs no subresources
 * at all -- counts, versions, config strings. That isolates the ui:// delivery
 * path (resource rides in the tool result, host injects, iframe renders) from
 * the separate question of what the sandbox CSP will fetch. One unknown at a
 * time; the capture player stacks two.
 *
 * The JSON block it accompanies is never replaced. status is read by the model
 * at least as often as by a person, and it is read to diff numbers -- a tool
 * that returned only a panel would leave the model able to report that a widget
 * appeared and nothing else.
 */
/**
 * The status view, as a spec rather than a template.
 *
 * This is the shape every other view now takes: name the fields, name the
 * blocks, and let the kit supply chrome, hydration, theming and safety. What
 * used to be 400 lines of markup and CSS per tool is the object below.
 */
export const STATUS_SPEC: WidgetSpec = {
  id: "status",
  title: "Status",
  hero: {
    variant: "gradient",
    subtitle: { field: "version" },
    health: {
      checks: [
        { field: "browsers", flag: "installed", failLabel: "browser not installed", nameKey: "name" },
        { field: "directories", flag: "exists", failLabel: "missing directory", nameKey: "name" },
      ],
    },
    facts: [
      { field: "toolCount", label: "tools" },
      { field: "browsers", label: "browsers", countFlag: "installed", attnWhenShort: true },
      { field: "directories", label: "directories", countFlag: "exists", attnWhenShort: true },
      { field: "sessions", label: "sessions" },
      { field: "healCache.totalHeals", label: "self-heals" },
    ],
  },
  blocks: [
    {
      type: "drawer",
      title: "Details",
      blocks: [
        { type: "kv", title: "Configuration", field: "config" },
        { type: "kv", title: "Self-healing cache", field: "healCache" },
        { type: "table", title: "Directories", field: "directories" },
        { type: "table", title: "Browsers", field: "browsers" },
        { type: "rest", title: "Counts and paths" },
      ],
    },
  ],
  footer: { label: "Data directory:", field: "dataDir" },
};

/**
 * Persona view: the three trait sections as the account editor draws them,
 * each on its own colour ramp so the section is readable without the heading.
 */
export const PERSONA_SPEC: WidgetSpec = {
  id: "persona",
  title: "Persona",
  // The name leads when there is one; "Persona" is the fallback for a payload
  // that has not named itself.
  titleField: "name",
  hero: {
    variant: "gradient",
    subtitle: { field: "description" },
    actions: [
      { label: "Customize this persona", url: "https://cbrowser.ai/account/personas" },
    ],
    facts: [
      { field: "traits", label: "traits" },
      { field: "values", label: "values" },
      { field: "accessibility_traits", label: "accessibility" },
    ],
  },
  blocks: [
    { type: "traits", title: "Cognitive traits", field: "traits", ramp: "trait", describe: true },
    { type: "traits", title: "Values", field: "values", ramp: "value" },
    { type: "traits", title: "Accessibility traits", field: "accessibility_traits", ramp: "accessibility", describe: true },
    {
      type: "drawer",
      title: "Details",
      blocks: [
        { type: "kv", title: "Demographics", field: "demographics" },
        { type: "rest", title: "Other fields" },
      ],
    },
  ],
};

/**
 * Attention heatmap view.
 *
 * The image is the finding here -- a JSON list of scores is a lossy
 * description of where a persona actually looks. It is fetched through
 * artifact_fetch rather than embedded or linked: the result cannot carry it
 * past the host's size cap, and the sandbox will not load cbrowser.ai.
 */
export const ATTENTION_SPEC: WidgetSpec = {
  id: "attention",
  title: "Attention",
  // Field names taken from a real tool result rather than assumed. The first
  // pass guessed topElements/elementsAnalyzed/url; the payload actually carries
  // topAttentionAreas, attentionQuality and no url at all, so every block was
  // pointed at a field that did not exist.
  titleField: "persona",
  hero: {
    variant: "gradient",
    subtitle: { field: "attentionReasoning" },
    facts: [
      { field: "topAttentionAreas", label: "areas" },
      { field: "attentionQuality", label: "quality" },
      { field: "alignmentScore", label: "alignment" },
      { field: "concentration", label: "concentration" },
    ],
  },
  blocks: [
    {
      type: "image",
      title: "Predicted attention",
      fetchTool: "artifact_fetch",
      fetchArgs: { file: "heatmapFile" },
      caption: "heatmapNote",
    },
    { type: "table", title: "Where attention lands", field: "topAttentionAreas" },
    {
      type: "drawer",
      title: "Details",
      blocks: [{ type: "rest", title: "All fields" }],
    },
  ],
};

/**
 * Screenshot view.
 *
 * The image is the whole result here, so the view is mostly frame: the shot
 * at full width, then the handful of facts that say what it is a picture of.
 * Fetched through artifact_fetch rather than read from the result, because a
 * compressed screenshot measured 144,731 base64 characters against a ~150k
 * cap -- it fits today and stops fitting on a denser page, and a view that
 * works until the page gets busy is worse than one that never did.
 */
export const SCREENSHOT_SPEC: WidgetSpec = {
  id: "screenshot",
  title: "Screenshot",
  titleField: "url",
  hero: {
    variant: "gradient",
    subtitle: { field: "title" },
    facts: [
      { field: "viewport", label: "viewport" },
      { field: "viewport_forced", label: "forced to" },
      { field: "fullPage", label: "full page" },
    ],
  },
  blocks: [
    {
      type: "image",
      title: "",
      fetchTool: "artifact_fetch",
      fetchArgs: { file: "screenshotFile" },
      caption: "_screenshotNote",
    },
    {
      type: "drawer",
      title: "Details",
      blocks: [{ type: "rest", title: "All fields" }],
    },
  ],
  footer: { label: "Saved:", field: "screenshot" },
};

/**
 * Trait lookup view.
 *
 * The five levels are the answer: what a reader wants from "patience at 0.30"
 * is where that sits relative to the other four bands and what it means
 * behaviourally, which a JSON array of level objects does not convey.
 *
 * Bands use the same red-to-green ramp as the persona meters, so 0.30 reads
 * identically in both views rather than being one colour here and another
 * there.
 */
export const TRAIT_SPEC: WidgetSpec = {
  // Served under a URI the host has never seen.
  //
  // The bisect proved the tool side is fine: pointed at ui://cbrowser/status
  // it renders. So the fault is specific to this resource, which parses,
  // registers and renders locally under test. The remaining explanation is a
  // cached negative for the URI -- the host was told to render
  // ui://cbrowser/trait while the resource had not yet deployed, and kept the
  // failure. A fresh URI cannot have a stale entry.
  id: "trait-v2",
  title: "Trait",
  titleField: "trait",
  hero: {
    variant: "gradient",
    subtitle: { field: "description" },
    facts: [
      { field: "value", label: "value" },
      { field: "label", label: "level" },
    ],
  },
  blocks: [
    {
      type: "levels",
      title: "Where this value sits",
      field: "allLevels",
      valueField: "value",
      labelField: "label",
      behaviorsField: "behaviors",
    },
    { type: "note", title: "Research basis", field: "researchBasis" },
    {
      type: "drawer",
      title: "Every level",
      blocks: [{ type: "table", title: "Levels", field: "allLevels" }],
    },
  ],
};

export function buildTraitTemplate(): string {
  return buildWidget(TRAIT_SPEC);
}

export function buildScreenshotTemplate(): string {
  return buildWidget(SCREENSHOT_SPEC);
}

export function buildAttentionTemplate(): string {
  return buildWidget(ATTENTION_SPEC);
}

export function buildPersonaTemplate(): string {
  return buildWidget(PERSONA_SPEC);
}

export function buildStatusTemplate(): string {
  return buildWidget(STATUS_SPEC);
}

/** Read back a published capture panel by its resource URI. */
export function readCaptureUi(uri: string): string | undefined {
  return captureHtml.get(uri.startsWith(CAPTURE_UI_PREFIX) ? uri.slice(CAPTURE_UI_PREFIX.length) : uri);
}

/** Register the inline-UI resources on a server. Safe to call more than once. */
export function registerUiResources(server: McpServer): void {
  if (registered.has(server)) return;
  registered.add(server);
  server.registerResource(
    "cbrowser-ui-probe",
    UI_PROBE_URI,
    { description: "Inline UI render probe (MCP Apps)", mimeType: MCP_APP_MIME },
    async () => ({
      contents: [{ uri: UI_PROBE_URI, mimeType: MCP_APP_MIME, text: PROBE_HTML }],
    }),
  );

  server.registerResource(
    "cbrowser-status-ui",
    "ui://cbrowser/status",
    { description: "CBrowser environment status panel", mimeType: MCP_APP_MIME },
    async () => ({
      contents: [{
        uri: "ui://cbrowser/status",
        mimeType: MCP_APP_MIME,
        // Read out of band there is no payload to render, so this stands in.
        // The populated panel travels inside the status tool result itself.
        text: buildStatusTemplate(),
      }],
    }),
  );

  server.registerResource(
    "cbrowser-trait-ui",
    widgetUri("trait-v2"),
    { description: "Trait level scale with behavioural bands", mimeType: MCP_APP_MIME },
    async () => ({
      contents: [{ uri: widgetUri("trait-v2"), mimeType: MCP_APP_MIME, text: buildTraitTemplate() }],
    }),
  );

  server.registerResource(
    "cbrowser-screenshot-ui",
    widgetUri("screenshot"),
    { description: "Screenshot with page and viewport context", mimeType: MCP_APP_MIME },
    async () => ({
      contents: [{ uri: widgetUri("screenshot"), mimeType: MCP_APP_MIME, text: buildScreenshotTemplate() }],
    }),
  );

  server.registerResource(
    "cbrowser-attention-ui",
    widgetUri("attention"),
    { description: "Attention heatmap with ranked elements", mimeType: MCP_APP_MIME },
    async () => ({
      contents: [{ uri: widgetUri("attention"), mimeType: MCP_APP_MIME, text: buildAttentionTemplate() }],
    }),
  );

  server.registerResource(
    "cbrowser-persona-ui",
    widgetUri("persona"),
    { description: "Persona traits, values and accessibility profile", mimeType: MCP_APP_MIME },
    async () => ({
      contents: [{ uri: widgetUri("persona"), mimeType: MCP_APP_MIME, text: buildPersonaTemplate() }],
    }),
  );

  server.registerResource(
    "cbrowser-capture-ui",
    // A template with no list callback never appears in resources/list, so a
    // host that discovers views by listing would never find a capture panel --
    // and it fails silently, the way a URI mismatch does. Published captures are
    // enumerated instead, which is cheap because the store is bounded at 24.
    new ResourceTemplate(`${CAPTURE_UI_PREFIX}{slug}`, {
      list: async () => ({
        resources: [...captureHtml.keys()].map((slug) => ({
          uri: `${CAPTURE_UI_PREFIX}${slug}`,
          name: `Capture player: ${slug}`,
          mimeType: MCP_APP_MIME,
        })),
      }),
    }),
    { description: "Inline capture player with embedded frames", mimeType: MCP_APP_MIME },
    async (uri, vars) => {
      const slug = String(Array.isArray(vars.slug) ? vars.slug[0] : vars.slug ?? "");
      const html = captureHtml.get(slug);
      return {
        contents: [{
          uri: uri.href,
          mimeType: MCP_APP_MIME,
          // An expired slug is normal, not an error: the store is bounded and a
          // host may re-read an old panel. Say so plainly instead of throwing.
          text: html ?? `<!doctype html><meta charset="utf-8">
<div style="font:15px/1.5 ui-sans-serif,system-ui,sans-serif;padding:18px">
  <p>This capture is no longer held in memory. Re-run the capture, or open the full
  player link from the original tool result.</p>
</div>`,
        }],
      };
    },
  );
}
