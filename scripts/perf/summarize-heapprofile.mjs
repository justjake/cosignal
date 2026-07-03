// Summarize a .heapprofile (sampling heap profiler): total sampled bytes per
// allocating function, top N.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const topN = Number(process.argv[3] ?? '20');
const profile = JSON.parse(readFileSync(file, 'utf8'));

const rows = new Map();
let total = 0;
function walk(node) {
  const f = node.callFrame;
  let self = 0;
  for (const s of node.selfSize !== undefined ? [node.selfSize] : []) self += s;
  if (self > 0) {
    const name = f.functionName || '(anonymous)';
    const url = (f.url || '').replace(/^.*\/(packages|node_modules)\//, '$1/');
    const key = `${name}  ${url ? `${url}:${f.lineNumber + 1}` : ''}`;
    rows.set(key, (rows.get(key) ?? 0) + self);
    total += self;
  }
  for (const child of node.children ?? []) walk(child);
}
walk(profile.head);
const sorted = [...rows.entries()].sort((a, b) => b[1] - a[1]);
console.log(`total sampled allocations: ${(total / 1024 / 1024).toFixed(1)}MB`);
for (const [key, bytes] of sorted.slice(0, topN)) {
  const pct = ((bytes / total) * 100).toFixed(1).padStart(5);
  console.log(`${pct}%  ${(bytes / 1024 / 1024).toFixed(1).padStart(8)}MB  ${key}`);
}
