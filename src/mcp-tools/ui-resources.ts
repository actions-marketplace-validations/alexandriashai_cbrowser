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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * The cbrowser mark, inlined as a data URI.
 *
 * The widget sandbox will not fetch cbrowser.ai, so a <img src="https://..."> to
 * the real logo renders as a broken image. URL-encoded rather than base64: the
 * source is text, and percent-encoding is smaller than base64 for text.
 *
 * Read from disk at module load rather than pasted into this file as an 8KB
 * literal, so the mark stays a single asset that can be replaced without
 * touching code.
 */
let logoUri: string | undefined;
function getLogoDataUri(): string {
  if (logoUri !== undefined) return logoUri;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const svg = readFileSync(join(here, "..", "..", "assets", "cbrowser-logo.svg"), "utf8")
      .replace(/\s*\n\s*/g, " ")
      .replace(/"/g, "'");
    logoUri = "data:image/svg+xml," + encodeURIComponent(svg).replace(/'/g, "%27");
  } catch {
    logoUri = "";
  }
  return logoUri;
}

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
/**
 * The ext-apps browser bundle, inlined into every widget.
 *
 * Not a CDN import. The iframe CSP blocks esm.sh from fetching the transitive
 * @modelcontextprotocol/sdk dependencies, and the failure mode is a blank
 * rectangle with the error visible only in the iframe's own devtools console --
 * nothing surfaces host-side, which is why an esm.sh import looks like it works
 * right up until nothing renders. Anthropic's own guidance names this the first
 * entry in its symptom table.
 *
 * Read once at module load. The replacer is a FUNCTION rather than a string
 * because String.replace interprets $-sequences in string replacements and the
 * minified bundle is full of them.
 */
let extAppsBundle: string | undefined;
function getExtAppsBundle(): string {
  if (extAppsBundle !== undefined) return extAppsBundle;
  try {
    const req = createRequire(import.meta.url);
    const raw = readFileSync(req.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
    extAppsBundle = raw.replace(/export\{([^}]+)\};?\s*$/, (_m, body: string) =>
      "globalThis.ExtApps={" +
      body.split(",").map((pair) => {
        const [local, exported] = pair.split(" as ").map((x) => x.trim());
        return `${exported ?? local}:${local}`;
      }).join(",") + "};");
  } catch {
    // A widget without its runtime says so rather than showing a blank card.
    extAppsBundle = 'globalThis.ExtApps=undefined;';
  }
  return extAppsBundle;
}

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
<meta name="color-scheme" content="light dark">
<style>
  /* Host tokens first, local fallbacks second, so the widget inherits Claude's
     type and colour when offered and still stands alone when not. */
  :root{
    --ink:var(--color-text-primary,#14161a);
    --sub:var(--color-text-secondary,#606770);
    --line:var(--color-border-default,#e0e3e8);
    /* Brand values are cbrowser-web/src/app/globals.css verbatim, so the panel
       and the site cannot drift apart. Host token first where one is offered. */
    --brand:oklch(0.55 0.18 250);
    --brand-2:oklch(0.6 0.18 180);
    --accent:var(--color-accent-primary,oklch(0.55 0.18 250));
    --warn:oklch(0.55 0.16 45);
    --raise:color-mix(in srgb, var(--ink) 4%, transparent);
    --r:var(--border-radius-md,8px);
    --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  :root.dark{--ink:#e9ebee;--sub:#98a0aa;--line:#333840;
    --brand:oklch(0.65 0.18 250);--brand-2:oklch(0.7 0.15 180);
    --accent:oklch(0.65 0.18 250);--warn:oklch(0.72 0.14 55);
    --raise:color-mix(in srgb, #fff 6%, transparent)}
  *{box-sizing:border-box}
  html,body{background:transparent;color:var(--ink)}
  body{margin:0;padding:2px 0 4px;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}

  /* Header: the one place with real scale contrast. Everything else is quiet. */
  .top{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin:0 0 .1rem}
  .mark{width:26px;height:26px;flex:0 0 auto;display:block}
  .name{font-size:1.06rem;font-weight:650;letter-spacing:-.01em}
  /* The single committed brand moment: a 2px blue-to-cyan rule under the header,
     drawn from the site's own brand-primary and brand-secondary. Everything else
     stays restrained, because a status panel is scanned, not admired. */
  /* Short and saturated rather than a full-width fade: at full width it reads as
     a divider, which is decoration pretending to be structure. 56px of the
     brand's own blue-to-cyan under the wordmark reads as a mark. */
  .rule{height:3px;width:56px;border-radius:3px;margin:.45rem 0 .1rem;
    background:linear-gradient(90deg,var(--brand),var(--brand-2))}
  .ver{font:.8rem/1 var(--mono);color:var(--sub);font-variant-numeric:tabular-nums}

  /* Summary strip: what you came to find out, before any detail. */
  .facts{display:flex;flex-wrap:wrap;gap:.35rem;margin:.55rem 0 .2rem}
  .fact{display:inline-flex;align-items:baseline;gap:.36rem;padding:.26rem .55rem;
    border:1px solid color-mix(in srgb,var(--brand) 22%,var(--line));
    border-radius:calc(var(--r) - 2px);
    background:color-mix(in srgb,var(--brand) 7%,transparent)}
  .fact b{font:600 .84rem/1 var(--mono);font-variant-numeric:tabular-nums;color:var(--brand)}
  .fact span{font-size:.76rem;color:var(--sub)}
  .fact.attn{border-color:var(--warn)}
  .fact.attn b{color:var(--warn)}

  details{border-top:1px solid var(--line);margin:0}
  details:last-of-type{border-bottom:1px solid var(--line)}
  summary{display:flex;align-items:center;gap:.5rem;padding:.6rem .15rem;cursor:pointer;
    list-style:none;user-select:none}
  summary::-webkit-details-marker{display:none}
  summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:4px}
  summary:hover .stitle{color:var(--accent)}
  .chev{flex:0 0 auto;width:9px;height:9px;border-right:1.6px solid var(--sub);
    border-bottom:1.6px solid var(--sub);transform:rotate(-45deg);margin-left:2px;
    transition:transform 180ms cubic-bezier(.22,1,.36,1)}
  details[open] .chev{transform:rotate(45deg)}
  .stitle{font-size:.9rem;font-weight:560;transition:color 150ms ease}
  .scount{margin-left:auto;font:.75rem/1 var(--mono);color:var(--sub);font-variant-numeric:tabular-nums}
  .sbody{padding:0 0 .7rem}

  table{border-collapse:collapse;width:100%;font-size:.85rem}
  .kv th{width:1%;white-space:nowrap;text-align:left;padding:.26rem .9rem .26rem .15rem;
    font:.78rem/1.45 var(--mono);color:var(--sub);font-weight:400;vertical-align:top}
  .kv td{padding:.26rem 0;vertical-align:top;word-break:break-word}
  .grid{table-layout:auto}
  .grid thead th{text-align:left;padding:.2rem .7rem .34rem .15rem;font:.68rem/1 var(--mono);
    color:var(--sub);font-weight:400;text-transform:uppercase;letter-spacing:.07em;
    border-bottom:1px solid var(--line);white-space:nowrap}
  .grid td{padding:.3rem .7rem .3rem .15rem;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent)}
  .grid tr:last-child td{border-bottom:0}
  .grid tbody tr:hover td{background:var(--raise)}
  .num{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--mono);font-size:.8rem;padding-right:.15rem}
  .path{font-family:var(--mono);font-size:.78rem;color:var(--sub);word-break:break-all}

  /* State reads as form, not just text, so a failure is visible without reading. */
  .chip{display:inline-block;font:.68rem/1 var(--mono);padding:.16rem .38rem;border-radius:3px;
    background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent)}
  .chip.no{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
  .msg{font-size:.82rem;color:var(--sub);padding:.5rem 0}
  @media (prefers-reduced-motion:reduce){.chev,.stitle{transition:none}}
</style>
<div id="root"><p class="msg" id="msg">Waiting for the host&hellip;</p></div>
<script type="module">
/*__EXT_APPS_BUNDLE__*/
(async () => {
  var msg = document.getElementById("msg");
  var root = document.getElementById("root");
  if (!globalThis.ExtApps) { msg.textContent = "Widget runtime unavailable."; return; }
  var App = globalThis.ExtApps.App;
  var applyHostStyleVariables = globalThis.ExtApps.applyHostStyleVariables;

  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  var isObjArray = function (v) {
    return Array.isArray(v) && v.length > 0 &&
      v.every(function (x) { return x && typeof x === "object" && !Array.isArray(x); });
  };
  var fmt = function (v) {
    if (v === true) return "yes";
    if (v === false) return "no";
    if (v === "" || v === null || v === undefined) return "—";
    if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
    return String(v);
  };
  var titleize = function (k) {
    return k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, function (c) { return c.toUpperCase(); });
  };

  // Curated grouping, with an explicit catch-all. The status payload changes
  // shape as cbrowser gains features, so anything unrecognised still lands in a
  // section rather than being silently dropped -- a status panel that quietly
  // omits a field is worse than an ugly one.
  var GROUPS = [
    { title: "Configuration", keys: ["config"] },
    { title: "Self-healing cache", keys: ["healCache"] },
  ];
  var HEADER_KEYS = ["version", "dataDir", "toolCount"];

  function kvTable(pairs) {
    var t = el("table", "kv"), tb = el("tbody");
    pairs.forEach(function (p) {
      var tr = el("tr");
      tr.appendChild(el("th", null, p[0]));
      var td = el("td");
      if (/(^|\\.)(dataDir|configFile|path)$/i.test(p[0]) || /^\\//.test(String(p[1]))) td.className = "path";
      td.textContent = fmt(p[1]);
      tr.appendChild(td); tb.appendChild(tr);
    });
    t.appendChild(tb); return t;
  }

  function gridTable(rows) {
    var cols = [];
    rows.forEach(function (r) {
      Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); });
    });
    var t = el("table", "grid"), thead = el("thead"), htr = el("tr");
    cols.forEach(function (c) { htr.appendChild(el("th", null, c)); });
    thead.appendChild(htr);
    var tb = el("tbody");
    rows.forEach(function (r) {
      var tr = el("tr");
      cols.forEach(function (c) {
        var v = r[c], td = el("td");
        if (typeof v === "boolean") {
          td.appendChild(el("span", "chip" + (v ? "" : " no"), v ? "yes" : "no"));
        } else if (typeof v === "number") {
          td.className = "num"; td.textContent = String(v);
        } else if (/path/i.test(c) || /^\\//.test(String(v))) {
          td.className = "path"; td.textContent = fmt(v);
        } else {
          td.textContent = fmt(v);
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(thead); t.appendChild(tb); return t;
  }

  function section(title, count, node, open) {
    var d = el("details");
    if (open) d.open = true;
    var sm = el("summary");
    sm.appendChild(el("span", "chev"));
    sm.appendChild(el("span", "stitle", title));
    if (count !== null && count !== undefined) sm.appendChild(el("span", "scount", count));
    d.appendChild(sm);
    var body = el("div", "sbody");
    body.appendChild(node);
    d.appendChild(body);
    return d;
  }

  function addFact(strip, value, label, attn) {
    var f = el("span", "fact" + (attn ? " attn" : ""));
    f.appendChild(el("b", null, value));
    f.appendChild(el("span", null, label));
    strip.appendChild(f);
  }

  function render(data) {
    if (!data) return;
    root.replaceChildren();

    var top = el("div", "top");
    var logo = "${getLogoDataUri()}";
    if (logo) {
      var img = document.createElement("img");
      img.className = "mark";
      img.src = logo;
      img.alt = "";
      top.appendChild(img);
    }
    top.appendChild(el("span", "name", "CBrowser"));
    if (data.version) top.appendChild(el("span", "ver", "v" + data.version));
    root.appendChild(top);
    root.appendChild(el("div", "rule"));

    // Summary strip. Counts are derived, and any that indicate a problem take
    // the attention treatment -- so a broken environment is visible before a
    // single section is expanded.
    var strip = el("div", "facts");
    if (typeof data.toolCount === "number") addFact(strip, String(data.toolCount), "tools");
    if (isObjArray(data.browsers)) {
      var ok = data.browsers.filter(function (b) { return b.installed; }).length;
      addFact(strip, ok + "/" + data.browsers.length, "browsers", ok < data.browsers.length);
    }
    if (isObjArray(data.directories)) {
      var present = data.directories.filter(function (d) { return d.exists; }).length;
      addFact(strip, present + "/" + data.directories.length, "directories", present < data.directories.length);
    }
    if (typeof data.sessions === "number") addFact(strip, String(data.sessions), "sessions");
    if (data.healCache && typeof data.healCache.totalHeals === "number") {
      addFact(strip, String(data.healCache.totalHeals), "self-heals");
    }
    if (strip.childNodes.length) root.appendChild(strip);

    var used = {};
    HEADER_KEYS.forEach(function (k) { used[k] = true; });

    // Curated groups first, in declared order.
    GROUPS.forEach(function (g) {
      var pairs = [];
      g.keys.forEach(function (k) {
        var v = data[k];
        if (v === undefined) return;
        used[k] = true;
        if (v && typeof v === "object" && !Array.isArray(v)) {
          Object.keys(v).forEach(function (sk) { pairs.push([titleize(sk), v[sk]]); });
        } else pairs.push([titleize(k), v]);
      });
      if (pairs.length) root.appendChild(section(g.title, pairs.length, kvTable(pairs), false));
    });

    // Object arrays get real tables, one section each.
    Object.keys(data).forEach(function (k) {
      if (used[k] || !isObjArray(data[k])) return;
      used[k] = true;
      root.appendChild(section(titleize(k), String(data[k].length), gridTable(data[k]), false));
    });

    // Everything left over, so no field is ever silently dropped.
    var rest = [];
    Object.keys(data).forEach(function (k) {
      if (used[k]) return;
      var v = data[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        Object.keys(v).forEach(function (sk) { rest.push([titleize(k) + " › " + titleize(sk), v[sk]]); });
      } else rest.push([titleize(k), v]);
    });
    if (rest.length) root.appendChild(section("Counts and paths", String(rest.length), kvTable(rest), true));

    var dd = el("p", "msg");
    dd.className = "msg";
    dd.appendChild(document.createTextNode("Data directory: "));
    var dp = el("span", "path", data.dataDir || "—");
    dd.appendChild(dp);
    root.appendChild(dd);
  }

  var app = new App({ name: "cbrowser-status", version: "1.0.0" }, {}, { autoResize: true });

  function applyHostContext(ctx) {
    document.documentElement.classList.toggle("dark", ctx && ctx.theme === "dark");
    if (ctx && ctx.styles && ctx.styles.variables && applyHostStyleVariables) {
      applyHostStyleVariables(ctx.styles.variables);
    }
  }

  app.ontoolresult = function (res) {
    try {
      var data = res && res.structuredContent;
      if (!data && res && res.content && res.content[0] && res.content[0].text) {
        data = JSON.parse(res.content[0].text);
      }
      render(data);
    } catch (e) {
      msg.textContent = "Could not read the status payload: " + (e && e.message ? e.message : e);
    }
  };
  app.onhostcontextchanged = applyHostContext;

  try {
    await app.connect();
    applyHostContext(app.getHostContext());
  } catch (e) {
    msg.textContent = "Could not connect to the host: " + (e && e.message ? e.message : e);
  }
})();
</script>`.replace("/*__EXT_APPS_BUNDLE__*/", () => getExtAppsBundle());
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
