/**
 * Re-run the 199-site agent-readiness benchmark after the 2026-08-04 fixes.
 *
 * ## Why the April 2026 run has to be discarded, not compared against
 *
 * The April run recorded two outcomes: a grade, or "failed". That taxonomy is
 * what hid the bug. `agent_ready_audit` scored `espn.com` at **94/A with
 * `totalElements: 0`** -- the scorer deducts from 100 per issue found, so a page
 * that never loaded had nothing deducted and came out perfect. Bot-blocked sites
 * were collecting the product's top grade, and they were recorded as successes.
 *
 * So April's 189 "graded" sites are a mix of real measurements and false A's
 * from blocked crawls, in unknown proportion. There is no way to separate them
 * after the fact, which is why this re-runs everything rather than re-checking
 * a suspicious subset.
 *
 * ## The outcome taxonomy is the point of this file
 *
 * Three states, never two:
 *
 *   graded   the auditor loaded the page and scored it
 *   blocked  the auditor could not load the page (0 interactive elements).
 *            NOT a low score. An absent measurement. Reporting it in the same
 *            units as a grade is the exact defect being fixed.
 *   error    crash, timeout, DNS, or anything else
 *
 * Collapsing `blocked` into either `graded` or `error` reintroduces the bug --
 * as a grade it is a false A, as an error it silently drops the most
 * agent-hostile sites from the sample and biases every aggregate that follows.
 *
 * Usage:
 *   bun research/benchmark/rerun.ts [--concurrency N] [--limit N]
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

interface Site { site: string; url: string; industry: string }
type Outcome = "graded" | "blocked" | "error";
interface Row extends Site {
  outcome: Outcome;
  grade?: string;
  overall?: number;
  findability?: number;
  stability?: number;
  accessibility?: number;
  semantics?: number;
  totalElements?: number;
  detail?: string;
  ms: number;
}

/** Repo root, derived — this file lives at <root>/research/benchmark/. */
const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(import.meta.dir, "results");
const TMP = join(import.meta.dir, ".tmp-audits");

/** The audit's refusal message. Matching on it is how `blocked` is distinguished from `error`. */
const BLOCKED_MARKER = "0 interactive elements";

function auditOne(s: Site, idx: number): Promise<Row> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const jsonPath = join(TMP, `${idx}-${s.url.replace(/[^a-z0-9.]/gi, "_")}.json`);
    const p = spawn("bun", ["run", "src/cli.ts", "agent-ready-audit", `https://${s.url}`, "--output", jsonPath], {
      cwd: ROOT, env: process.env,
    });
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { out += d.toString(); });

    // Hard ceiling. A hung browser must not stall the whole sweep.
    const killer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 180_000);

    p.on("close", () => {
      clearTimeout(killer);
      const ms = Date.now() - t0;
      if (out.includes(BLOCKED_MARKER)) {
        return resolve({ ...s, outcome: "blocked", ms, detail: "auditor saw 0 interactive elements" });
      }
      try {
        const d = JSON.parse(readFileSync(jsonPath, "utf8"));
        const sc = d.score ?? {};
        return resolve({
          ...s, outcome: "graded", ms,
          grade: d.grade, overall: sc.overall,
          findability: sc.findability, stability: sc.stability,
          accessibility: sc.accessibility, semantics: sc.semantics,
          totalElements: d.summary?.totalElements,
        });
      } catch {
        const m = out.match(/(TypeError|Error):\s*([^\n]{0,120})/);
        return resolve({ ...s, outcome: "error", ms, detail: m ? `${m[1]}: ${m[2]}` : out.slice(-120).replace(/\s+/g, " ") });
      }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n: string, d: number) => (args.includes(n) ? Number(args[args.indexOf(n) + 1]) : d);
  const concurrency = arg("--concurrency", 5);
  const limit = arg("--limit", Infinity);

  mkdirSync(TMP, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const TARGET = arg("--target", 200);
  const seed: Site[] = JSON.parse(
    readFileSync(join(import.meta.dir, "sites.json"), "utf8"),
  ).filter((s: Site) => s.url && /\./.test(s.url));
  const pool: Site[] = JSON.parse(readFileSync(join(import.meta.dir, "replacement-pool.json"), "utf8"));

  // Seed first, then top up from the pool until TARGET sites are GRADED.
  //
  // Alexa's call, 2026-08-04: blocked sites are dropped and replaced so the
  // benchmark carries 200 real measurements. Stated once and recorded here
  // because it is a real selection effect -- the excluded sites are the most
  // bot-hostile ones, which are plausibly also the least agent-friendly, so the
  // mean of what remains is biased UPWARD and this is a benchmark of "sites that
  // let our auditor in", not of the web. That is a coherent artifact as long as
  // the exclusion is visible, so `blocked_sites` ships in the summary rather
  // than being deleted.
  const seen = new Set(seed.map((s) => s.url));
  const queue: Site[] = [...seed, ...pool.filter((p) => !seen.has(p.url))];
  const all = queue.slice(0, limit === Infinity ? queue.length : limit);

  console.log(`seed ${seed.length} + pool ${queue.length - seed.length} = ${all.length} candidates`);
  console.log(`target: ${TARGET} GRADED sites, concurrency ${concurrency}`);

  const rows: Row[] = [];
  let next = 0, done = 0, gradedCount = 0;

  async function worker() {
    while (next < all.length) {
      // Stop pulling new work once the target is met; in-flight audits finish.
      if (gradedCount >= TARGET) return;
      const i = next++;
      const r = await auditOne(all[i], i);
      rows.push(r);
      if (r.outcome === "graded") gradedCount++;
      done++;
      if (done % 10 === 0) {
        const b = rows.filter((x) => x.outcome === "blocked").length;
        const e = rows.filter((x) => x.outcome === "error").length;
        console.log(`  attempted ${done}  GRADED ${gradedCount}/${TARGET}  blocked ${b}  error ${e}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const by = (o: Outcome) => rows.filter((r) => r.outcome === o);
  const graded = by("graded");
  const grades: Record<string, number> = {};
  for (const r of graded) grades[r.grade ?? "?"] = (grades[r.grade ?? "?"] ?? 0) + 1;
  const scores = graded.map((r) => r.overall ?? 0);
  const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);

  const summary = {
    ran: new Date().toISOString(),
    attempted: rows.length,
    graded: graded.length,
    blocked: by("blocked").length,
    error: by("error").length,
    grade_distribution: grades,
    mean_score_graded_only: +mean.toFixed(1),
    blocked_sites: by("blocked").map((r) => r.url).sort(),
    error_sites: by("error").map((r) => ({ url: r.url, detail: r.detail })),
    note: "April 2026's 189 'graded' sites included an unknown number of false A's from blocked crawls (espn.com scored 94/A on 0 elements). The two runs are not comparable; this one is the baseline.",
  };

  writeFileSync(join(OUT, "rerun_2026-08-04.json"), JSON.stringify({ summary, rows }, null, 2));
  writeFileSync(join(OUT, "rerun_2026-08-04.csv"),
    "site,url,industry,outcome,grade,overall,findability,stability,accessibility,semantics,totalElements,ms\n" +
    rows.map((r) => [r.site, r.url, r.industry, r.outcome, r.grade ?? "", r.overall ?? "", r.findability ?? "",
      r.stability ?? "", r.accessibility ?? "", r.semantics ?? "", r.totalElements ?? "", r.ms].join(",")).join("\n"));

  console.log(`\n${"=".repeat(56)}`);
  console.log(`attempted ${summary.attempted}   graded ${summary.graded}   BLOCKED ${summary.blocked}   error ${summary.error}`);
  console.log(`grades (graded only): ${JSON.stringify(summary.grade_distribution)}`);
  console.log(`mean score, graded only: ${summary.mean_score_graded_only}   (April reported 75.4 over a contaminated 189)`);
  console.log(`\nblocked: ${summary.blocked_sites.join(", ") || "(none)"}`);
  console.log(`\nwrote ${OUT}/rerun_2026-08-04.{json,csv}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
