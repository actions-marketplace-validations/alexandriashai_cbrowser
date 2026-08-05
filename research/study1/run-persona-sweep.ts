/**
 * Does persona conditioning improve gaze prediction? Two separate questions.
 *
 * These get conflated constantly, and conflating them is why the persona layer
 * has never been honestly evaluated:
 *
 *   Q1  Does persona MOVE the map at all?
 *       Measurable here. If every persona produces the same heatmap, the layer
 *       is decoration regardless of what any score says.
 *
 *   Q2  Does persona move the map in the RIGHT direction?
 *       NOT measurable here, and this run does not claim to. UEyes ground truth
 *       is pooled over 62 participants with no group labels. Scoring a persona
 *       against an undifferentiated average penalises deviation as error when
 *       deviation is the entire point. A persona that perfectly modelled ADHD
 *       viewers would score WORSE against the pooled average than a persona that
 *       modelled nobody.
 *
 * So the AUC column below answers "how far from the average viewer", not "how
 * good". The only corpus that could answer Q2 is a group-labelled one
 * (Saliency4ASD), and the 2026-07-29 crossover test on it came back negative:
 * no interaction, and the ASD persona was simply a worse saliency model on BOTH
 * populations (t = -27 to -48). That test exercised only the perceptual filter
 * over bottom-up saliency; the semantic layer -- which this run finally makes
 * runnable -- remains untested for Q2.
 *
 * What this run adds is the Q1 half, on interfaces, through the semantic path:
 * a divergence measure between persona maps alongside the AUC spread.
 *
 * Usage:
 *   bun research/study1/run-persona-sweep.ts [--limit N]
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { readdirSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import {
  computeLabSaliency, buildSemanticMap, applyPersonaFilter,
} from "../../src/visual/attention-transport.js";
import { getPerceptualProfile } from "../../src/visual/perceptual-transport.js";
import { computeAUCJudd, computeNSS, type SaliencyGrid, type Fixation } from "../../src/visual/saliency-metrics.js";
import { loadUEyesCorpus, parseGazepointLog, type RawFixation } from "../../src/visual/fixation-corpus.js";
import { extractElements } from "./ocr-extract.js";

const ROOT = join(import.meta.dir, "UEyes_dataset");
const CELL = 16;
/** The operating point set on 2026-08-04 by run-blend-sweep.ts. */
const VISUAL_W = 0.05;

function toGrid(fx: RawFixation[], rows: number, cols: number): Fixation[] {
  const out: Fixation[] = [];
  for (const f of fx) {
    const c = Math.floor((f as any).xNorm * cols), r = Math.floor((f as any).yNorm * rows);
    if (r >= 0 && r < rows && c >= 0 && c < cols) out.push({ x: c, y: r });
  }
  return out;
}

/**
 * Normalised L1 distance between two maps, each scaled to unit mass first.
 *
 * Scaling to unit mass matters: a persona filter that merely brightens the whole
 * map is not attending differently, it is attending identically at a different
 * gain. AUC would not notice (it is rank-based) and a raw L1 would score it as a
 * big change. Unit-mass L1 answers the question actually being asked -- is the
 * attention distributed DIFFERENTLY -- on a 0..2 scale where 0 is identical.
 */
function divergence(a: Float64Array, b: Float64Array): number {
  let sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; }
  if (sa <= 0 || sb <= 0) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] / sa - b[i] / sb);
  return d;
}

function blend(vis: Float64Array, sem: Float64Array, w: number): Float64Array {
  const out = new Float64Array(vis.length);
  for (let i = 0; i < vis.length; i++) out[i] = vis[i] * w + sem[i] * (1 - w);
  let mx = 0.001;
  for (let i = 0; i < out.length; i++) if (out[i] > mx) mx = out[i];
  for (let i = 0; i < out.length; i++) out[i] /= mx;
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
  const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(import.meta.dir, "results/2026-08-04_persona-sweep");

  const pm: any = await import("../../src/personas.js");
  const nm = (x: any) => (typeof x === "string" ? x : (x.name ?? x.id));
  const personas: string[] = [
    ...(pm.listPersonas?.() ?? []).map(nm),
    ...(pm.listAccessibilityPersonas?.() ?? []).map(nm),
    ...(pm.listEmotionalPersonas?.() ?? []).map(nm),
  ].filter(Boolean);
  console.log(`personas: ${personas.length}`);

  // Resolve each persona's traits/values once, exactly as analyzeAttention does.
  const ctx = new Map<string, { profile: any; traits?: Record<string, number>; values?: Record<string, number> }>();
  const { resolveValuesForPersona } = await import("../../src/values/index.js");
  const { getAnyPersona, getCognitiveProfile } = await import("../../src/personas.js");
  for (const p of personas) {
    let values: Record<string, number> | undefined, traits: Record<string, number> | undefined;
    try {
      const pv = resolveValuesForPersona(p);
      if (pv) values = {
        selfDirection: pv.selfDirection, stimulation: pv.stimulation, hedonism: pv.hedonism,
        achievement: pv.achievement, power: pv.power, security: pv.security,
        conformity: pv.conformity, tradition: pv.tradition, benevolence: pv.benevolence,
        universalism: pv.universalism,
      };
    } catch {}
    try {
      const o = getAnyPersona(p);
      if (o) traits = getCognitiveProfile(o as any).traits as unknown as Record<string, number>;
    } catch {}
    ctx.set(p, { profile: getPerceptualProfile(p), traits, values });
  }

  const corpus = loadUEyesCorpus(ROOT);
  if (!corpus) throw new Error("corpus not loadable");
  const webNames = new Set<string>();
  for (const line of readFileSync(join(ROOT, "image_types.csv"), "utf8").split("\n").slice(1)) {
    const [name, cat] = line.split(";");
    if (cat?.trim() === "web") webNames.add(name.trim().replace(/\.[^.]+$/, "").toLowerCase());
  }
  const byImage = new Map<string, RawFixation[]>();
  for (const f of readdirSync(join(ROOT, "eyetracker_logs"))) {
    if (!f.endsWith(".csv") || f.startsWith("._")) continue;
    for (const fx of parseGazepointLog(join(ROOT, "eyetracker_logs", f))) {
      const k = String((fx as any).stimulusId ?? "").toLowerCase();
      if (!k) continue;
      if (!byImage.has(k)) byImage.set(k, []);
      byImage.get(k)!.push(fx);
    }
  }

  const auc: Record<string, number[]> = {}, nss: Record<string, number[]> = {};
  for (const p of personas) { auc[p] = []; nss[p] = []; }
  const divVsRef: Record<string, number[]> = {};
  const maxPairDiv: number[] = [];
  const REF = "first-timer";
  let n = 0;

  for (const st of corpus.stimuli) {
    if (n >= limit) break;
    const key = basename(st.imagePath).replace(/\.[^.]+$/, "").toLowerCase();
    if (!webNames.has(key)) continue;
    const fx = byImage.get(key);
    if (!fx?.length) continue;

    try {
      const sal = await computeLabSaliency(st.imagePath, CELL);
      const pts = toGrid(fx, sal.rows, sal.cols);
      if (!pts.length) continue;
      const ex = await extractElements(st.imagePath);

      const maps: Record<string, Float64Array> = {};
      for (const p of personas) {
        const c = ctx.get(p)!;
        const sem = buildSemanticMap(
          ex.elements, sal.rows, sal.cols, CELL, sal.width, sal.height,
          p, undefined, c.traits, c.values, undefined,
        );
        const m = applyPersonaFilter(blend(sal.cells, sem, VISUAL_W), sal.rows, sal.cols, c.profile.visualFilter, c.values);
        maps[p] = m;
        const g: SaliencyGrid = { values: m, width: sal.cols, height: sal.rows };
        auc[p].push(computeAUCJudd(g, pts).auc);
        nss[p].push(computeNSS(g, pts).nss);
      }

      for (const p of personas) {
        (divVsRef[p] ??= []).push(divergence(maps[p], maps[REF]));
      }
      let mx = 0;
      for (let i = 0; i < personas.length; i++)
        for (let j = i + 1; j < personas.length; j++) {
          const d = divergence(maps[personas[i]], maps[personas[j]]);
          if (d > mx) mx = d;
        }
      maxPairDiv.push(mx);

      n++;
      if (n % 25 === 0) console.log(`  ${n} scored`);
    } catch (e) {
      console.warn(`  skip ${key}: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const table = personas.map((p) => ({
    persona: p, auc: avg(auc[p]), nss: avg(nss[p]), divergence_vs_ref: avg(divVsRef[p] ?? []),
  })).sort((a, b) => b.auc - a.auc);

  const aucs = table.map((r) => r.auc);
  const spread = Math.max(...aucs) - Math.min(...aucs);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "persona_sweep.json"), JSON.stringify({
    ran: new Date().toISOString(), images: n, personas: personas.length,
    reference_persona: REF, visual_weight: VISUAL_W,
    auc_spread: +spread.toFixed(4),
    mean_max_pairwise_divergence: +avg(maxPairDiv).toFixed(4),
    caveat: "AUC here measures distance from a 62-participant POOLED average, not correctness. It cannot answer whether a persona models its population.",
    table: table.map((r) => ({ ...r, auc: +r.auc.toFixed(4), nss: +r.nss.toFixed(4), divergence_vs_ref: +r.divergence_vs_ref.toFixed(4) })),
  }, null, 2));

  console.log(`\n${"persona".padEnd(32)}${"AUC".padStart(9)}${"NSS".padStart(9)}${"divergence".padStart(12)}`);
  for (const r of table)
    console.log(`${r.persona.padEnd(32)}${r.auc.toFixed(4).padStart(9)}${r.nss.toFixed(4).padStart(9)}${r.divergence_vs_ref.toFixed(4).padStart(12)}`);
  console.log(`\nAUC spread across ${personas.length} personas: ${spread.toFixed(4)}`);
  console.log(`Mean max pairwise map divergence (0=identical, 2=disjoint): ${avg(maxPairDiv).toFixed(4)}`);
  console.log(`n=${n} web stimuli. Wrote ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
