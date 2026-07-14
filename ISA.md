---
task: "cbrowser — cognitive browser automation"
slug: cbrowser
effort: advanced
effort_source: explicit
phase: observe
progress: 0/10
mode: iterate
started: 2026-07-13T20:39:10Z
updated: 2026-07-13T20:41:00Z
source: hand-authored
---

# cbrowser — Project ISA

> Deepened from the `IsaFromCodebase.ts` prebuild with evidence from the repo README,
> `package.json`, `src/` structure, and the cbrowser-web product site. Scope: the core
> npm package `cbrowser` (this repo). Behavioural ISCs below marked **(candidate)** are
> drawn from documented capabilities but need the owner to confirm the exact probe/contract.
> **Current state is NOT green — `bun test` has 5 failures (see ISC-1).**

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

- [ ] ISC-1: `bun test` reports **0 failures**. **CURRENTLY FAILING — 5 fail / 311 tests (17 files) as of 2026-07-13.** `bun-test`.
- [ ] ISC-2: `bun run build` (`tsc`) produces a clean build with no type errors. `bash`.
- [ ] ISC-3: `bun run lint` (`eslint src/`) reports no errors. `bash`.
- [ ] ISC-4 (candidate): `cbrowser doctor` reports the environment is correctly set up (chromium installed, config valid). `bash`.
- [ ] ISC-5 (candidate): `cbrowser cognitive-effort --url <site> --persona first-timer` returns a cognitive transport score in [0,1] **and** an abandonment-risk percentage. `bash` + JSON assert.
- [ ] ISC-6 (candidate): the MCP server (`node dist/mcp-server.js`) advertises **120 tools** on `tools/list`. `bash` + count.
- [x] ISC-7 (candidate): the remote MCP `/health` returns 200 and advertises `api_key` auth — `curl -sf http://127.0.0.1:3000/health | grep -q '"api_key":true'`.
- [ ] ISC-8 (candidate): `--json-output` on a core command emits valid, schema-stable JSON (screen-reader / CI contract). `bash` + JSON parse.
- [ ] Anti-ISC-9 (candidate): basic commands (navigate/screenshot/click/extract/explore) run **without** an Anthropic API key (keyless-basics invariant). `bash`.
- [ ] Anti-ISC-10 (candidate): no cognitive-journey command silently runs without a key (fails loudly instead of a confusing empty result). `bash`.

## Test Strategy

| ISC | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| ISC-1 | test | `bun test` | 0 fail | bun-test |
| ISC-2 | build | `bun run build` (`tsc`) | 0 type errors | bash |
| ISC-3 | lint | `bun run lint` (`eslint src/`) | 0 errors | bash |
| ISC-4 | smoke | `cbrowser doctor` | reports OK | bash |
| ISC-5 | behaviour | `cbrowser cognitive-effort …` | score∈[0,1] + risk% | bash+json |
| ISC-6 | contract | MCP `tools/list` count | == 120 | bash |
| ISC-7 | health | remote MCP `/health` | 200 + auth advertised | curl |
| ISC-8 | contract | `--json-output` | valid stable JSON | bash+json |
| Anti-ISC-9 | invariant | basic cmd, no key | succeeds | bash |
| Anti-ISC-10 | invariant | journey cmd, no key | fails loudly | bash |

## Features

Mapped to real `src/` modules (satisfying ISCs the owner should refine):

| name | description | src evidence |
|------|-------------|--------------|
| Cognitive transport chain | 6-layer cognitive-effort scoring per persona | `cognitive/`, `cif-score.ts`, `trait-reference.ts` |
| User simulation / personas | 26 traits, 11 personas, questionnaire-built personas | `personas.ts`, `agent-personas.ts`, `persona-questionnaire.ts` |
| AI friendliness | agent-ready / webmcp / llms.txt readiness | `analysis/`, `llms-txt/`, `mcp-tools/` |
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
