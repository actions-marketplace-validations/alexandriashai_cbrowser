/**
 * Reconstruct a `DOMAttentionElement[]` from a screenshot, using NO model.
 *
 * ## Why this exists
 *
 * `analyzeAttention` blends two channels: 35% Lab saliency (pixels) and 65%
 * semantic (`buildSemanticMap` over DOM elements). Study 1 runs on UEyes, which
 * ships screenshots, so the 65% has never executed in ANY version of that study
 * -- published, retracted, or re-run. Every saliency number this project has
 * ever reported describes the minority channel.
 *
 * ## Why an OCR extractor and not a VLM
 *
 * The obvious move is to ask a vision model "what elements are on this page".
 * That destroys the experiment. A VLM predicting where people look scores ~0.70
 * AUC on this same corpus (measured, 2026-08-04) -- better than the shipped
 * saliency model. If the VLM supplies the elements and cbrowser then weights
 * them, the result measures VLM-detection and cbrowser-weighting jointly and
 * cannot separate them. You would be benchmarking the extractor.
 *
 * So this extractor is deliberately dumb. It knows about pixels and glyph
 * geometry and nothing else. It never reads meaning out of the text.
 *
 * ## The division of labour, precisely
 *
 * `buildSemanticMap` (attention-transport.ts:625) only READS the semantic flags:
 *
 *     if (el.isCTA) elType = "cta";
 *     else if (el.isHeading) elType = "heading";  ... etc
 *
 * It never derives them. In production they come from the real DOM -- tag names,
 * ARIA roles, computed styles. Something must stand in for that here, and the
 * weights it feeds span 10x (cta 1.0 down to decorative 0.1), so the stand-in is
 * load-bearing.
 *
 * The line drawn here: this file reconstructs STRUCTURE (what kind of thing is
 * this, by how it is drawn), cbrowser supplies IMPORTANCE (how much does this
 * persona attend to that kind of thing). Structure is recoverable from pixels
 * precisely because CSS exists to make it visible -- a heading IS bigger, a
 * button IS a filled contrasting rect, a nav IS a row of short peers. Importance
 * is the model under test and this file must not touch it.
 *
 * ## What this cannot do, stated up front
 *
 * There is no element ground truth for UEyes, so extractor accuracy is not
 * measurable here -- a misclassification will be scored as cbrowser error. That
 * is what the paired `flat` control arm in run-semantic.ts is for: identical
 * elements, type labels stripped. The delta between typed and flat is
 * attributable to the weighting alone, because the extractor is held constant
 * across both.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { spawnSync } from "node:child_process";
import sharp from "sharp";
import type { DOMAttentionElement } from "../../src/visual/attention-transport.js";

/** One row of tesseract's TSV. Level 5 is a word; 4 a line; 3 a paragraph; 2 a block. */
interface TsvRow {
  level: number; block: number; par: number; line: number;
  left: number; top: number; width: number; height: number;
  conf: number; text: string;
}

export interface ExtractResult {
  width: number;
  height: number;
  elements: DOMAttentionElement[];
  stats: {
    words: number;
    lines: number;
    medianWordHeight: number;
    byType: Record<string, number>;
  };
}

/** Confidence floor. Below this tesseract is usually reading texture as glyphs. */
const MIN_CONF = 40;
/** A heading is this much taller than the page's median word. Typographic, not semantic. */
const HEADING_RATIO = 1.5;
/** Nav sits in the top band of the page. */
const NAV_BAND = 0.18;
/** Quantisation step for colour mode. 5 bits/channel: enough to separate a button from its page. */
const Q = 8;

function runTesseract(imagePath: string): TsvRow[] {
  const r = spawnSync("tesseract", [imagePath, "stdout", "tsv"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  // A missing binary or a crash must not look like "this page has no text".
  // An empty element list scores as a flat map, which is a legitimate-looking
  // 0.5 AUC -- the exact shape of silent failure this study keeps rediscovering.
  if (r.error) throw new Error(`tesseract failed on ${imagePath}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`tesseract exit ${r.status} on ${imagePath}: ${(r.stderr || "").slice(0, 200)}`);

  const out: TsvRow[] = [];
  const lines = (r.stdout || "").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (c.length < 12) continue;
    out.push({
      level: +c[0], block: +c[2], par: +c[3], line: +c[4],
      left: +c[6], top: +c[7], width: +c[8], height: +c[9],
      conf: parseFloat(c[10]), text: c[11] ?? "",
    });
  }
  return out;
}

/** Mode of the quantised colour over a sampled set of pixels. */
function dominantColour(px: Buffer, ch: number, idxs: number[]): [number, number, number] {
  const hist = new Map<number, number>();
  for (const i of idxs) {
    const k = ((px[i * ch] >> 3) << 10) | ((px[i * ch + 1] >> 3) << 5) | (px[i * ch + 2] >> 3);
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  let best = 0, bestN = -1;
  for (const [k, n] of hist) if (n > bestN) { bestN = n; best = k; }
  return [((best >> 10) & 31) * Q, ((best >> 5) & 31) * Q, (best & 31) * Q];
}

function colourDist(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Non-text regions that carry visual content: photos, logos, illustrations.
 *
 * Without these the semantic map is text-only, which on a UI screenshot means a
 * hero image contributes nothing while its caption contributes everything -- a
 * systematic bias against exactly the regions that draw the eye. Detected as
 * cells with high local colour variance that no OCR word overlaps, then merged
 * into rectangles by connected components.
 */
function detectImageRegions(
  px: Buffer, ch: number, W: number, H: number,
  wordBoxes: Array<{ x: number; y: number; width: number; height: number }>,
): DOMAttentionElement[] {
  const cell = Math.max(16, Math.round(Math.min(W, H) / 40));
  const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
  const busy = new Uint8Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let n = 0, sum = 0, sumSq = 0;
      const y1 = Math.min(H, (r + 1) * cell), x1 = Math.min(W, (c + 1) * cell);
      // Stride 2 -- a quarter of the pixels is plenty for a variance threshold.
      for (let y = r * cell; y < y1; y += 2) {
        for (let x = c * cell; x < x1; x += 2) {
          const i = (y * W + x) * ch;
          const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
          sum += l; sumSq += l * l; n++;
        }
      }
      if (n < 4) continue;
      const varc = sumSq / n - (sum / n) ** 2;
      if (varc > 400) busy[r * cols + c] = 1; // stdev > 20 grey levels
    }
  }

  // Any cell a word touches is text, not image.
  for (const b of wordBoxes) {
    const c0 = Math.max(0, Math.floor(b.x / cell)), c1 = Math.min(cols - 1, Math.floor((b.x + b.width) / cell));
    const r0 = Math.max(0, Math.floor(b.y / cell)), r1 = Math.min(rows - 1, Math.floor((b.y + b.height) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) busy[r * cols + c] = 0;
  }

  // Connected components (4-neighbour) over the surviving cells.
  const seen = new Uint8Array(cols * rows);
  const out: DOMAttentionElement[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = r * cols + c;
      if (!busy[s] || seen[s]) continue;
      let minR = r, maxR = r, minC = c, maxC = c, area = 0;
      const stack = [s];
      seen[s] = 1;
      while (stack.length) {
        const cur = stack.pop()!;
        const cr = Math.floor(cur / cols), cc = cur % cols;
        area++;
        if (cr < minR) minR = cr; if (cr > maxR) maxR = cr;
        if (cc < minC) minC = cc; if (cc > maxC) maxC = cc;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nr = cr + dr, nc = cc + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const ni = nr * cols + nc;
          if (busy[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
        }
      }
      if (area < 4) continue; // isolated noisy cells are not a picture
      out.push({
        type: "image",
        x: minC * cell, y: minR * cell,
        width: Math.min(W, (maxC + 1) * cell) - minC * cell,
        height: Math.min(H, (maxR + 1) * cell) - minR * cell,
      });
    }
  }
  return out;
}

/**
 * Build the element list for one screenshot.
 *
 * Classification is typographic and geometric ONLY:
 *   heading -- glyphs >= 1.5x the page's median word height
 *   nav     -- short line, in the top band, with >=2 same-height peers beside it
 *   cta     -- short line whose surrounding ring differs from the page background
 *              (i.e. it sits on a filled panel, which is what a button is)
 *   image   -- high-variance region with no glyphs in it
 *   content -- everything else
 *
 * None of these rules inspect what the text SAYS. That restraint is the whole
 * point: the moment a rule reads "Sign up" and concludes "call to action", the
 * extractor has started doing the job the study is trying to measure.
 */
export async function extractElements(imagePath: string): Promise<ExtractResult> {
  const img = sharp(imagePath).removeAlpha();
  const { data: px, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;

  const rows = runTesseract(imagePath);
  const words = rows.filter((r) => r.level === 5 && r.conf >= MIN_CONF && r.text.trim().length > 0 && r.height > 2);

  // Page background: mode over a coarse sample of the whole frame.
  const sample: number[] = [];
  for (let y = 0; y < H; y += Math.max(1, Math.floor(H / 120))) {
    for (let x = 0; x < W; x += Math.max(1, Math.floor(W / 120))) sample.push(y * W + x);
  }
  const pageBg = dominantColour(px, ch, sample);

  const medH = median(words.map((w) => w.height)) || 1;

  // Group words into lines by tesseract's own (block, par, line) keys.
  const byLine = new Map<string, TsvRow[]>();
  for (const w of words) {
    const k = `${w.block}|${w.par}|${w.line}`;
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k)!.push(w);
  }

  interface Line {
    x: number; y: number; width: number; height: number;
    text: string; wordCount: number; medH: number;
    words: Array<{ text: string; x: number; y: number; width: number; height: number }>;
  }
  const lines: Line[] = [];
  for (const ws of byLine.values()) {
    const x0 = Math.min(...ws.map((w) => w.left));
    const y0 = Math.min(...ws.map((w) => w.top));
    const x1 = Math.max(...ws.map((w) => w.left + w.width));
    const y1 = Math.max(...ws.map((w) => w.top + w.height));
    lines.push({
      x: x0, y: y0, width: x1 - x0, height: y1 - y0,
      text: ws.map((w) => w.text).join(" ").trim(),
      wordCount: ws.length,
      medH: median(ws.map((w) => w.height)),
      words: ws.map((w) => ({ text: w.text, x: w.left, y: w.top, width: w.width, height: w.height })),
    });
  }

  /** Colour of the ring just outside a box -- the panel it sits on, not its glyphs. */
  const ringColour = (l: Line): [number, number, number] => {
    const m = Math.max(4, Math.round(l.height * 0.5));
    const idxs: number[] = [];
    for (let x = Math.max(0, l.x - m); x < Math.min(W, l.x + l.width + m); x += 2) {
      for (const y of [l.y - m, l.y + l.height + m]) {
        if (y >= 0 && y < H) idxs.push(y * W + x);
      }
    }
    for (let y = Math.max(0, l.y); y < Math.min(H, l.y + l.height); y += 2) {
      for (const x of [l.x - m, l.x + l.width + m]) {
        if (x >= 0 && x < W) idxs.push(y * W + x);
      }
    }
    return idxs.length ? dominantColour(px, ch, idxs) : pageBg;
  };

  const elements: DOMAttentionElement[] = [];
  for (const l of lines) {
    const short = l.wordCount <= 4;
    const inTopBand = l.y < H * NAV_BAND;

    // Nav: a short line in the top band with same-height short peers beside it.
    // A single link is not a nav bar; a ROW of them is, and that row is what the
    // geometry can actually see.
    const peers = lines.filter((o) =>
      o !== l && o.wordCount <= 4 && Math.abs(o.y - l.y) < l.height * 0.8 &&
      Math.abs(o.medH - l.medH) <= 2 && o.y < H * NAV_BAND).length;

    const ring = ringColour(l);
    const onPanel = colourDist(ring, pageBg) > 60;

    const el: DOMAttentionElement = {
      type: "content",
      x: l.x, y: l.y, width: l.width, height: l.height,
      text: l.text,
      words: l.words,
    };

    if (l.medH >= medH * HEADING_RATIO) el.isHeading = true;
    else if (inTopBand && short && peers >= 2) el.isNav = true;
    else if (short && onPanel) el.isCTA = true;

    elements.push(el);
  }

  const wordBoxes = words.map((w) => ({ x: w.left, y: w.top, width: w.width, height: w.height }));
  elements.push(...detectImageRegions(px, ch, W, H, wordBoxes));

  const byType: Record<string, number> = {};
  for (const e of elements) {
    const t = e.isCTA ? "cta" : e.isHeading ? "heading" : e.isNav ? "navigation"
      : e.isDecorative ? "decorative" : (e.type || "content");
    byType[t] = (byType[t] ?? 0) + 1;
  }

  return {
    width: W, height: H, elements,
    stats: { words: words.length, lines: lines.length, medianWordHeight: medH, byType },
  };
}

// CLI: inspect one image's extraction without running the whole study.
if (import.meta.main) {
  const p = process.argv[2];
  if (!p) { console.error("usage: bun research/study1/ocr-extract.ts <image>"); process.exit(1); }
  const r = await extractElements(p);
  console.log(`${p}  ${r.width}x${r.height}`);
  console.log(`words=${r.stats.words} lines=${r.stats.lines} medianWordHeight=${r.stats.medianWordHeight}`);
  console.log("byType:", r.stats.byType);
  for (const e of r.elements.slice(0, 25)) {
    const t = e.isCTA ? "cta" : e.isHeading ? "heading" : e.isNav ? "nav" : (e.type || "content");
    console.log(`  ${t.padEnd(9)} (${e.x},${e.y}) ${e.width}x${e.height}  ${JSON.stringify((e.text ?? "").slice(0, 48))}`);
  }
}
