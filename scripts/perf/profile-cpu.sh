#!/usr/bin/env bash
# CPU-profile a harness scenario and print the hottest functions.
#   scripts/perf/profile-cpu.sh <scenario> [seconds] [topN]
set -euo pipefail
cd "$(dirname "$0")/../../packages/cosignal"
SCENARIO="${1:-steady}"
SECONDS_ARG="${2:-10}"
TOPN="${3:-20}"
DIR=$(mktemp -d)
node --cpu-prof --cpu-prof-dir="$DIR" perf/harness.ts "$SCENARIO" "$SECONDS_ARG"
PROF=$(ls "$DIR"/*.cpuprofile | head -1)
node ../../scripts/perf/summarize-cpuprofile.mjs "$PROF" "$TOPN"
echo "profile: $PROF"
