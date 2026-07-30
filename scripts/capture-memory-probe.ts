/**
 * CBrowser - Screen capture memory probe (ISC-6)
 *
 * Runs a real 30-second, 10 fps capture against a locally generated animated
 * page and reports peak memory. The point is the streaming design: frames are
 * written to disk as they arrive, so peak RSS must stay flat regardless of how
 * long the capture runs. A recorder that buffered 300 frames of PNG in memory
 * would show it here.
 *
 * Usage:
 *   /usr/bin/time -v bun scripts/capture-memory-probe.ts
 *   bun scripts/capture-memory-probe.ts --seconds 60 --fps 20
 *
 * Reported numbers:
 *   - capture process peak RSS: this process (bun) — where frame buffers live.
 *   - chromium peak RSS: sampled from /proc for the browser process tree.
 *     Reported separately because it is the browser's own rendering cost, not
 *     the recorder's, and no design change here would move it.
 *
 * Exit code is 1 if the capture-process peak exceeds --limit (default 500 MB).
 */

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

import { VideoCaptureSession } from "../src/recording/engine.js";

const MB = 1024 * 1024;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}

/** Peak RSS of this process, in bytes. */
function selfPeakRss(): number {
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const match = /VmHWM:\s+(\d+)\s+kB/.exec(status);
    if (match) return parseInt(match[1]!, 10) * 1024;
  } catch { /* non-Linux: fall back to the sampled value */ }
  return process.memoryUsage().rss;
}

/** Current RSS of every chromium process under this session, in bytes. */
function chromiumRss(): number {
  let total = 0;
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      const cmdlinePath = `/proc/${pid}/cmdline`;
      if (!existsSync(cmdlinePath)) continue;
      const cmdline = readFileSync(cmdlinePath, "utf8");
      if (!cmdline.includes("chrome") && !cmdline.includes("chromium")) continue;
      const statm = readFileSync(`/proc/${pid}/statm`, "utf8").split(" ");
      total += parseInt(statm[1]!, 10) * 4096; // resident pages
    }
  } catch { /* best effort */ }
  return total;
}

async function main(): Promise<void> {
  const seconds = arg("seconds", 30);
  const fps = arg("fps", 10);
  const limitMb = arg("limit", 500);

  const workDir = mkdtempSync(join(tmpdir(), "cbrowser-mem-probe-"));
  const pagePath = join(workDir, "animated.html");

  // A page that repaints continuously, so the recorder actually has work to do.
  writeFileSync(
    pagePath,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Memory Probe</title></head>
     <body style="margin:0;background:#000">
       <h1 id="h" style="color:#fff;font:700 64px sans-serif;margin:0">0</h1>
       <div id="box" style="width:400px;height:400px;background:#f0f"></div>
       <script>
         let n = 0;
         setInterval(() => {
           n++;
           document.getElementById("h").textContent = "Frame " + n;
           document.body.style.background = "hsl(" + (n * 7 % 360) + ",70%,25%)";
           document.getElementById("box").style.transform =
             "translateX(" + (n * 13 % 600) + "px) rotate(" + (n * 11 % 360) + "deg)";
         }, 33);
       </script>
     </body></html>`,
  );

  console.log(`Capture memory probe: ${seconds}s at ${fps} fps, limit ${limitMb} MB`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`file://${pagePath}`);

  const session = new VideoCaptureSession(page, "chromium", workDir);
  await session.start({ fps, slug: "memory-probe", outDir: join(workDir, "out"), format: [] });

  let peakSelf = selfPeakRss();
  let peakChromium = chromiumRss();
  const sampler = setInterval(() => {
    peakSelf = Math.max(peakSelf, selfPeakRss());
    peakChromium = Math.max(peakChromium, chromiumRss());
  }, 250);

  await new Promise((r) => setTimeout(r, seconds * 1000));

  clearInterval(sampler);
  const result = await session.stop();
  peakSelf = Math.max(peakSelf, selfPeakRss());

  await browser.close();

  const frames = result.manifest.frames.length;
  const peakSelfMb = peakSelf / MB;

  console.log("");
  console.log(`  frames captured:            ${frames}`);
  console.log(`  actual fps:                 ${result.manifest.actual_fps.toFixed(2)}`);
  console.log(`  duration:                   ${(result.manifest.duration_ms / 1000).toFixed(1)}s`);
  console.log(`  capture process peak RSS:   ${peakSelfMb.toFixed(1)} MB   <-- ISC-6 measure`);
  console.log(`  chromium peak RSS:          ${(peakChromium / MB).toFixed(1)} MB (browser, separate)`);
  console.log(`  bytes per frame retained:   ${(peakSelf / Math.max(frames, 1) / 1024).toFixed(1)} KB`);
  console.log("");

  if (peakSelfMb > limitMb) {
    console.error(`FAIL: capture process peak ${peakSelfMb.toFixed(1)} MB exceeds ${limitMb} MB`);
    process.exit(1);
  }
  console.log(`PASS: capture process peak ${peakSelfMb.toFixed(1)} MB is under ${limitMb} MB`);
}

main().catch((e) => {
  console.error(`Probe failed: ${(e as Error).message}`);
  process.exit(1);
});
