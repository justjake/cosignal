#!/usr/bin/env bash
# Heap-profile (sampling allocation profiler) a harness scenario.
#   scripts/perf/profile-heap.sh <scenario> [seconds] [topN]
set -euo pipefail
cd "$(dirname "$0")/../../packages/cosignal"
SCENARIO="${1:-steady}"
SECONDS_ARG="${2:-10}"
TOPN="${3:-20}"
DIR=$(mktemp -d)
node --heap-prof --heap-prof-dir="$DIR" perf/harness.ts "$SCENARIO" "$SECONDS_ARG"
PROF=$(ls "$DIR"/*.heapprofile | head -1)
node ../../scripts/perf/summarize-heapprofile.mjs "$PROF" "$TOPN"
echo "profile: $PROF"
