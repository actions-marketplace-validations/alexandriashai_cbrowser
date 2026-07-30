#!/usr/bin/env bash
# Run the suite in two processes, isolating the browser-heavy file.
#
# WHY (measured 2026-07-27, not inferred):
#
#   all files EXCEPT cli-evaluate-keyboard ...... 502 pass / 0 fail
#   cli-evaluate-keyboard.test.ts alone ......... 34 pass / 0 fail
#   everything in ONE `bun test` ................ 1 fail, every run
#
# Only the union fails, and WHICH test times out is random — four different ones
# across five runs — always at exactly 60000ms. That file launches a real Chrome
# per test, 34 of them, and something accumulates across a long-lived `bun test`
# process until a launch hangs.
#
# THIS BOUNDS A SYMPTOM. It does not name a cause. The exhausting resource is
# still unidentified; seven hypotheses were falsified getting here (probe budget,
# event-loop starvation, Chrome SingletonLock, parallel contention — the suite is
# sequential — the wedged capture in recording-autocapture, a single culprit
# predecessor, and an arbitrary process split). If the real cause is found, delete
# this and fix that.
#
# DISCOVERY, NOT A HAND-WRITTEN LIST. Test files live in three places (tests/,
# tests/golden/, src/visual/). Enumerating them by hand would silently drop the
# ones outside tests/ the next time a file moves — so the list is discovered, and
# the guard below fails loudly rather than quietly skipping.
set -euo pipefail

ISOLATED="tests/cli-evaluate-keyboard.test.ts"

# Match what `bun test` itself discovers, not a narrower guess. A first version
# looked only for *.test.ts and silently dropped dist/security/audit-wrapper.test.js
# — 14 tests, 609 -> 595, a coverage loss that reported "0 fail" and looked like a
# clean pass. Preserving the exact prior set keeps this change to ONE thing: the
# process split.
#
# (Those 14 tests are ORPHANED — dist/ is gitignored build output and no
# corresponding source file exists, so they would vanish on `rm -rf dist` and are
# not in version control. That is worth fixing separately; it is not this
# script's business to decide.)
mapfile -t ALL < <(find . \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.spec.ts' \) -not -path './node_modules/*' | sed 's|^\./||' | sort)

if [ "${#ALL[@]}" -eq 0 ]; then
  echo "test-split: discovered NO test files — refusing to report success" >&2
  exit 1
fi

found=0
REST=()
for f in "${ALL[@]}"; do
  if [ "$f" = "$ISOLATED" ]; then found=1; else REST+=("$f"); fi
done

if [ "$found" -ne 1 ]; then
  echo "test-split: '$ISOLATED' was not discovered — it moved or was renamed." >&2
  echo "            Refusing to run, because silently skipping it is how a suite" >&2
  echo "            goes green while a file stops being tested." >&2
  exit 1
fi

echo "test-split: ${#ALL[@]} test files discovered — ${#REST[@]} in pass 1, 1 isolated"
bun test "${REST[@]}"
bun test "$ISOLATED"
