#!/usr/bin/env bash
# Supervisor for fast-lane-v2.
#
# LeadMagic verdict quality decays with PROCESS AGE, not just concurrency or
# socket pooling. Measured 2026-08-11: a worker ~40 min old punted on 48% of
# calls while a fresh curl on the same key in the same second returned clean
# billed verdicts. keepAlive:false does NOT prevent this, and onset got shorter
# (~13 min) as the day's cumulative volume grew. So: run in bounded shifts,
# each a fresh process.
#
# CLEAR=1 (default) wipes untested rows between shifts so they get retried —
#         maximises yield, right for production runs.
# CLEAR=0 keeps them, preserving single-pass semantics — right for MEASUREMENT,
#         because repeatedly re-rolling only the contacts that refuse to resolve
#         biases the reported hit rate upward.
#
# Usage: [CLEAR=0] fast-lane-supervise.sh <run-slug> <csv> [shift-seconds] [target-rows]
set -uo pipefail

RUN="${1:?run slug}"
CSV="${2:?csv path}"
SHIFT="${3:-900}"
TARGET="${4:-0}"
CLEAR="${CLEAR:-1}"

DIR="$HOME/output/list-builder/$RUN"
RESULTS="$DIR/v2-results-leadmagic.jsonl"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/fast-lane-v2.ts"
CLEANER="$HERE/fast-lane-clear-untested.py"
TOTAL=$(( $(wc -l < "$CSV") - 1 ))
[ "$TARGET" -eq 0 ] && TARGET=$TOTAL

shift_no=0
while :; do
  rows=0
  [ -f "$RESULTS" ] && rows=$(wc -l < "$RESULTS" | tr -d ' ')
  if [ "$rows" -ge "$TARGET" ]; then
    echo "[sup] target reached: $rows/$TARGET"
    break
  fi

  shift_no=$((shift_no + 1))
  echo "[sup] shift $shift_no starting ($rows/$TARGET done)"
  npx tsx "$SCRIPT" --run="$RUN" --csv="$CSV" --validator=leadmagic --conc=50 \
      >> "/tmp/fl-sup-$RUN.log" 2>&1 &
  pid=$!
  echo "$pid" > "/tmp/fl-sup-$RUN.pid"

  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$SHIFT" ]; do
    sleep 15
    waited=$((waited + 15))
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "[sup] recycling worker after ${waited}s"
    kill "$pid" 2>/dev/null
    sleep 4
    kill -9 "$pid" 2>/dev/null || true
  else
    echo "[sup] worker exited on its own"
    if [ "$CLEAR" = "0" ]; then
      echo "[sup] single-pass complete"
      break
    fi
  fi

  if [ "$CLEAR" = "1" ]; then
    python3 "$CLEANER" "$RESULTS"
  fi

  now=0
  [ -f "$RESULTS" ] && now=$(wc -l < "$RESULTS" | tr -d ' ')
  if [ "$now" -le "$rows" ] && [ "$shift_no" -gt 2 ]; then
    echo "[sup] no progress this shift ($rows -> $now); remaining set looks intrinsically unverifiable"
    break
  fi
done
echo "[sup] done"
