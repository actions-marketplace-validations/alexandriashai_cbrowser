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
  # Added 2026-08-11, after CI went red on the FIRST run of this script in the
  # Tests workflow: recording-autocapture hit exactly 180000.96ms in pass 1.
  #
  # That is the same hang test-gate.sh documents, and the two scripts disagreed
  # about it. The gate QUARANTINES seven files; this list isolated three of
  # them, so the other four ran in the shared pass -- and one hung, on the
  # machine where it mattered. It passed locally, because this box is fast
  # enough to hide it. CI is the machine that decides.
  #
  # Isolated rather than skipped: the gate excludes these from its pass, this
  # script still RUNS them, each in its own process. That keeps the property
  # that the split covers more than the gate does.
  "tests/recording-autocapture.test.ts"
  "tests/recording-journey-capture.test.ts"
  "tests/recording-mcp-session.test.ts"
  "tests/recording-pure.test.ts"
)

# Match what `bun test` itself discovers, MINUS build output.
#
# The note that used to sit here said dist/security/audit-wrapper.test.js was
# orphaned and worth fixing separately. Measured 2026-08-11, it is worse than
# orphaned -- it is a STALE DUPLICATE:
#
#   - its 14 test names are identical to tests/audit-wrapper.test.ts
#   - it is the compiled output of src/security/audit-wrapper.test.ts, a path
#     that no longer exists; the test moved to tests/ and the build output was
#     never cleaned up
#   - tsconfig now excludes src/**/*.test.ts, so no current build regenerates
#     it. It cannot be refreshed, only re-run stale.
#   - dist/ is gitignored, so it runs here and does NOT exist on CI. That is
#     the entire 1298-vs-1284 gap between this box and the runner.
#
# So the suite was running 14 assertions twice, one copy compiled from a source
# file that is gone, and reporting the doubled number as coverage. Excluding
# build output loses nothing: tests/audit-wrapper.test.ts is still discovered
# and still runs all 14.
#
# test-gate.sh never had this problem -- it searches `tests src` rather than
# `.`. The gate was right and this script was wrong, the same way the two
# disagreed about the quarantine list.
mapfile -t ALL < <(find . \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.spec.ts' \) -not -path './node_modules/*' -not -path './dist/*' | sed 's|^\./||' | sort)

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

# Pass 1 gets NO retry. These are ordinary deterministic tests; a retry here
# would hide a real regression.
bun test "${REST[@]}"

# Each isolated file gets its OWN process. Running them as one `bun test` with
# several arguments would recreate the union that hangs.
#
# RETRY ONCE, and loudly (2026-08-12, Alexa's call).
#
# Why these and not pass 1: every file in this list drives a real browser on
# wall-clock timing, and the failure they exhibit is a capture that never
# completes, reported at exactly the test's declared ceiling (180000.96ms,
# 60000.95ms -- the ceiling, to the millisecond, because nothing else bounds
# it). The root cause is NOT known. Eleven hypotheses have been refuted:
# shared data dir, orphaned Chrome, a console.log patch, AbortSignal timeouts,
# bun concurrency, file position, glob discovery, an fd leak, fast-check run
# count, CPU starvation (passes pinned to one core), and missing
# anti-throttling launch args.
#
# What IS known, and what makes a retry the honest response rather than a
# cover-up: the failure is intermittent in ISOLATION, not only in the union.
# CI failed recording-change-tiers in its own process at 194s having passed the
# same file in its own process at 18.7s earlier the same day. So isolation
# alone does not make these deterministic, and a single flake was failing the
# whole job.
#
# A retry that hid the flake rate would be the same silent-degradation defect
# this suite keeps finding in its own product code. So:
#   - the retry is announced when it happens, not after the fact
#   - a file that only passes on retry is listed again in a summary at the end
#   - a file that fails TWICE fails the run
#   - the exit code still reflects reality
RETRIED=()
FAILED=()
for iso in "${ISOLATED_FILES[@]}"; do
  echo "test-split: isolated run — $iso"
  if bun test "$iso"; then
    continue
  fi

  echo "test-split: FLAKE? '$iso' failed. Retrying ONCE." >&2
  echo "            A pass on retry is recorded below, not swallowed." >&2
  if bun test "$iso"; then
    echo "test-split: '$iso' passed on retry — recorded as flaky, not as green." >&2
    RETRIED+=("$iso")
  else
    echo "test-split: '$iso' failed TWICE — this is a real failure, not a flake." >&2
    FAILED+=("$iso")
  fi
done

# The summary exists so "green" and "green after a retry" are never the same
# report. A flake rate you cannot see is a flake rate nobody fixes.
if [ "${#RETRIED[@]}" -gt 0 ]; then
  echo ""
  echo "test-split: ${#RETRIED[@]} file(s) PASSED ONLY ON RETRY:"
  for f in "${RETRIED[@]}"; do echo "              $f"; done
  echo "            The run is green. These are still flaky and still unexplained."
fi

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo ""
  echo "test-split: ${#FAILED[@]} file(s) failed twice:" >&2
  for f in "${FAILED[@]}"; do echo "              $f" >&2; done
  exit 1
fi
