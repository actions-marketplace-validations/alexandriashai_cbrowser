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

# 2026-08-04: the threshold moved, so the isolation list grew.
#
# Adding three small, pure test files to pass 1 (attention calibration, blend
# weight, agent-ready blocked-page) turned CI red -- not because those files are
# slow, but because pass 1 was already sitting just under whatever the
# exhausting resource is. The recording files went first: fifteen "timed out
# after 60000ms" failures at exactly 60-second intervals, which is ONE hung
# browser launch reported fifteen times, not fifteen broken tests.
#
# Evidence this is the same accumulation the script was written for, and NOT the
# new code:
#
#   recording-engine alone ....................... 45 pass / 0 fail
#   recording-change-tiers alone ................. 12 pass / 0 fail
#   the two together ............................. hangs, every run
#   the two together at the commit BEFORE the new
#     files existed (worktree at b83c996) ........ hangs, every run
#
# The last line is the one that matters: the union already hung before any of
# this release's changes. The new files did not introduce the bug, they consumed
# the remaining headroom.
#
# Still bounding a symptom, still not naming a cause. Every file listed here
# launches real browsers per test. If the real cause is ever found, delete this.
ISOLATED_FILES=(
  "tests/cli-evaluate-keyboard.test.ts"
  "tests/recording-engine.test.ts"
  "tests/recording-change-tiers.test.ts"
  # Launches its own chromium. Added 2026-08-05 after it landed in the shared
  # pass and pushed tests/svg-classname.test.ts -- which also launches one --
  # into five 5001ms timeouts. Both pass alone in under a second, so the
  # failure was contention between them, not a defect in either. Same headroom
  # story as the note above: one more browser was one too many.
  #
  # Any new test file calling chromium.launch() belongs in this list.
  "tests/sticky-overlay-threshold.test.ts"
  "tests/freeze-animations.test.ts"
  "tests/alt-attribute-classification.test.ts"
)

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

# Every isolated file must be discovered. The guard is per-file and still fails
# loudly: silently skipping one is how a suite goes green while a file stops
# being tested, and that risk grows with the size of this list.
REST=()
for f in "${ALL[@]}"; do
  keep=1
  for iso in "${ISOLATED_FILES[@]}"; do
    if [ "$f" = "$iso" ]; then keep=0; break; fi
  done
  if [ "$keep" -eq 1 ]; then REST+=("$f"); fi
done

for iso in "${ISOLATED_FILES[@]}"; do
  found=0
  for f in "${ALL[@]}"; do
    if [ "$f" = "$iso" ]; then found=1; break; fi
  done
  if [ "$found" -ne 1 ]; then
    echo "test-split: '$iso' was not discovered — it moved or was renamed." >&2
    echo "            Refusing to run, because silently skipping it is how a suite" >&2
    echo "            goes green while a file stops being tested." >&2
    exit 1
  fi
done

echo "test-split: ${#ALL[@]} test files discovered — ${#REST[@]} in pass 1, ${#ISOLATED_FILES[@]} isolated"
bun test "${REST[@]}"
# Each isolated file gets its OWN process. Running them as one `bun test` with
# several arguments would recreate the union that hangs.
for iso in "${ISOLATED_FILES[@]}"; do
  echo "test-split: isolated run — $iso"
  bun test "$iso"
done
