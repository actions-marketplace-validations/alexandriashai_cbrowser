/**
 * Barrier overlay HTML.
 *
 * `empathy_audit` reports a barrier as a type, a severity, a WCAG criterion and
 * a rectangle. That is everything needed to draw it, and drawing it is the point
 * — an empathy score stated in prose has to be taken on faith, while the same
 * score with the barriers marked on the page is something a reader can look at
 * and disagree with. Falsifiable by eye.
 *
 * Two decisions worth stating, because both are places this is easy to get
 * wrong:
 *
 * **Percentages, not pixels.** Rects arrive in document CSS pixels against a
 * capture of known width and height. Positioning them in pixels would need the
 * rendered image size, which depends on the host's iframe width and is not
 * knowable here — so any fixed scale factor is wrong at every width but one.
 * Expressing each rect as a percentage of the same capture box makes the image
 * and its rects share one scale *by construction*: the browser rescales both
 * together and there is no factor to compute, or to get wrong. That is what
 * ISC-75 asks for, obtained structurally rather than arithmetically.
 *
 * **Out-of-bounds rects are listed, not drawn.** A `scope: "full_page"` audit
 * scrolls, so a rect can legitimately fall outside the captured image. Clamping
 * it would put a box on innocent content and assert something false about the
 * page; dropping it silently would hide a real barrier. Both are worse than
 * saying where it went.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

/** Severity -> colour. Fixed, because the legend has to mean one thing. */
export const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  major: "#f59e0b",
  moderate: "#eab308",
  minor: "#38bdf8",
};

const DEFAULT_COLOR = "#94a3b8";

export interface OverlayRect {
  type?: string;
  severity?: string;
  element?: string;
  description?: string;
  wcag?: string[];
  rect?: { x: number; y: number; width: number; height: number };
  outsideScreenshot?: boolean;
}

export interface BarrierOverlayInput {
  /** Publicly fetchable URL of the capture. Without it there is nothing to draw on. */
  /**
   * Screenshot to draw the boxes over.
   *
   * A data: URI when the caller can supply one. An https URL renders broken
   * inside the widget sandbox, whose CSP allowlist does not include
   * cbrowser.ai -- verified against the real policy: a control img on that
   * origin was blocked with a logged violation while a data: URI rendered. The
   * boxes are absolutely positioned, so a blocked image leaves them floating
   * over nothing rather than failing visibly.
   */
  imageUrl: string;
  /** Width of the capture in CSS px (viewportSize.width). */
  imageWidth: number;
  /** Height of the capture in CSS px — viewport height, or document height for full_page. */
  captureHeight: number;
  barrierRects: OverlayRect[];
  persona: string;
  pageUrl: string;
  score?: number;
}

/** Escape for HTML text and double-quoted attribute contexts. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A rect's box as percentages of the capture, so it scales with the image. */
export function rectToPercent(
  rect: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  captureHeight: number,
): { left: number; top: number; width: number; height: number } {
  const w = imageWidth > 0 ? imageWidth : 1;
  const h = captureHeight > 0 ? captureHeight : 1;
  return {
    left: (rect.x / w) * 100,
    top: (rect.y / h) * 100,
    width: (rect.width / w) * 100,
    height: (rect.height / h) * 100,
  };
}

/** True when the rect lies wholly or partly within the captured image. */
export function isInBounds(
  rect: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  captureHeight: number,
): boolean {
  return (
    rect.x + rect.width > 0 &&
    rect.y + rect.height > 0 &&
    rect.x < imageWidth &&
    rect.y < captureHeight
  );
}

function colorFor(severity: string | undefined): string {
  return SEVERITY_COLORS[String(severity ?? "").toLowerCase()] ?? DEFAULT_COLOR;
}

/**
 * Build a self-contained overlay document.
 *
 * Returns `null` when there is no image to draw on — a legend floating above
 * nothing is not a report, and emitting one would be the "advertise what wasn't
 * produced" failure the artifact store exists to prevent.
 */
export function buildBarrierOverlayHtml(input: BarrierOverlayInput): string | null {
  const { imageUrl, imageWidth, captureHeight, barrierRects, persona, pageUrl, score } = input;
  if (!imageUrl || !imageWidth || !captureHeight) return null;

  const withRects = (barrierRects ?? []).filter((b) => b.rect);
  const drawn = withRects.filter(
    (b) => !b.outsideScreenshot && isInBounds(b.rect!, imageWidth, captureHeight),
  );
  const offscreen = withRects.filter(
    (b) => b.outsideScreenshot || !isInBounds(b.rect!, imageWidth, captureHeight),
  );

  const boxes = drawn
    .map((b) => {
      const p = rectToPercent(b.rect!, imageWidth, captureHeight);
      const color = colorFor(b.severity);
      const wcag = (b.wcag ?? []).join(", ");
      // The label is the accessible name: colour alone must never be the only
      // carrier of meaning (WCAG 1.4.1), least of all in an accessibility tool.
      const label = `${b.severity ?? "barrier"}: ${b.type ?? "issue"}${wcag ? ` (WCAG ${wcag})` : ""} — ${b.element ?? ""} ${b.description ?? ""}`.trim();
      return (
        `<div class="bx" style="left:${p.left.toFixed(3)}%;top:${p.top.toFixed(3)}%;` +
        `width:${p.width.toFixed(3)}%;height:${p.height.toFixed(3)}%;` +
        `border-color:${color};box-shadow:0 0 0 1px ${color}55" ` +
        `title="${esc(label)}" aria-label="${esc(label)}" role="img"></div>`
      );
    })
    .join("\n");

  const severitiesPresent = Array.from(
    new Set(drawn.map((b) => String(b.severity ?? "").toLowerCase()).filter(Boolean)),
  );
  const legend = severitiesPresent
    .map(
      (sev) =>
        `<li><span class="sw" style="background:${SEVERITY_COLORS[sev] ?? DEFAULT_COLOR}"></span>${esc(sev)} (${drawn.filter((b) => String(b.severity).toLowerCase() === sev).length})</li>`,
    )
    .join("");

  const offscreenList = offscreen.length
    ? `<section class="off"><h2>Outside the capture (${offscreen.length})</h2><p>These barriers are real but fall outside the captured image, so they are listed rather than drawn.</p><ul>${offscreen
        .map(
          (b) =>
            `<li><b>${esc(b.severity ?? "barrier")}</b> ${esc(b.type ?? "")} — ${esc(b.element ?? "")} <span class="at">at y=${esc(Math.round(b.rect!.y))}</span></li>`,
        )
        .join("")}</ul></section>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Barrier overlay — ${esc(persona)}</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;padding:16px;background:#0f172a;color:#e2e8f0;
       font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
  h1{font-size:18px;margin:0 0 4px}
  .meta{color:#94a3b8;font-size:13px;margin-bottom:12px;word-break:break-word}
  .wrap{position:relative;display:block;max-width:100%;margin:0 auto;
        border:1px solid #1e293b;border-radius:8px;overflow:hidden;background:#1e293b}
  .wrap img{display:block;width:100%;height:auto}
  .bx{position:absolute;border:2px solid;border-radius:2px;pointer-events:auto}
  ul.lg{list-style:none;display:flex;flex-wrap:wrap;gap:12px;padding:0;margin:12px 0 0;font-size:13px}
  ul.lg li{display:flex;align-items:center;gap:6px}
  .sw{width:12px;height:12px;border-radius:2px;display:inline-block}
  .off{margin-top:16px;padding:12px;background:#1e293b;border-radius:8px}
  .off h2{font-size:14px;margin:0 0 6px}
  .off p{color:#94a3b8;font-size:12px;margin:0 0 8px}
  .off ul{margin:0;padding-left:18px}
  .at{color:#94a3b8}
  .none{color:#94a3b8;font-style:italic;margin-top:12px}
</style></head>
<body>
<h1>Accessibility barriers — ${esc(persona)}</h1>
<div class="meta">${esc(pageUrl)}${score !== undefined ? ` · empathy score ${esc(score)}` : ""} · ${drawn.length} drawn${offscreen.length ? `, ${offscreen.length} outside capture` : ""}</div>
<div class="wrap">
  <img src="${esc(imageUrl)}" alt="Screenshot of ${esc(pageUrl)} with detected accessibility barriers outlined">
${boxes}
</div>
${severitiesPresent.length ? `<ul class="lg">${legend}</ul>` : `<p class="none">No barriers fell within the captured image.</p>`}
${offscreenList}
</body></html>`;
}
