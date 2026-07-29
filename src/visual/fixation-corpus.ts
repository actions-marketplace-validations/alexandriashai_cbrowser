/**
 * Fixation corpora — human eye-tracking ground truth, in one shape.
 *
 * WHAT A CORPUS IS FOR HERE
 *
 * Three distinct uses, and conflating them is how saliency work goes wrong:
 *
 *   1. VALIDATION — score the shipped model against human fixations. This is
 *      what makes an accuracy claim sayable out loud. Study 1 did this against
 *      UEyes and reported AUC-Judd 0.663 / NSS 0.544 / CC 0.216.
 *   2. CALIBRATION — tune model parameters (channel weights, surround radius,
 *      cell size) to maximise those metrics. Legitimate, but it spends the
 *      corpus: a model tuned on a set can no longer be honestly validated on
 *      that same set, which is why `split` exists below.
 *   3. PRIORS — derive empirical structure from the corpus and bake it into the
 *      model. A centre-bias prior alone lifts AUC substantially on almost any
 *      dataset, because humans fixate the middle regardless of content.
 *
 * The interface is deliberately corpus-agnostic. UEyes is what is on disk
 * today; MIT1003, CAT2000 and SALICON have the same shape (images + fixation
 * points + density maps) and should not need new plumbing.
 *
 * WHAT UEYES GIVES THAT MOST CORPORA DO NOT
 *
 * - It is WEB PAGES (1980 of them), not natural scenes. Saliency models tuned on
 *   photographs transfer poorly to interfaces, where text and affordances
 *   dominate.
 * - Fixation maps at 1s / 3s / 7s separately. Attention at first impression is
 *   not attention after consideration, and cbrowser's personas differ precisely
 *   on patience — an impatient persona should be scored against 1s, a thorough
 *   one against 7s. Scoring every persona against one horizon throws that away.
 * - Per-fixation logs with duration and saccade magnitude/direction, so scanpath
 *   ORDER is available, not just aggregate density.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join, basename, extname } from "path";
import type { Fixation, SaliencyGrid } from "./saliency-metrics.js";

/** Viewing durations UEyes separates. Others may expose only one. */
export type FixationHorizon = "1s" | "3s" | "7s";

export interface CorpusStimulus {
  /** Stable id — the image filename without extension. */
  id: string;
  /** Absolute path to the stimulus image. */
  imagePath: string;
  /** Ground-truth fixation density map per horizon, when the corpus has them. */
  fixationMaps: Partial<Record<FixationHorizon, string>>;
}

export interface CorpusInfo {
  name: string;
  root: string;
  stimuli: CorpusStimulus[];
  horizons: FixationHorizon[];
  /** Absent when the corpus ships only density maps and no raw logs. */
  fixationLogDir?: string;
  citation: string;
}

/**
 * One participant fixation as recorded by the tracker.
 *
 * Coordinates are NORMALIZED 0-1 in the source logs and stay that way here.
 * Converting to pixels requires the stimulus dimensions, and doing it at load
 * time — before the caller says which grid they are scoring against — is how
 * coordinate-space bugs get baked in. `fixationsToGrid` does the conversion at
 * the point the target size is actually known.
 */
export interface RawFixation {
  /** 0-1, left to right. */
  xNorm: number;
  /** 0-1, top to bottom. */
  yNorm: number;
  /** Dwell in seconds. */
  duration: number;
  /** Seconds since stimulus onset — this is what makes horizon filtering possible. */
  startTime: number;
  participantId: string;
  stimulusId: string;
}

/**
 * Discover a UEyes-layout corpus.
 *
 * Returns null rather than throwing when the directory is absent: the corpus is
 * 13GB and is not, and should not be, a dependency of the shipped package.
 * Anything that needs it degrades to "not available" rather than failing.
 */
export function loadUEyesCorpus(root: string): CorpusInfo | null {
  const imagesDir = join(root, "images");
  if (!existsSync(imagesDir)) return null;

  const horizons: FixationHorizon[] = [];
  for (const h of ["1s", "3s", "7s"] as FixationHorizon[]) {
    if (existsSync(join(root, "saliency_maps", `fixmaps_${h}`))) horizons.push(h);
  }

  const stimuli: CorpusStimulus[] = [];
  for (const file of readdirSync(imagesDir)) {
    const ext = extname(file).toLowerCase();
    if (ext !== ".jpg" && ext !== ".png" && ext !== ".jpeg") continue;
    const id = basename(file, ext);
    const fixationMaps: Partial<Record<FixationHorizon, string>> = {};
    for (const h of horizons) {
      const candidate = join(root, "saliency_maps", `fixmaps_${h}`, file);
      if (existsSync(candidate)) fixationMaps[h] = candidate;
    }
    stimuli.push({ id, imagePath: join(imagesDir, file), fixationMaps });
  }

  const logDir = join(root, "eyetracker_logs");
  return {
    name: "UEyes",
    root,
    stimuli: stimuli.sort((a, b) => a.id.localeCompare(b.id)),
    horizons,
    fixationLogDir: existsSync(logDir) ? logDir : undefined,
    citation:
      "Jiang et al., UEyes: Understanding Visual Saliency across User Interface Types. CHI 2023.",
  };
}

/**
 * Parse one Gazepoint-format tracker log.
 *
 * The columns that matter: MEDIA_NAME (which stimulus), FPOGX/FPOGY (gaze point
 * of regard, normalized), FPOGD (duration), FPOGS (start time), FPOGV (valid).
 *
 * INVALID SAMPLES ARE DROPPED, not clamped. FPOGV=0 means the tracker lost the
 * eye — a blink, a look away, a calibration slip. Those rows still carry
 * coordinates, and treating them as fixations manufactures ground truth from
 * noise. Off-screen coordinates are dropped for the same reason.
 */
export function parseGazepointLog(logPath: string): RawFixation[] {
  const text = readFileSync(logPath, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim());
  const col = (name: string) => header.findIndex((h) => h === name || h.startsWith(`${name}(`));
  const iMedia = col("MEDIA_NAME");
  const iX = col("FPOGX");
  const iY = col("FPOGY");
  const iD = col("FPOGD");
  const iS = col("FPOGS");
  const iV = col("FPOGV");
  const iId = col("FPOGID");
  if (iX < 0 || iY < 0) return [];

  const participantId = basename(logPath).replace(/_fixations\.csv$/i, "");
  const out: RawFixation[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (iV >= 0 && parts[iV]?.trim() !== "1") continue; // tracker lost the eye
    const xNorm = Number(parts[iX]);
    const yNorm = Number(parts[iY]);
    if (!Number.isFinite(xNorm) || !Number.isFinite(yNorm)) continue;
    if (xNorm < 0 || xNorm > 1 || yNorm < 0 || yNorm > 1) continue; // off-stimulus

    // One row per SAMPLE, many samples per fixation. Deduplicate on FPOGID so a
    // long fixation counts once — otherwise dwell time silently becomes a vote
    // multiplier and every metric is weighted by how long the tracker sampled.
    const fixId = iId >= 0 ? parts[iId]?.trim() : undefined;
    const media = iMedia >= 0 ? (parts[iMedia] ?? "").trim() : "";
    const key = `${media}|${fixId ?? `${i}`}`;
    if (fixId && seen.has(key)) continue;
    if (fixId) seen.add(key);

    out.push({
      xNorm,
      yNorm,
      duration: iD >= 0 ? Number(parts[iD]) || 0 : 0,
      startTime: iS >= 0 ? Number(parts[iS]) || 0 : 0,
      participantId,
      stimulusId: media ? basename(media, extname(media)) : "",
    });
  }
  return out;
}

/**
 * Keep only fixations that occurred within `seconds` of stimulus onset.
 *
 * This is what lets a persona be scored against the horizon that matches it: an
 * impatient persona compared to 1s of human viewing, a thorough one to 7s.
 * Comparing every persona to the same aggregate map discards the one dimension
 * this corpus was built to expose.
 */
export function filterByHorizon(fixations: RawFixation[], seconds: number): RawFixation[] {
  return fixations.filter((f) => f.startTime <= seconds);
}

/** Convert normalized fixations to a grid's pixel space. */
export function toGridFixations(
  fixations: RawFixation[],
  gridWidth: number,
  gridHeight: number,
): Fixation[] {
  return fixations.map((f) => ({
    x: f.xNorm * gridWidth,
    y: f.yNorm * gridHeight,
    duration: f.duration * 1000,
  }));
}

/**
 * Build a fixation density map by accumulating Gaussian blobs.
 *
 * Ground-truth maps ship with UEyes, but a corpus that provides only raw logs
 * needs this to score CC at all. Sigma is in grid cells; the literature
 * convention is roughly one degree of visual angle, and for a 32x32 analysis
 * grid that lands near 1.
 */
export function fixationsToGrid(
  fixations: Fixation[],
  width: number,
  height: number,
  sigma = 1.0,
): SaliencyGrid {
  const values = new Float64Array(width * height);
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const twoSigmaSq = 2 * sigma * sigma;

  for (const f of fixations) {
    const cx = f.x;
    const cy = f.y;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(width - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(height - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
        values[y * width + x] += Math.exp(-d2 / twoSigmaSq);
      }
    }
  }
  return { values, width, height };
}

/**
 * Deterministic train/test split.
 *
 * Calibrating on a corpus and then reporting accuracy on the same corpus is
 * measuring how well the parameters were fitted, not how well the model
 * generalises — and it is the single easiest way to publish a number that does
 * not survive review. The split is by stimulus id hash so it is stable across
 * runs and machines without storing a manifest.
 */
export function splitCorpus(
  corpus: CorpusInfo,
  testFraction = 0.3,
): { train: CorpusStimulus[]; test: CorpusStimulus[] } {
  const hash = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  };
  const train: CorpusStimulus[] = [];
  const test: CorpusStimulus[] = [];
  for (const s of corpus.stimuli) (hash(s.id) < testFraction ? test : train).push(s);
  return { train, test };
}
