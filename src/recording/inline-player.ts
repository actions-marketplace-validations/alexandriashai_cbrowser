/**
 * Self-contained capture player for MCP Apps inline rendering.
 *
 * Differs from capture-player.ts in one way that drives every other decision:
 * that page is served over HTTP from cbrowser.ai and can reference its own
 * artifacts by URL. This one runs inside the host's widget sandbox, whose CSP
 * allowlists a fixed set of origins that does not include cbrowser.ai. So it
 * can fetch nothing. Every pixel it shows has to be embedded.
 *
 * data: is permitted in img-src (confirmed against the live sandbox), which is
 * what makes this possible at all -- and it is also the binding constraint,
 * because a capture GIF measured between 500KB and 1.4MB and base64 adds a
 * third on top. So frames are selected rather than included, and re-encoded to
 * fit a byte budget rather than shipped at capture resolution.
 *
 * The full-resolution artifacts stay reachable as links. A link is a navigation,
 * not a subresource fetch, so the allowlist does not apply to it.
 */
import sharp from "sharp";
import { existsSync } from "node:fs";

/** Total base64 budget for embedded frames. */
const INLINE_BUDGET_B64 = 700_000;
/** Never embed more than this many frames regardless of budget. */
const MAX_FRAMES = 10;
/** Widest an embedded frame is rendered; capture width is far more than needed. */
const FRAME_WIDTH = 720;

export interface InlinePlayerData {
  slug: string;
  targetUrl?: string;
  personaName?: string;
  goal?: string;
  durationMs: number;
  actualFps: number;
  /** Absolute paths to frame images, in capture order. */
  framePaths: string[];
  /** Capture-relative time of each frame, parallel to framePaths. */
  frameTimesMs: number[];
  interactions?: Array<{ atMs: number; type: string; x: number; y: number; label: string }>;
  moments?: Array<{ frameIndex: number; tMs: number; reasoning?: string;
    topElements: Array<{ text: string; score: number; type: string }> }>;
  summary?: string;
  /** Public URLs to the full artifacts, offered as links rather than embeds. */
  artifactUrls?: Record<string, string>;
  playerUrl?: string;
  overlay?: { quantity: "predicted-attention" | "visual-contrast-only"; domElements: number };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const fmtTime = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * Choose which frames to embed.
 *
 * Judged moments and interactions are the frames that carry information -- a
 * frame is a moment precisely because the interface changed enough to re-judge,
 * and a frame is an interaction because something happened on it. Sampling
 * evenly would spend the budget on the still stretches between them. Evenly
 * spaced frames only fill whatever room is left.
 */
function selectFrames(data: InlinePlayerData): number[] {
  const n = data.framePaths.length;
  if (n === 0) return [];
  const picked = new Set<number>([0]);

  for (const m of data.moments ?? []) {
    if (m.frameIndex >= 0 && m.frameIndex < n) picked.add(m.frameIndex);
  }
  for (const it of data.interactions ?? []) {
    // The frame that shows the click is the first one at or after it.
    const idx = data.frameTimesMs.findIndex((t) => t >= it.atMs);
    if (idx >= 0) picked.add(idx);
  }
  picked.add(n - 1);

  const chosen = [...picked].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  if (chosen.length >= MAX_FRAMES) return chosen.slice(0, MAX_FRAMES);

  // Fill remaining slots with an even spread, skipping anything already picked.
  const want = MAX_FRAMES - chosen.length;
  for (let k = 1; k <= want && chosen.length < MAX_FRAMES; k++) {
    const idx = Math.round((k / (want + 1)) * (n - 1));
    if (!picked.has(idx)) { picked.add(idx); chosen.push(idx); }
  }
  return [...picked].sort((a, b) => a - b);
}

/**
 * Encode one frame to a data URI under a byte ceiling.
 *
 * Steps quality down rather than dimensions: the frames carry an attention
 * overlay whose whole content is where colour sits on the page, and shrinking
 * the raster blurs that away faster than JPEG artefacts do.
 */
async function encodeFrame(path: string, ceilingB64: number): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  for (const quality of [72, 58, 46, 36, 28, 20]) {
    try {
      const buf = await sharp(path).resize({ width: FRAME_WIDTH, withoutEnlargement: true })
        .jpeg({ quality }).toBuffer();
      if (Math.ceil(buf.length * 4 / 3) <= ceilingB64) {
        return `data:image/jpeg;base64,${buf.toString("base64")}`;
      }
    } catch { return undefined; }
  }
  return undefined;
}

export async function buildInlineCapturePlayer(data: InlinePlayerData): Promise<string> {
  const idxs = selectFrames(data);
  const perFrame = idxs.length > 0 ? Math.floor(INLINE_BUDGET_B64 / idxs.length) : 0;

  const frames: Array<{ idx: number; tMs: number; uri: string }> = [];
  for (const i of idxs) {
    const p = data.framePaths[i];
    if (!p) continue;
    const uri = await encodeFrame(p, perFrame);
    if (uri) frames.push({ idx: i, tMs: data.frameTimesMs[i] ?? 0, uri });
  }

  const acts = (data.interactions ?? []).slice().sort((a, b) => a.atMs - b.atMs);
  const dur = Math.max(1, data.durationMs);
  const momentBy = new Map((data.moments ?? []).map((m) => [m.frameIndex, m]));

  const embeddedBytes = frames.reduce((n, f) => n + f.uri.length, 0);

  const head = `
  <header>
    <p class="eyebrow">CBrowser capture</p>
    <h1>${esc(data.targetUrl ?? data.slug)}</h1>
    <p class="meta">${fmtTime(data.durationMs)} &middot; ${data.framePaths.length} frames &middot;
      ${data.actualFps.toFixed(1)} fps${data.personaName ? ` &middot; persona: ${esc(data.personaName)}` : ""}${data.goal ? ` &middot; goal: ${esc(data.goal)}` : ""}</p>
    ${data.overlay ? `<p class="pill ${data.overlay.quantity === "predicted-attention" ? "ok" : "warn"}">${
      data.overlay.quantity === "predicted-attention"
        ? `predicted attention &middot; ${data.overlay.domElements} elements`
        : "visual contrast only &middot; no DOM"}</p>` : ""}
  </header>`;

  const viewer = frames.length === 0
    ? `<p class="empty">No frames could be embedded for this capture.</p>`
    : `
  <div class="viewer">
    ${frames.map((f, i) => `<img class="fr${i === 0 ? " on" : ""}" data-i="${i}" src="${f.uri}" alt="Frame ${f.idx} at ${fmtTime(f.tMs)}">`).join("")}
  </div>
  <div class="controls">
    <button type="button" id="prev" aria-label="Previous frame">&#9666;</button>
    <button type="button" id="play" aria-label="Play">&#9654;</button>
    <button type="button" id="next" aria-label="Next frame">&#9656;</button>
    <input type="range" id="scrub" min="0" max="${frames.length - 1}" value="0" step="1" aria-label="Frame">
    <span class="tc" id="tc">${fmtTime(frames[0]?.tMs ?? 0)}</span>
  </div>
  <p class="note">${frames.length} of ${data.framePaths.length} frames embedded, chosen at judged moments and interactions.
    ${(embeddedBytes / 1024).toFixed(0)}&thinsp;KB inline.</p>`;

  const track = acts.length === 0 ? "" : `
  <section>
    <h2>Interactions</h2>
    <div class="track">
      ${acts.map((a) => `<button type="button" class="mark" data-at="${a.atMs}" style="--x:${((a.atMs / dur) * 100).toFixed(2)}%" title="${esc(a.type)}: ${esc(a.label.slice(0, 60))}"><span class="dot" data-type="${esc(a.type)}"></span></button>`).join("")}
    </div>
    <ol class="actlist">
      ${acts.map((a) => `<li><button type="button" data-at="${a.atMs}"><span class="t">${fmtTime(a.atMs)}</span><span class="kind" data-type="${esc(a.type)}">${esc(a.type)}</span><span class="lab">${esc(a.label.slice(0, 80) || "(no label)")}</span></button></li>`).join("")}
    </ol>
  </section>`;

  const timeline = (data.moments ?? []).length === 0 ? "" : `
  <section>
    <h2>Attention timeline</h2>
    <ol class="moments">
      ${(data.moments ?? []).map((m) => `
      <li>
        <div class="t">${fmtTime(m.tMs)}<span class="frame">frame ${m.frameIndex}</span></div>
        <div class="body">
          ${m.topElements.length > 0 ? `<ul class="els">${m.topElements.slice(0, 5).map((e) => `
            <li><span class="bar" style="--w:${Math.round(e.score * 100)}%"></span><span class="score">${e.score.toFixed(2)}</span><span class="txt">${esc(e.text.slice(0, 70))}</span></li>`).join("")}</ul>` : ""}
          ${m.reasoning ? `<p class="why">${esc(m.reasoning)}</p>` : ""}
        </div>
      </li>`).join("")}
    </ol>
  </section>`;

  const summary = data.summary ? `<section class="summary"><h2>How this went</h2><p>${esc(data.summary)}</p></section>` : "";

  // Links, not embeds. A link is a navigation and the origin allowlist does not
  // govern it, so full-resolution artifacts stay one click away even though the
  // sandbox will not fetch them into this frame.
  const links = [
    ...(data.playerUrl ? [[`full player`, data.playerUrl]] : []),
    ...Object.entries(data.artifactUrls ?? {}),
  ] as Array<[string, string]>;
  const dl = links.length === 0 ? "" : `
  <section><h2>Full artifacts</h2><p class="lede">Open outside this panel &mdash; the sandbox will not load them inline.</p>
  <div class="dl">${links.map(([k, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(k)}</a>`).join("")}</div></section>`;

  const frameTimes = JSON.stringify(frames.map((f) => f.tMs));

  return `<!doctype html><meta charset="utf-8">
<style>
  :root{color-scheme:light dark;--ink:#14161a;--ground:#fff;--muted:#666;--rule:#d9dce1;--accent:#2f6f4f;--card:#fff}
  @media (prefers-color-scheme:dark){:root{--ink:#e8eaed;--ground:#16181c;--muted:#9aa0a8;--rule:#31353b;--accent:#6fbf8f;--card:#1d2025}}
  *{box-sizing:border-box}
  body{margin:0;padding:16px;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--ground)}
  .eyebrow{font:600 .68rem/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 .45rem}
  h1{font-size:1.12rem;margin:0 0 .35rem;word-break:break-all;text-wrap:balance}
  h2{font-size:.95rem;margin:1.4rem 0 .5rem}
  .meta{font:.78rem/1.4 ui-monospace,monospace;color:var(--muted);margin:0 0 .5rem}
  .pill{display:inline-block;font:.68rem/1 ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;padding:.3rem .5rem;border-radius:4px;margin:0}
  .pill.ok{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent)}
  .pill.warn{background:color-mix(in srgb,#c98a2b 20%,transparent)}
  .viewer{position:relative;margin:.9rem 0 .5rem;border:1px solid var(--rule);border-radius:8px;overflow:hidden;background:var(--card)}
  .viewer img{display:none;width:100%;height:auto}
  .viewer img.on{display:block}
  .controls{display:flex;align-items:center;gap:.5rem}
  .controls button{font-size:.9rem;padding:.25rem .55rem;border:1px solid var(--rule);border-radius:5px;background:var(--card);color:inherit;cursor:pointer}
  .controls button:hover{border-color:var(--accent)}
  .controls button:focus-visible,.mark:focus-visible,.actlist button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  #scrub{flex:1;accent-color:var(--accent);min-width:60px}
  .tc{font:.75rem/1 ui-monospace,monospace;color:var(--muted);font-variant-numeric:tabular-nums;flex:0 0 auto}
  .note,.lede{font-size:.78rem;color:var(--muted);margin:.4rem 0 0}
  .track{position:relative;height:24px;margin:.3rem 0 .7rem;border:1px solid var(--rule);border-radius:4px;background:color-mix(in srgb,var(--rule) 30%,transparent)}
  .mark{position:absolute;left:var(--x);top:0;height:100%;width:18px;transform:translateX(-9px);background:none;border:0;padding:0;cursor:pointer;display:grid;place-items:center}
  .mark .dot{width:10px;height:10px;border-radius:50%;background:var(--accent);border:2px solid var(--card);box-shadow:0 0 0 1px var(--accent)}
  .mark .dot[data-type="submit"]{background:#d1495b;box-shadow:0 0 0 1px #d1495b}
  .mark .dot[data-type="input"]{background:#e0a458;box-shadow:0 0 0 1px #e0a458}
  .actlist,.moments{list-style:none;padding:0;margin:0}
  .actlist button{display:flex;gap:.55rem;align-items:baseline;width:100%;text-align:left;background:none;border:0;border-radius:4px;padding:.28rem .4rem;cursor:pointer;color:inherit;font:inherit}
  .actlist button:hover{background:color-mix(in srgb,var(--accent) 10%,transparent)}
  .actlist .t,.moments .t{font:.73rem/1 ui-monospace,monospace;color:var(--muted);flex:0 0 3.2rem;font-variant-numeric:tabular-nums}
  .kind{font:.63rem/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.07em;padding:.1rem .32rem;border-radius:3px;background:color-mix(in srgb,var(--accent) 16%,transparent)}
  .kind[data-type="submit"]{background:color-mix(in srgb,#d1495b 18%,transparent)}
  .kind[data-type="input"]{background:color-mix(in srgb,#e0a458 22%,transparent)}
  .lab,.txt{font-size:.84rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .moments li{display:flex;gap:.7rem;padding:.5rem 0;border-top:1px solid var(--rule)}
  .moments .frame{display:block;font-size:.63rem;opacity:.7}
  .els{list-style:none;padding:0;margin:0 0 .35rem}
  .els li{display:grid;grid-template-columns:3ch 1fr;gap:.4rem;align-items:center;position:relative;padding:.12rem 0}
  .bar{position:absolute;left:0;top:0;bottom:0;width:var(--w);background:color-mix(in srgb,var(--accent) 15%,transparent);border-radius:3px;z-index:0}
  .score,.txt{position:relative;z-index:1}
  .score{font:.7rem/1 ui-monospace,monospace;color:var(--muted);font-variant-numeric:tabular-nums}
  .why{font-size:.84rem;margin:.3rem 0 0;color:var(--muted)}
  .summary{border-left:3px solid var(--accent);padding:.1rem 0 .1rem .8rem;margin-top:1.4rem}
  .dl{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.4rem}
  .dl a{font:.78rem/1 ui-monospace,monospace;padding:.34rem .6rem;border:1px solid var(--rule);border-radius:5px;text-decoration:none;color:var(--accent)}
  .dl a:hover{border-color:var(--accent)}
  .empty{color:var(--muted);font-size:.88rem}
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
${head}
${viewer}
${track}
${summary}
${timeline}
${dl}
<script>
(function(){
  var imgs = Array.prototype.slice.call(document.querySelectorAll(".viewer .fr"));
  if (!imgs.length) return;
  var times = ${frameTimes};
  var scrub = document.getElementById("scrub");
  var tc = document.getElementById("tc");
  var playBtn = document.getElementById("play");
  var cur = 0, timer = null;

  function show(i){
    cur = Math.max(0, Math.min(imgs.length - 1, i));
    imgs.forEach(function(im, k){ im.classList.toggle("on", k === cur); });
    scrub.value = String(cur);
    tc.textContent = ((times[cur] || 0) / 1000).toFixed(1) + "s";
  }
  function stop(){ if (timer) { clearInterval(timer); timer = null; playBtn.innerHTML = "&#9654;"; } }
  function play(){
    if (timer) return stop();
    playBtn.innerHTML = "&#10073;&#10073;";
    timer = setInterval(function(){
      if (cur >= imgs.length - 1) { show(0); } else { show(cur + 1); }
    }, 700);
  }
  document.getElementById("prev").addEventListener("click", function(){ stop(); show(cur - 1); });
  document.getElementById("next").addEventListener("click", function(){ stop(); show(cur + 1); });
  playBtn.addEventListener("click", play);
  scrub.addEventListener("input", function(){ stop(); show(parseInt(scrub.value, 10)); });

  // Interaction markers seek to the embedded frame nearest that moment. Only a
  // subset of frames is embedded, so this lands on the closest one rather than
  // pretending every timestamp has a frame behind it.
  document.querySelectorAll("[data-at]").forEach(function(b){
    b.addEventListener("click", function(){
      var at = parseInt(b.getAttribute("data-at"), 10);
      var best = 0, bestD = Infinity;
      times.forEach(function(t, k){ var d = Math.abs(t - at); if (d < bestD) { bestD = d; best = k; } });
      stop(); show(best);
    });
  });
  show(0);
})();
</script>`;
}
