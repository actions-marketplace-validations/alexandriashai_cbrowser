#!/bin/bash
# Kill chrome-headless-shell processes older than 5 minutes
# that aren't attached to an active session
# Runs via systemd timer every 2 minutes

MAX_AGE_SECONDS=300  # 5 minutes

KILLED=0
for pid in $(pgrep -f "chrome-headless-shell" 2>/dev/null); do
    # Get process age in seconds
    AGE=$(ps -p "$pid" -o etimes= 2>/dev/null | tr -d ' ')
    if [ -n "$AGE" ] && [ "$AGE" -gt "$MAX_AGE_SECONDS" ]; then
        kill -9 "$pid" 2>/dev/null && KILLED=$((KILLED + 1))
    fi
done

if [ "$KILLED" -gt 0 ]; then
    echo "$(date): Killed $KILLED orphaned Chrome processes (age > ${MAX_AGE_SECONDS}s)"
fi
