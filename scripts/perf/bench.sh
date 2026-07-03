#!/usr/bin/env bash
# Run the js-reactivity-benchmark suite N times for react-signals (+forked,
# +alien-signals reference), aggregate best-of-N per test, and diff against a
# stored baseline.
#   scripts/perf/bench.sh [repeats] [baseline.csv]
# Writes results to notes/perf/latest.csv. To set a new baseline:
#   cp notes/perf/latest.csv notes/perf/baseline.csv
set -euo pipefail
REPEATS="${1:-3}"
BASELINE="${2:-notes/perf/baseline.csv}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/vendor/js-reactivity-benchmark"

TMP=$(mktemp -d)
for i in $(seq 1 "$REPEATS"); do
  echo "run $i/$REPEATS..." >&2
  pnpm --silent bench > "$TMP/run$i.txt" 2>&1 || true
done

node - "$TMP" "$REPEATS" <<'JS' > "$ROOT/notes/perf/latest.csv"
const { readFileSync } = require('node:fs');
const [dir, repeats] = process.argv.slice(2);
const best = new Map();
for (let i = 1; i <= Number(repeats); i++) {
  const lines = readFileSync(`${dir}/run${i}.txt`, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^(\S[^,]*?)\s*,\s*(.+?)\s*,\s*([\d.]+)\s*$/);
    if (!m) continue;
    const key = `${m[1].trim()},${m[2].trim()}`;
    const t = Number(m[3]);
    if (!best.has(key) || t < best.get(key)) best.set(key, t);
  }
}
for (const [key, t] of best) console.log(`${key},${t}`);
JS

echo "--- best-of-$REPEATS written to notes/perf/latest.csv" >&2
if [ -f "$ROOT/$BASELINE" ]; then
  node - "$ROOT/$BASELINE" "$ROOT/notes/perf/latest.csv" <<'JS' >&2
const { readFileSync } = require('node:fs');
const parse = (f) => new Map(readFileSync(f, 'utf8').trim().split('\n').map((l) => {
  const i = l.lastIndexOf(',');
  return [l.slice(0, i), Number(l.slice(i + 1))];
}));
const base = parse(process.argv[2]);
const now = parse(process.argv[3]);
console.log('delta vs baseline (negative = faster):');
let worse = 0;
for (const [key, t] of now) {
  const b = base.get(key);
  if (b === undefined) continue;
  const delta = ((t - b) / b) * 100;
  const flag = delta > 5 ? ' <-- REGRESSION?' : '';
  if (delta > 5) worse++;
  console.log(`${delta >= 0 ? '+' : ''}${delta.toFixed(1).padStart(6)}%  ${key}  (${b} -> ${t})${flag}`);
}
process.exitCode = 0;
JS
else
  echo "(no baseline at $BASELINE; cp notes/perf/latest.csv there to set one)" >&2
fi
