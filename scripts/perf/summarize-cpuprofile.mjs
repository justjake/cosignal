// Summarize a .cpuprofile: self time per function, top N.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const topN = Number(process.argv[3] ?? '20');
const profile = JSON.parse(readFileSync(file, 'utf8'));

const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const selfMicros = new Map();
const samples = profile.samples;
const deltas = profile.timeDeltas;
for (let i = 0; i < samples.length; i++) {
  const id = samples[i];
  selfMicros.set(id, (selfMicros.get(id) ?? 0) + (deltas[i] ?? 0));
}
const rows = [];
let total = 0;
for (const [id, micros] of selfMicros) {
  const node = nodes.get(id);
  if (!node) continue;
  const f = node.callFrame;
  const name = f.functionName || '(anonymous)';
  const url = (f.url || '').replace(/^.*\/(packages|node_modules)\//, '$1/');
  rows.push({ name, where: url ? `${url}:${f.lineNumber + 1}` : '', micros });
  total += micros;
}
rows.sort((a, b) => b.micros - a.micros);
console.log(`total sampled: ${(total / 1000).toFixed(0)}ms`);
for (const r of rows.slice(0, topN)) {
  const pct = ((r.micros / total) * 100).toFixed(1).padStart(5);
  console.log(`${pct}%  ${(r.micros / 1000).toFixed(0).padStart(7)}ms  ${r.name}  ${r.where}`);
}
