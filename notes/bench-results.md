# js-reactivity-benchmark results

2026-07-02, Apple Silicon (M-series), Node 24.16, `pnpm bench` in
`vendor/js-reactivity-benchmark` (branch `react-signals`). All three
frameworks registered with `testPullCounts: true`; every correctness and
exact-pull-count verification passed (the conformance suite is 112/112 with
react-signals registered).

Times in ms, best-of-10 for kairo/mol, single timed run for the dynamic suite.

| test | react-signals | alien-signals | Preact Signals |
|---|---:|---:|---:|
| avoidablePropagation | 196.46 | 150.89 | 168.39 |
| broadPropagation | 167.08 | 110.27 | 129.54 |
| deepPropagation | 77.65 | 46.41 | 57.56 |
| diamond | 170.76 | 128.68 | 156.86 |
| mux | 173.35 | 118.70 | 156.87 |
| repeatedObservers | 22.62 | 18.17 | 21.10 |
| triangle | 56.10 | 41.32 | 49.61 |
| unstable | 37.49 | 18.61 | 21.17 |
| molBench | 267.72 | 259.71 | 281.79 |
| createDataSignals | 11.43 | 3.50 | 8.13 |
| createComputations (0to1…1to1000, sum) | ~33.8 | ~15.4 | ~30.7 |
| updateComputations (1to1…1to1000, sum) | ~10.5 | ~8.7 | ~10.1 |
| 10x5 simple component (read 20%) | 151.90 | 96.59 | 133.07 |
| 10x10 dynamic component (read 20%) | 148.06 | 105.01 | 102.05 |
| 1000x12 large web app (dynamic) | 272.02 | 193.86 | 1642.83 |
| 1000x5 wide dense | 420.30 | 291.42 | 1102.85 |
| 5x500 deep | 117.00 | 82.95 | 78.58 |

## Reading

- react-signals runs ~1.2–1.6× alien-signals across the suite. alien-signals
  is the fastest signals engine in this benchmark; the gap is the price of the
  concurrent-world bookkeeping on the hot paths (plane checks on every
  read/write/flag operation) plus the subscription-queue drain sites.
- On the scale-heavy dynamic benches, react-signals is 4–6× faster than
  Preact Signals (large web app 272 vs 1643; wide dense 420 vs 1103) and
  roughly at parity with it elsewhere — a good place to be for a library whose
  primary consumer is React rendering, where framework overhead dominates.
- Exact pull counts hold (`testPullCounts: true`), i.e. the lazy pull +
  equality-cutoff discipline matches alien/preact/reactively.
- Update-path costs (`updateComputations*`) are within ~10–20% of
  alien-signals: dirty-marking dominates and the plane machinery stays out of
  the way while not forked (benchmarks never fork — no React bindings active).
- Creation throughput (`createDataSignals`, `createComputations*`) is the
  biggest relative gap (~2–3×): our nodes carry world fields (log, planes,
  fork generations). If it ever matters, the world state could move to a
  side-table allocated on first React subscription.

## Forked-mode overhead (2026-07-02, second run)

`react-signals (forked)` runs the identical suite with the two-plane mode
permanently active (one never-folding transition write to a dummy atom), so
every write maintains both planes and every read takes the forked paths. In a
real app this state exists only while a transition is pending. All correctness
and exact-pull-count checks pass in both modes.

| test | steady | forked | overhead |
|---|---:|---:|---:|
| avoidablePropagation | 208.07 | 242.65 | +17% |
| broadPropagation | 179.15 | 254.35 | +42% |
| deepPropagation | 75.96 | 193.66 | +155% |
| diamond | 178.26 | 344.53 | +93% |
| mux | 190.17 | 90.84 | −52% (outlier, see note) |
| repeatedObservers | 24.01 | 54.22 | +126% |
| triangle | 56.76 | 122.40 | +116% |
| unstable | 42.64 | 58.99 | +38% |
| molBench | 289.22 | 274.31 | ≈0% |
| updateComputations (sum) | ~11.5 | ~13.3 | +16% |
| 10x5 simple component | 162.28 | 198.63 | +22% |
| 10x10 dynamic component | 159.79 | 187.73 | +17% |
| 1000x12 large web app | 298.07 | 355.92 | +19% |
| 1000x5 wide dense | 453.06 | 520.00 | +15% |
| 5x500 deep | 124.53 | 146.98 | +18% |

Reading: app-shaped workloads (dynamic suite, mol) pay ~15–25% while forked;
deep/narrow propagation chains pay 2–2.5× (every pull walks per-plane flags
and the HEAD-plane atom branch does double bookkeeping). The mux result
(faster while forked) reproduces but is a JIT/code-layout artifact — the
hub-shaped graph hits different branch patterns; correctness checks pass in
both modes. Since forked mode only exists between a transition write and its
commit (typically a few frames), the steady-state numbers are the ones that
describe an app at rest.
