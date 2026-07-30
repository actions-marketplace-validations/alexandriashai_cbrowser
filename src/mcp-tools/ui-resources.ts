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
export const MCP_APP_MIME = "text/html;profile=mcp-app";

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
export const EXT_APPS_ESM = "https://esm.sh/@modelcontextprotocol/ext-apps@1.7.5";

/**
 * Static status view.
 *
 * Takes no data, and that is the whole point. An MCP Apps resource is fetched
 * by the host via resources/read and cached against its URI, so it is identical
 * across every call -- there is no per-call server-side render step to put
 * values into. The numbers arrive separately: the host pushes the tool result
 * into the iframe over postMessage, and the view reads structuredContent from
 * it at runtime.
 *
 * The first version rendered a populated table server-side and shipped it in
 * the tool result as an embedded resource. That put several KB of HTML into the
 * model's context as a plain string and rendered nothing, because content
 * blocks are not views -- being a view is a property of being declared one.
 *
 * The SDK loads from esm.sh, which is on the sandbox's CSP origin allowlist.
 * That allowlist exists precisely so views can load their runtime.
 */
export function buildStatusTemplate(): string {
  return `<!doctype html><meta charset="utf-8">
<style>
  :root{color-scheme:light dark;--ink:#14161a;--ground:#fff;--muted:#6b7078;--rule:#dcdfe4;--accent:#2f6f4f;--card:#fff}
  @media (prefers-color-scheme:dark){:root{--ink:#e8eaed;--ground:#16181c;--muted:#9aa0a8;--rule:#31353b;--accent:#6fbf8f;--card:#1d2025}}
  :root[data-theme="dark"]{--ink:#e8eaed;--ground:#16181c;--muted:#9aa0a8;--rule:#31353b;--accent:#6fbf8f;--card:#1d2025}
  :root[data-theme="light"]{--ink:#14161a;--ground:#fff;--muted:#6b7078;--rule:#dcdfe4;--accent:#2f6f4f;--card:#fff}
  *{box-sizing:border-box}
  body{margin:0;padding:16px;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--ground)}
  .eyebrow{font:600 .67rem/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 .4rem}
  h1{font-size:1.05rem;margin:0 0 .9rem}
  .wrap{overflow-x:auto;border:1px solid var(--rule);border-radius:8px;background:var(--card)}
  table{border-collapse:collapse;width:100%;font-size:.85rem}
  th,td{text-align:left;padding:.42rem .7rem;border-bottom:1px solid var(--rule);vertical-align:top}
  tr:last-child th,tr:last-child td{border-bottom:0}
  th{font:.74rem/1.4 ui-monospace,monospace;color:var(--muted);font-weight:500;white-space:nowrap;width:1%}
  td{font-variant-numeric:tabular-nums;word-break:break-word}
  .status{font-size:.86rem;color:var(--muted)}
</style>
<p class="eyebrow">CBrowser</p>
<h1>Environment status</h1>
<div class="wrap"><table><tbody id="rows"></tbody></table></div>
<p class="status" id="status">Waiting for the host to deliver the tool result&hellip;</p>
<script type="module">
  import { App } from "${EXT_APPS_ESM}";

  var tbody = document.getElementById("rows");
  var status = document.getElementById("status");

  // Values are written with textContent, never innerHTML. The view is hydrated
  // from tool output, and tool output includes strings this server does not
  // control (paths, versions, browser names) -- interpolating those into markup
  // is how a status panel becomes an injection sink.
  function addRow(label, value) {
    var tr = document.createElement("tr");
    var th = document.createElement("th");
    var td = document.createElement("td");
    th.textContent = label;
    td.textContent = value === "" || value === null || value === undefined ? "\u2014" : String(value);
    tr.appendChild(th); tr.appendChild(td); tbody.appendChild(tr);
  }
  function walk(obj, prefix) {
    Object.keys(obj || {}).forEach(function (k) {
      var v = obj[k];
      var label = prefix ? prefix + "." + k : k;
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, label);
      else addRow(label, Array.isArray(v) ? v.join(", ") : v);
    });
  }
  function render(data) {
    if (!data) return;
    tbody.replaceChildren();
    walk(data, "");
    status.textContent = "";
  }

  var app = new App({ name: "cbrowser-status", version: "1.0.0" });
  app.addEventListener("toolresult", function (p) {
    render(p && (p.structuredContent || (p.result && p.result.structuredContent)));
  });
  try {
    await app.connect();
    status.textContent = "Connected. Waiting for status data\u2026";
  } catch (e) {
    status.textContent = "Could not connect to the host: " + (e && e.message ? e.message : e);
  }
</script>`;
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
    "cbrowser-capture-ui",
    new ResourceTemplate(`${CAPTURE_UI_PREFIX}{slug}`, { list: undefined }),
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
