---
task: "cbrowser — cognitive browser automation"
slug: cbrowser
effort: advanced
effort_source: explicit
phase: observe
progress: 12/16
mode: iterate
started: 2026-07-13T20:39:10Z
updated: 2026-07-28T16:40:00Z
source: hand-authored
---

# cbrowser — Project ISA

> Deepened from the `IsaFromCodebase.ts` prebuild with evidence from the repo README,
> `package.json`, `src/` structure, and the cbrowser-web product site. Scope: the core
> npm package `cbrowser` (this repo). Behavioural ISCs below marked **(candidate)** are
> drawn from documented capabilities but need the owner to confirm the exact probe/contract.
> Suite green as of 2026-07-28 (636/0, 40 files, 259s, v18.73.2); scoring engine regression-pinned (ISC-11).
> Lint green again 2026-07-25 (0 errors / 77 warnings) after the `Function`-as-a-type fix.

## Problem

Teams ship web UX that quietly loses users — they abandon carts, bail on checkout, give up on goals — and the friction isn't discovered until conversion drops in production. Traditional testing checks that a flow *works*, not whether a real person (or an AI agent) can actually *get through it* without giving up. There's no cheap, fast way to predict cognitive abandonment before shipping.

## Vision

Point cbrowser at a URL and it tells you where users will give up **before they do**: a cognitive transport score (0–1), a per-step abandonment-risk percentage, and the specific bottleneck — across 26 cognitive traits and 11 disability/behaviour personas, in ~60 seconds. Sites that pass cbrowser's cognitive tests are measurably easier for both humans and AI agents to navigate.

## Out of Scope

- **The marketing/product frontend** — lives in the sibling `cbrowser-web` repo (Next.js). Not this package.
- **Enterprise-only tools + remote/hosted MCP** — the +20 enterprise tools and the remote enterprise server live in `cbrowser-enterprise`. This ISA covers the core `cbrowser` package and its local/base MCP server only.
- **General-purpose scraping / a functional-E2E-test-runner replacement.** cbrowser is cognitive/UX analysis + agent-navigability, not a Selenium/Playwright-test substitute.

## Principles

- **Predict, don't just report.** The value is surfacing abandonment *before it happens*, not logging it after.
- **Cheap and fast enough to run often.** ~$0.05/test, results in ~60s — usable in CI and iteration loops, not just audits.
- **Accessible output is first-class.** `--no-color` / `--plain` / `--json-output` must keep every command usable for screen readers, CI, and scripting.
- **Keyless basics, keyed cognition.** Navigate/screenshot/click/extract/explore need no API key; cognitive journeys require an Anthropic key. The boundary must stay clear.

## Constraints

- **Language / runtime:** TypeScript 5.3, Node ≥18. Published as npm package `cbrowser` (bin `cbrowser` → `dist/cli.js`).
- **Browser engine:** Playwright (Chromium primary; Firefox/WebKit optional). `postinstall` fetches Chromium.
- **Protocol:** MCP-compliant tool surface (`@modelcontextprotocol/sdk`) — the 120-tool contract is a public interface.
- **Cognitive dependency:** Anthropic API (`@anthropic-ai/sdk`) for cognitive journeys; basic commands must stay keyless.
- **Economics:** ~$0.05/test target — cost is a design constraint, not an afterthought.
- **License:** MIT.

## Goal

cbrowser is a cognitive browser-automation package that simulates real user cognition — abandonment detection, constitutional safety, UX friction discovery, and AI-agent navigability — exposed as a CLI and a 120-tool MCP server, so a site can be scored and de-frictioned for both humans and agents before it ships.

## Criteria

- [x] ISC-1: `bun test` reports **0 failures** — **636 pass / 0 fail across 40 files in 259s as of 2026-07-28**, at v18.73.2 (was 570 pass at 2026-07-25; 332 at 2026-07-14). Run via `bash scripts/test-split.sh`, which isolates the browser-heavy file in its own process. `bun-test`. *(Two probe verdicts on this ISC have now been wrong for DIFFERENT reasons, and the distinction matters. **2026-07-25:** a false refutation from the probe's own timeout — since fixed, `IsaProbe.ts` raised the budget to 600s on 2026-07-26 and added a `timeout` status that is UNKNOWN rather than FAILED. **2026-07-27T21:28:** a REAL failure — the probe ran to completion in 318s and found 1 genuine fail, which commit `fcc3a70` fixed the same night. Both were stale by the time the Brain proposed acting on them, and the proposal built on them was rejected 2026-07-28. Also measured while re-verifying: running this suite concurrently with anything that launches Chromium pushes it past 900s and it gets killed — measure it on a quiet box or the number is contention, not signal.)*
- [x] ISC-2: `bun run build` (`tsc`) produces a clean build with no type errors. `bash`.
- [x] ISC-3: `bun run lint` (`eslint src/`) reports no errors — **0 errors / 77 warnings as of 2026-07-25**, under the 150 cap. Regressed earlier the same day to 1 error at `src/cli.ts:1971` (`@typescript-eslint/ban-types`, `Function` as a return type); fixed by giving the compiled-function factory its real signature, `(args: unknown[]) => unknown`. `bash`.
- [x] ISC-4: `cbrowser doctor` reports the environment is correctly set up (chromium installed, config valid) — `node dist/cli.js doctor` exits 0 and prints "All checks passed" (verified 2026-07-26).
- [ ] ISC-5: cognitive-effort scoring returns a cognitive transport score in [0,1] **and** an abandonment-risk percentage. **Split 2026-07-28** — the old probe invoked `node dist/cli.js cognitive-effort`, and that CLI verb does not exist (the only `cognitive-*` verb is `cognitive-journey`; the capability ships as an MCP tool). So the probe could only ever fail, and it drove a Brain agency proposal to "fix cbrowser" against a defect that was never in the product. Parent retained for ID stability; see ISC-5.1 / ISC-5.2.
- [x] ISC-5.1: the `cognitive_effort` tool is exposed by the hosted enterprise MCP — `curl -s -X POST http://127.0.0.1:3100/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -c '"cognitive_effort"'` returns ≥1. Verified 2026-07-28.
- [DEFERRED-VERIFY] ISC-5.2: a real `tools/call` to `cognitive_effort` returns `score ∈ [0,1]` plus an abandonment-risk percentage — needs a VALID `cbk_` customer key, which this box does not hold. The key embedded in this ISA is expired (:3100 answers `{"error":"Unauthorized","message":"Invalid or expired API key"}`; :3000 requires auth on every call). Follow-up: re-run with a live key before claiming the score-range half.
- [x] ISC-6: the local MCP server (`node dist/mcp-server.js`) advertises **72 tools** on `tools/list`, with zero duplicates, zero missing descriptions, zero non-JSON-Schema `inputSchema`, and zero non-JSON-RPC bytes on stdout — `node scripts/probe-mcp-tools.mjs --expect 72`. *(Corrected 2026-07-26: this criterion previously claimed 120, which was never true of the local server — 120/122/125 are the HOSTED counts. The old probe string was the literal word `bash`, so it had never been measured. Served counts on 2026-07-26: local stdio 72, hosted demo :3000 122, hosted enterprise :3100 125.)*
- [x] ISC-7: the remote MCP `/health` returns 200 and advertises `api_key` auth — `curl -sf http://127.0.0.1:3000/health | grep -q '"api_key":true'`.
- [x] ISC-8: `--json-output` on a core command emits valid, parseable JSON and never zero bytes — `node dist/cli.js navigate file://$PWD/tests/fixtures/static.html --json-output | python3 -c 'import sys,json;json.load(sys.stdin)'`. *(Was 0 bytes + exit 0 before the 2026-07-26 fix; see Decisions.)*
- [x] Anti-ISC-9: basic commands (navigate/screenshot/click/extract/explore) run **without** an Anthropic API key (keyless-basics invariant) — `env -u ANTHROPIC_API_KEY node dist/cli.js navigate file://$PWD/tests/fixtures/static.html` exits 0 (verified 2026-07-26).
- [x] Anti-ISC-10: no cognitive-journey command silently runs without a key — it fails with a KEY-SPECIFIC message, not a confusing empty result — `env -u ANTHROPIC_API_KEY CBROWSER_DATA_DIR=$(mktemp -d) node dist/cli.js cognitive-journey --start https://example.com --goal "sign up" --persona first-timer 2>&1 | grep -q "require an Anthropic API key"`. Verified 2026-07-28: emits `"Cognitive journeys require an Anthropic API key. How would you like to proceed?"`, exit 1. *(Rewritten 2026-07-28. The old probe was `! … cognitive-effort …` — a verb that does not exist, so the negation succeeded because the command was unknown, never because a key check fired. A vacuous pass, the same shape as the unquoted-assertion defect fixed in 18.73.2. Two further traps this probe has to dodge: `env -u ANTHROPIC_API_KEY` alone is NOT keyless, because `~/.cbrowser/config.json` holds an `anthropicApiKey` that the CLI still reads — hence `CBROWSER_DATA_DIR`; and on this headless box a bare run dies on "Missing X server or $DISPLAY" first, so asserting on exit code alone would also pass for the wrong reason. Grep the key-specific string.)*
- [ ] ISC-13: the hosted MCP servers reject an unrecognised account key — `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3100/mcp -H 'Authorization: Bearer cbk_x' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"status","arguments":{}}}'` returns 401, not 200. **Currently 200 in production** — the source fix landed 2026-07-26 but is not deployed; see Decisions.
- [ ] ISC-14: the version served by the hosted MCP `/health` equals the version of the `cbrowser` package it loads — `curl -s http://127.0.0.1:3000/health | jq -r .version` == `node -p "require('./package.json').version"`. **Currently 18.72.3 vs 18.72.6**; see Decisions.
- [x] ISC-11: The scoring engine is regression-pinned — `bun test tests/golden` exits 0 (8 golden fixtures deep-equal their pinned CIFScores + 5 fast-check properties: determinism, [0,100] bounds, 3 monotonicity invariants; runs with no network/browser/key).
- [x] ISC-12: Journeys are traceable + replayable — `bun test tests/journey-trace.test.ts` exits 0 (per-step JSONL traces, sha256-hashed page state, secret/HTML redaction, LLM-free deterministic step replay with divergence detection).

## Test Strategy

| ISC | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| ISC-1 | test | `bun test` | 0 fail | bun-test |
| ISC-2 | build | `bun run build` (`tsc`) | 0 type errors | bash |
| ISC-3 | lint | `bun run lint` (`eslint src/`) | 0 errors | bash |
| ISC-4 | smoke | `cbrowser doctor` | reports OK | bash |
| ISC-5 | behaviour | *(split — see ISC-5.1 / ISC-5.2)* | — | — |
| ISC-5.1 | behaviour | `tools/list` on :3100 lists `cognitive_effort` | ≥1 match | bash |
| ISC-5.2 | behaviour | `tools/call` cognitive_effort with a valid cbk_ key | score∈[0,1] + risk% | bash+json |
| ISC-6 | contract | MCP `tools/list` count | == 120 | bash |
| ISC-7 | health | remote MCP `/health` | 200 + auth advertised | curl |
| ISC-8 | contract | `--json-output` | valid stable JSON | bash+json |
| Anti-ISC-9 | invariant | basic cmd, no key | succeeds | bash |
| Anti-ISC-10 | invariant | journey cmd, no key | fails loudly | bash |
| ISC-11 | regression | `bun test tests/golden` | 0 fail | bun-test |
| ISC-12 | replay | `bun test tests/journey-trace.test.ts` | 0 fail | bun-test |

## Features

Mapped to real `src/` modules (satisfying ISCs the owner should refine):

| name | description | src evidence |
|------|-------------|--------------|
| Cognitive transport chain | 6-layer cognitive-effort scoring per persona | `cognitive/`, `cif-score.ts`, `trait-reference.ts` |
| User simulation / personas | 26 traits, 11 personas, questionnaire-built personas | `personas.ts`, `agent-personas.ts`, `persona-questionnaire.ts` |
| AI friendliness | agent-ready / webmcp / llms.txt readiness | `analysis/`, `llms-txt/`, `mcp-tools/` |
| Golden scoring harness | pins `computeCIFScore` in CI — score drift fails the build | `tests/golden/` (fixtures, pins, fast-check properties) |
| Journey traces + replay | decision-provider seam; opt-in per-step traces; LLM-free deterministic replay | `cognitive/journey-trace.ts`, `tests/journey-trace.test.ts` |
| Audit salvage (worker) | checkpoint/retry-once so failed audits stop refunding completed work; partial-charge flag default OFF | lives in `cbrowser-web/cms/audit-salvage.ts` (worker repo) |
| Accessibility empathy | disability-persona barrier detection | `analysis/`, `values/` |
| Constitutional safety | MCP tool-injection scanning, guardrails | `security/`, `mcp-guardian` dep |
| Site knowledge | site model / profiles / ideal-profile gaps | `site-model/`, `ideal-profiles*.ts` |
| Visual + NL testing | overlays, attention, natural-language tests | `visual/`, `testing/` |
| Browser + stealth + geo | engine, stealth, geo-proxy, daemon | `browser/`, `stealth/`, `geo-proxy.ts`, `daemon.ts` |
| CLI + MCP server | `cbrowser` CLI + local/remote MCP (120 tools) | `cli.ts`, `mcp-server.ts`, `mcp-server-remote.ts` |

## Decisions

- **2026-07-13** — Authored by deepening the codebase prebuild with README + `package.json` + `src/` + cbrowser-web product evidence, rather than the thin auto-draft alone. `source: hand-authored`. Scoped to the core `cbrowser` package; web + enterprise are sibling repos declared Out of Scope.
- **2026-07-13** — `bun test` run during authoring surfaced **5 failing tests** (311 total). ISC-1 is deliberately left unchecked and flagged rather than assumed green — the ISA's job is to name the real current-state gap. First actionable item for the owner: get to 0 failures.
- **2026-07-13** — Behavioural ISCs (4–10) are marked **(candidate)**: grounded in documented capabilities but not yet wired to exact probes/contracts, which need the owner's knowledge of the CLI/MCP output shapes.
- **2026-07-28** — **Probe reconciliation #2, and the first one where a probe was wrong about the product rather than about itself.** The Praxis brain raised agency proposal `prop-1785238200992` ("draft a fix for cbrowser: 2 failing probes, 1 REFUTED claim, 664 cr at risk"). **Rejected** — neither finding was a live product defect.
  - `ISC-1` REFUTED from the 2026-07-27T21:28 sweep: that run completed in 318s (inside the 600s budget, so not a timeout) and found 1 genuine failure — which `fcc3a70` fixed the same night. Re-measured today on a quiet box: **636 pass / 0 fail, 259s, v18.73.2**. An earlier attempt at that measurement was itself killed at 900s because Chromium-launching probes were running alongside it; a contended number is not a measurement.
  - `ISC-5` failing: its probe invoked `node dist/cli.js cognitive-effort`, **a verb that does not exist and appears never to have**. The capability ships as the MCP tool `cognitive_effort`. The probe could only ever fail, so the proposal regenerated off a defect that was never in the product. Split into ISC-5.1 (exposure, verified) and ISC-5.2 (score range, `[DEFERRED-VERIFY]` — needs a valid `cbk_` key; the one embedded in this ISA is expired).
  - Class-swept the same verb: `Anti-ISC-10` also negated `cognitive-effort`, so `! <unknown command>` succeeded and the anti-criterion passed **vacuously** — the same shape as the unquoted-assertion defect fixed in 18.73.2. Rewritten against `cognitive-journey` and greps for the key-specific string, because two other things would otherwise make it pass for the wrong reason: `env -u ANTHROPIC_API_KEY` is not keyless (`~/.cbrowser/config.json` holds a key, hence `CBROWSER_DATA_DIR`), and a headless run dies on "Missing X server" before any key check.
  - Standing lesson: a probe that cannot pass generates an infinite supply of agency proposals. Rejecting the proposal without fixing the probe would have produced the same proposal tomorrow.
  - Noted, not acted on: `tools/list` on :3100 returns the full enterprise tool catalog with a bogus key **or no auth header at all** — only `tools/call` is gated. May be deliberate (clients enumerate before auth), but worth a decision given the 2026-07-26 auth-bypass finding on the same server.
- **2026-07-25** — Probe reconciliation. The Praxis brain reported `cbrowser::ISC-1` and `cbrowser::ISC-3` as failing + REFUTED. Re-run by hand: ISC-1 is GREEN (570 pass / 0 fail, 257s) so that refutation is FALSE, most likely the probe timing out on a suite that got 72% longer since the claim was written. ISC-3 is a TRUE refutation — one new eslint error in `src/cli.ts:1971`. Unchecked accordingly rather than left claiming green.
- **2026-07-25** — Audit-worker preflight added at `cbrowser-web/cms/audit-preflight.ts` (sibling repo, not this package). It probes every Claude model ID reachable from THIS package's `src/` and `dist/` against the live Messages API, so a retired model can no longer 404 a paid cognitive journey undetected — the 2026-07-19 `claude-sonnet-4-20250514` incident. Consequence for this repo: adding a model ID to a new code path is automatically covered, but pinning one via the `ANTHROPIC_MODEL` env var or `config.json anthropicModel` bypasses a code scan, which is why the preflight resolves those two at runtime as well.

- **2026-07-26** — **The candidate ISCs were never probed at all.** ISC-4, ISC-5, ISC-8, Anti-ISC-9 and Anti-ISC-10 each ended with a backticked `` `bash` `` naming the probe *type*; the ISA probe runner treats the first runnable backtick span as the probe *command*, so it executed the literal word `bash`. Bash with no arguments and a closed stdin exits 0, so all five reported `status: pass, exit: 0` in `isa-probe.jsonl` on every run since 2026-07-14 without checking anything. Bare `curl` exits 2, which is where the earlier fake `ISC-7 fail` record came from. A sweep across all 24 ISAs on the box found 19 probes of this shape out of 154 — 8 of them on criteria already marked `[x]`. Fixed upstream in `PRAXIS/TOOLS/IsaProbe.ts` (a bare command head, and a whitespace-free alternation, are no longer "runnable"; they route to `manual`), and the five criteria here were given real commands.
- **2026-07-26** — ISC-6's tool count was wrong, not just unverified. It claimed the local `dist/mcp-server.js` advertises 120 tools; it advertises **72**. The 120/122/125 figures in the README, this ISA, the shipped skill and PROJECTS.md describe the HOSTED servers (demo :3000 serves 122, enterprise :3100 serves 125). Added `scripts/probe-mcp-tools.mjs` as the real probe — it drives the server over stdio and exits 1 on a wrong count, a duplicate name, a missing description, a non-JSON-Schema `inputSchema`, or any non-JSON-RPC byte on stdout. Shown going red against `--expect 120` before being trusted green against `--expect 72`.
- **2026-07-26** — **`--json-output` produced zero bytes and exit 0 on essentially every command.** `installOutputWrappers()` set `console.log = () => {}` in JSON mode under a comment claiming the output was "captured for JSON", but nothing captured it, and only 2 call sites in a ~140-command CLI ever call `emitJson`. Measured: `navigate <file-url>` printed 294 bytes normally and 0 bytes with `--json-output`. A CI step piping to `jq` saw empty stdin beside a success exit code, which reads as a clean pass — and this contradicted the Principle in this ISA that the accessibility flags "must keep every command usable for screen readers, CI, and scripting". Fixed in `src/output.ts` + `src/cli.ts`: JSON mode now captures console.log, and a `process.on("exit")` hook emits a fallback envelope when no command called `emitJson`, so stdout in JSON mode is always parseable JSON and never empty. Re-probed on the rebuilt CLI: 577 bytes of valid JSON. Regression cover in `tests/json-output-contract.test.ts`.
- **2026-07-26** — Related, unfixed: unknown flags are silently ignored. `navigate <url> --totally-bogus-flag` and `--jsonx` both exit 0 with normal output, and `--json` (documented as "Always print JSON") prints human text on `navigate`. A typo'd flag therefore looks like it worked. Left open deliberately — rejecting unknown flags is a behaviour change across ~140 commands and belongs in its own task, not folded into an audit.
- **2026-07-26** — **Authentication bypass on the hosted enterprise MCP (ISC-13).** `validateAuth` authenticated with `const tier = await resolveApiKeyTier(rawKey); if (tier) return { valid: true };`, and `resolveApiKeyTier` returns the string `"free"` on all three failure paths (key unknown, CMS non-2xx, CMS unreachable). `"free"` is truthy, so every string beginning `cbk_` authenticated and the `valid: false` line beneath that call was unreachable code. Probed live: `Authorization: Bearer cbk_x` against `enterprise.cbrowser.ai` returned HTTP 200 and performed a real browser navigation; non-`cbk_` tokens correctly 401'd — the prefix was the entire check. Fixed by separating identity from pricing: new `validateAccountKey` enumerates `unknown_key` / `backend_unreachable` / `not_an_account_key` explicitly and fails CLOSED on a CMS outage; `resolveApiKeyTier` keeps its `"free"` fallback for *billing* only, which is safe because it runs after authentication. Regression cover in `tests/remote-auth.test.ts`, shown red (4 failures) against the old semantics before being trusted green. **Not yet deployed** — the running processes still carry the bypass.
- **2026-07-26** — **Deploy drift (ISC-14): the hosted servers have been serving 18.72.3 since 2026-07-20.** `cbrowser-demo` (:3000) and `cbrowser-enterprise` (:3100) both started `Mon Jul 20 19:16` with `NRestarts=0`, while `cbrowser-enterprise/node_modules/cbrowser` is a symlink to this repo at 18.72.6. So three shipped fixes are on disk and not live: 18.72.4 (`X-Internal-Secret` on CMS credits/deduct — the "denied with reason undefined" bug), 18.72.5 (request-scoped billing identity + usage-log auth), and the CLI compiled-function signature. Additionally, the live servers emit raw Zod objects instead of JSON Schema for 17 of 122 tools on :3000 and 14 of 125 on :3100 (`_def`, `~standard`, `_cached` on the wire) — the same on-disk build run on a spare port serves 122 tools with **0** broken schemas, so that too is purely a stale-process artefact. The 2026-04 note that restarting `cbrowser-demo` regresses the live demo is **stale**: both units run from `cbrowser-enterprise`, whose `node_modules/cbrowser` now symlinks to this repo, so a restart upgrades. Restart deferred — it is production-impacting and needs the owner's go-ahead.
- **2026-07-25** — ISC-3 closed. `src/cli.ts` typed its in-page compiled-function factory as the bare `Function`, which accepts any callable and checks no call site — including a class, which throws at runtime when invoked without `new`. Replaced with the real signature, `(args: unknown[]) => unknown`. Types erase, so `dist/cli.js` is byte-identical around the change; all three compile shapes were exercised live against the built CLI anyway (`({a:1}).a` → 1, `const x = 21; x * 2` → 42, `const y = 3; return y + 4;` → 7). Suite 570/0.
