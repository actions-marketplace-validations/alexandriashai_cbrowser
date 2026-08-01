/**
 * Self-contained HTML player for a capture.
 *
 * A recording produces a GIF, a per-keyframe attention judgement, and a closing
 * narrative. None of that survives an MCP response: video cannot cross the
 * boundary, and a wall of JSON is not something a person reads. This builds one
 * HTML file that carries all of it, gets written to the served artifact
 * directory, and comes back as a URL — so a chat client, a teammate, or a
 * bookmark all resolve to the same thing.
 *
 * SELF-CONTAINED BY CONSTRUCTION. Everything inlines: no CDN, no stylesheet, no
 * script tag pointing anywhere. The artifact directory is served as static files
 * with no build step, and a player that needs a network fetch to render is a
 * player that breaks the first time something upstream moves.
 *
 * The media itself is referenced by URL rather than inlined — a base64 WebM in
 * an HTML file is a multi-megabyte document that no browser enjoys, and both
 * live in the same served directory anyway.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import type { JudgedMoment } from "../visual/llm-relevance.js";

export interface CapturePlayerData {
  slug: string;
  targetUrl?: string;
  personaName?: string;
  goal?: string;
  durationMs: number;
  frames: number;
  actualFps: number;
  /** Public URLs by format, as returned by capture_stop. */
  artifactUrls: Record<string, string>;
  contactSheetUrl?: string;
  /**
   * Real interactions, in capture time. Rendered as a seekable track under the
   * media so a viewer can jump to the moment a click happened rather than
   * scrubbing for it.
   */
  interactions?: Array<{ atMs: number; type: string; x: number; y: number; label: string }>;
  moments?: JudgedMoment[];
  summary?: string;
  /**
   * What the overlay painted, when one was applied.
   *
   * Rendered verbatim in the header. The two values carry different evidential
   * weight and the page must not let a reader assume the stronger one.
   */
  overlay?: {
    quantity: "predicted-attention" | "visual-contrast-only";
    usedDom: boolean;
    domElements: number;
  };
}

/** Escape for text nodes and quoted attributes. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTime(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/**
 * Build the player document.
 *
 * Returns a complete HTML string; the caller writes it wherever it is served
 * from. Pure, so it is testable without a filesystem or a network.
 */
export function buildCapturePlayer(data: CapturePlayerData): string {
  const video = data.artifactUrls.webm ?? data.artifactUrls.mp4;
  const image = data.artifactUrls.gif ?? data.artifactUrls.webp;
  const poster = data.contactSheetUrl;

  // Speed control only exists for video. A GIF's frame delays are baked into the
  // file and no browser API changes them, so offering a slider that silently did
  // nothing would be worse than saying which artifact supports it.
  const speedBar = video
    ? `<div class="speed" role="group" aria-label="Playback speed">
        <span class="lbl">Speed</span>
        ${[0.25, 0.5, 1, 2].map((r) => `<button type="button" data-rate="${r}"${r === 1 ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${r}&times;</button>`).join("")}
        <button type="button" data-step="-1" title="Previous frame">&#9666;</button>
        <button type="button" data-step="1" title="Next frame">&#9656;</button>
       </div>`
    : image
      ? `<p class="speednote">Speed control needs the video artifact &mdash; capture with <code>format: "gif,webm"</code> to get it.</p>`
      : "";

  const media = video
    ? `<video id="rec" controls loop muted playsinline${poster ? ` poster="${esc(poster)}"` : ""} src="${esc(video)}"></video>`
    : image
      ? `<img src="${esc(image)}" alt="Recording of ${esc(data.targetUrl ?? data.slug)}">`
      : `<p class="empty">No playable artifact was produced for this capture.</p>`;

  const acts = (data.interactions ?? []).slice().sort((a, b) => a.atMs - b.atMs);
  const dur = Math.max(1, data.durationMs);
  // Markers are positioned by fraction of capture duration, so the track lines up
  // with the media above it regardless of artifact format. Only the video can be
  // seeked -- for a GIF the markers still read as a record of what happened, they
  // just do not drive playback, and the note says so rather than silently no-op.
  const actTrack = acts.length === 0
    ? ""
    : `
    <section class="acts">
      <h2>Interactions</h2>
      <p class="lede">${acts.length} recorded ${acts.length === 1 ? "event" : "events"}${video ? " &mdash; select one to jump there." : " &mdash; seeking needs the video artifact."}</p>
      <div class="track" role="list">
        ${acts.map((a) => `<button type="button" role="listitem" class="mark" data-at="${a.atMs}" style="--x:${((a.atMs / dur) * 100).toFixed(2)}%" title="${esc(a.type)} &middot; ${esc(a.label.slice(0, 60))}"><span class="dot" data-type="${esc(a.type)}"></span></button>`).join("")}
      </div>
      <ol class="actlist">
        ${acts.map((a) => `<li><button type="button" data-at="${a.atMs}"><span class="t">${esc(fmtTime(a.atMs))}</span><span class="kind" data-type="${esc(a.type)}">${esc(a.type)}</span><span class="lab">${esc(a.label.slice(0, 90) || "(no label)")}</span></button></li>`).join("")}
      </ol>
    </section>`;

  const moments = data.moments ?? [];
  const timeline = moments.length === 0
    ? ""
    : `
    <section>
      <h2>Attention timeline</h2>
      <p class="lede">Judged at each point the interface changed enough to re-evaluate, not on every frame.</p>
      <ol class="moments">
        ${moments.map((m) => `
        <li>
          <div class="t">${esc(fmtTime(m.tMs))}<span class="frame">frame ${m.frameIndex}</span></div>
          <div class="body">
            ${m.topElements.length > 0 ? `<ul class="els">${m.topElements.map((e) => `
              <li><span class="bar" style="--w:${Math.round(e.score * 100)}%"></span><span class="score">${e.score.toFixed(2)}</span><span class="txt">${esc(e.text.slice(0, 80))}</span><span class="type">${esc(e.type)}</span></li>`).join("")}</ul>` : `<p class="empty">Nothing scored at this moment.</p>`}
            ${m.reasoning ? `<p class="why">${esc(m.reasoning)}</p>` : ""}
          </div>
        </li>`).join("")}
      </ol>
    </section>`;

  const summary = data.summary
    ? `<section class="summary"><h2>How this went</h2><p>${esc(data.summary)}</p></section>`
    : "";

  const quantityNote = data.overlay
    ? data.overlay.quantity === "predicted-attention"
      ? `<span class="pill ok">predicted attention &middot; ${data.overlay.domElements} elements</span>`
      : `<span class="pill warn">visual contrast only &middot; no DOM</span>`
    : "";

  const downloads = Object.entries(data.artifactUrls)
    .map(([fmt, url]) => `<a href="${esc(url)}" download>${esc(fmt)}</a>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(data.targetUrl ?? data.slug)} — capture</title>
<style>
:root{
  --ink:#12151c; --paper:#f5f6f8; --card:#fff; --rule:#dfe3ea; --muted:#5f6874;
  --accent:#2f4374; --hot:#b3252b; --ok:#2f6b4f; --warn:#8a6314;
  --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;
}
@media(prefers-color-scheme:dark){:root{
  --ink:#e6e9ef; --paper:#13161d; --card:#1a1e27; --rule:#2c333f; --muted:#98a2b2;
  --accent:#95a9d8; --hot:#e4838a; --ok:#86c4a2; --warn:#d9b25f;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
  font:16px/1.6 "Charter","Iowan Old Style",Palatino,Georgia,serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:78ch;margin:0 auto;padding:clamp(1.5rem,4vw,3rem) clamp(1rem,4vw,2rem) 5rem;
  display:flex;flex-direction:column;gap:2rem}
header{display:flex;flex-direction:column;gap:.6rem}
.eyebrow{font-family:var(--mono);font-size:.7rem;letter-spacing:.13em;text-transform:uppercase;color:var(--accent)}
h1{margin:0;font-size:clamp(1.4rem,3.5vw,2rem);line-height:1.2;text-wrap:balance;word-break:break-word}
h2{font-size:1.2rem;margin:0 0 .5rem;padding-bottom:.35rem;border-bottom:1px solid var(--rule)}
.meta{display:flex;flex-wrap:wrap;gap:.4rem .9rem;font-family:var(--mono);font-size:.74rem;color:var(--muted)}
.pill{font-family:var(--mono);font-size:.66rem;letter-spacing:.05em;text-transform:uppercase;
  padding:.18rem .5rem;border-radius:100px;white-space:nowrap}
.pill.ok{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.pill.warn{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
figure{margin:0;background:var(--card);border:1px solid var(--rule);border-radius:6px;overflow:hidden}
video,img{display:block;width:100%;height:auto;background:#000}
.lede{color:var(--muted);margin:.2rem 0 1rem;font-size:.95rem}
.speed{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;margin-top:-1.4rem}
.speed .lbl{font-family:var(--mono);font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-right:.2rem}
.speed button{font-family:var(--mono);font-size:.76rem;padding:.28rem .6rem;border:1px solid var(--rule);
  border-radius:3px;background:var(--card);color:var(--ink);cursor:pointer}
.speed button:hover{border-color:var(--accent)}
.speed button[aria-pressed="true"]{background:var(--accent);color:var(--card);border-color:var(--accent)}
.speed button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.speednote{font-size:.85rem;color:var(--muted);margin-top:-1.4rem}
.acts .lede{margin-bottom:.5rem}
.acts .track{position:relative;height:26px;margin:.2rem 0 .9rem;border-radius:4px;
  background:linear-gradient(90deg,color-mix(in srgb,var(--rule) 55%,transparent),color-mix(in srgb,var(--rule) 20%,transparent));
  border:1px solid var(--rule)}
.acts .mark{position:absolute;left:var(--x);top:0;height:100%;width:18px;transform:translateX(-9px);
  background:none;border:0;padding:0;cursor:pointer;display:grid;place-items:center}
.acts .mark .dot{width:11px;height:11px;border-radius:50%;background:var(--accent);
  border:2px solid var(--card);box-shadow:0 0 0 1px var(--accent)}
.acts .mark .dot[data-type="submit"]{background:#d1495b;box-shadow:0 0 0 1px #d1495b}
.acts .mark .dot[data-type="input"]{background:#e0a458;box-shadow:0 0 0 1px #e0a458}
.acts .mark:hover .dot{transform:scale(1.35)}
.acts .mark:focus-visible{outline:2px solid var(--accent);outline-offset:1px;border-radius:3px}
.actlist{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.15rem}
.actlist button{display:flex;gap:.6rem;align-items:baseline;width:100%;text-align:left;
  background:none;border:0;border-radius:4px;padding:.3rem .45rem;cursor:pointer;color:inherit;font:inherit}
.actlist button:hover{background:color-mix(in srgb,var(--accent) 9%,transparent)}
.actlist button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.actlist .t{font-family:var(--mono);font-size:.74rem;color:var(--muted);flex:0 0 3.6rem;font-variant-numeric:tabular-nums}
.actlist .kind{font-family:var(--mono);font-size:.66rem;text-transform:uppercase;letter-spacing:.08em;
  padding:.08rem .34rem;border-radius:3px;background:color-mix(in srgb,var(--accent) 16%,transparent);flex:0 0 auto}
.actlist .kind[data-type="submit"]{background:color-mix(in srgb,#d1495b 18%,transparent)}
.actlist .kind[data-type="input"]{background:color-mix(in srgb,#e0a458 22%,transparent)}
.actlist .lab{font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (prefers-reduced-motion:reduce){.acts .mark:hover .dot{transform:none}}
.moments{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.9rem}
.moments>li{display:grid;grid-template-columns:5.5rem 1fr;gap:0 1rem;background:var(--card);
  border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:4px;padding:.9rem 1rem}
.t{font-family:var(--mono);font-size:.9rem;font-weight:600;font-variant-numeric:tabular-nums;
  display:flex;flex-direction:column;gap:.15rem}
.frame{font-weight:400;font-size:.66rem;color:var(--muted)}
.els{list-style:none;margin:0 0 .5rem;padding:0;display:flex;flex-direction:column;gap:.3rem}
.els li{display:grid;grid-template-columns:7rem 2.6rem 1fr auto;align-items:center;gap:.5rem;font-size:.86rem}
/* Track + fill, so a 0.44 reads as visibly under half rather than as a short
   bar the eye has nothing to compare against. */
.els li>span:first-child{position:relative;height:.5rem;border-radius:2px;
  background:color-mix(in srgb,var(--rule) 70%,transparent)}
.bar::after{content:"";position:absolute;inset:0 auto 0 0;width:var(--w);
  border-radius:2px;background:linear-gradient(90deg,var(--accent),var(--hot))}
.score{font-family:var(--mono);font-size:.76rem;font-variant-numeric:tabular-nums;color:var(--muted)}
.txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.type{font-family:var(--mono);font-size:.64rem;text-transform:uppercase;color:var(--muted)}
.why{margin:.4rem 0 0;font-size:.92rem;color:var(--ink)}
.summary{background:var(--card);border:1px solid var(--rule);border-left:3px solid var(--ok);
  border-radius:4px;padding:1.1rem 1.3rem}
.summary p{margin:0}
.empty{color:var(--muted);font-style:italic;margin:0}
.dl{display:flex;gap:.5rem;flex-wrap:wrap}
.dl a{font-family:var(--mono);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;
  padding:.3rem .7rem;border:1px solid var(--rule);border-radius:3px;color:var(--accent);text-decoration:none}
.dl a:hover,.dl a:focus-visible{border-color:var(--accent)}
footer{border-top:1px solid var(--rule);padding-top:1rem;font-size:.8rem;color:var(--muted)}
a:focus-visible,video:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media(max-width:600px){.moments>li{grid-template-columns:1fr;gap:.5rem}
  .els li{grid-template-columns:5rem 2.4rem 1fr;}.type{display:none}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">cbrowser capture</div>
    <h1>${esc(data.targetUrl ?? data.slug)}</h1>
    <div class="meta">
      <span>${esc(fmtTime(data.durationMs))}</span>
      <span>${data.frames} frames</span>
      <span>${data.actualFps.toFixed(1)} fps</span>
      ${data.personaName ? `<span>persona: ${esc(data.personaName)}</span>` : ""}
      ${data.goal ? `<span>goal: ${esc(data.goal)}</span>` : ""}
      ${quantityNote}
    </div>
  </header>

  <figure>${media}</figure>
  ${speedBar}
  ${actTrack}

  ${summary}
  ${timeline}

  ${downloads ? `<section><h2>Files</h2><div class="dl">${downloads}</div></section>` : ""}

  <footer>
    ${data.overlay
      ? data.overlay.quantity === "predicted-attention"
        ? "Overlay shows the model&rsquo;s predicted attention, blending visual contrast with DOM semantics. It has not been validated against human eye movements."
        : "Overlay shows visual contrast only &mdash; no DOM was available, so the semantic half of the model did not run."
      : "No attention overlay was applied to this capture."}
  </footer>
</div>
<script>
// Interaction seeking lives in its own IIFE: the player script below returns
// early when there is no <video>, and the markers must still render and respond
// on a GIF-only capture even though nothing can be seeked.
(function () {
  var v = document.getElementById("rec");
  document.querySelectorAll("[data-at]").forEach(function (b) {
    b.addEventListener("click", function () {
      var t = parseInt(b.getAttribute("data-at"), 10) / 1000;
      if (v && isFinite(t)) { v.currentTime = t; v.pause(); }
      document.querySelectorAll("[data-at]").forEach(function (o) {
        o.setAttribute("aria-current", o === b ? "true" : "false");
      });
    });
  });
})();
(function () {
  var v = document.getElementById("rec");
  if (!v) return;
  var bar = document.querySelector(".speed");
  if (!bar) return;

  // Frame step uses the capture's real rate, not a guessed 30fps — stepping by
  // the wrong interval lands between frames and looks like nothing happened.
  var FRAME = ${data.actualFps > 0 ? (1 / data.actualFps).toFixed(4) : "0.25"};

  bar.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.rate) {
      v.playbackRate = parseFloat(b.dataset.rate);
      bar.querySelectorAll("[data-rate]").forEach(function (o) {
        o.setAttribute("aria-pressed", String(o === b));
      });
      return;
    }
    if (b.dataset.step) {
      v.pause();
      v.currentTime = Math.max(0, v.currentTime + parseInt(b.dataset.step, 10) * FRAME);
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (e.key === "," || e.key === ".") {
      e.preventDefault();
      v.pause();
      v.currentTime = Math.max(0, v.currentTime + (e.key === "." ? FRAME : -FRAME));
    }
  });
})();
</script>
</body>
</html>`;
}
