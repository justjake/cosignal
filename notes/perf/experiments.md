# Performance experiments log

Method: every attempted optimization gets an entry. Measure with
`scripts/perf/bench.sh 3` (best-of-3 js-reactivity-benchmark) and/or
`scripts/perf/profile-cpu.sh` / `profile-heap.sh` on the harness scenarios
(`packages/react-signals/perf/harness.ts`). An optimization is kept only if
the measured win exceeds run-to-run noise (~±3-5% on the kairo suite,
~±2% on harness ops/s over 10s runs); otherwise it is rolled back, and the
entry records that. Complexity-adding changes need a substantial win.

Baseline hardware: Apple Silicon (M-series), Node 24.16, macOS.

## Reference points

- v1 engine (pre-rewrite, lane-based, best of published runs 2026-07-02):
  steady ≈ alien-signals × 1.2–1.6; forked +15–25% app-shaped, 2–2.5× deep
  chains (notes/bench-results.md).
- v2 rewrite (log-first, tokens, world-keyed computed cache): baseline being
  established — see notes/perf/baseline.csv (best-of-3).
- Harness sanity points (10s runs, v2): steady ~1.32M ops/s,
  handler ~18.1M ops/s with **zero engine allocations** (heap profile
  attributes all sampled bytes to Node bootstrap — the observability gate's
  zero-alloc claim, verified).

## Experiments

(entries below, newest last)
### Experiment A — committed-entry hot pointer + single-pull scan (KEEP)

Hypothesis: v2's `findResult` linear scan on every computed read (plus a
second scan in readComputed after pullComputed) regressed read-heavy benches
vs v1's direct field access.

Change: `ComputedNode.committed` aliases the WORLD_COMMITTED entry (findResult
becomes one identity compare on the hot world); pullComputed returns the
entry, killing the re-scan.

Result (best-of-3 vs v2 baseline): broad −10.6%, triangle −14.1%, diamond
−7.5%, deep −7.0%, large-web-app −11.8%, wide-dense −12.1%, dynamic component
−9.4%; all other deltas within ±5% noise. Forked variant −3% on scale benches.
KEEP — recovers (and beats) the v1→v2 rewrite regression on read paths.

### Experiment B — steady clean-read fast path in pullComputed (ROLLED BACK)

Hypothesis: an early exit for the steady/clean/value case before any plane
bookkeeping would close the remaining gap on read-heavy benches.

Result (best-of-3 vs post-A baseline): steady mean −0.6% (alien-signals
control mean −0.8% in the same runs — i.e., noise), forked mean +1.3% with
scattered real regressions (forked createComputations4to1 +29%). The general
path's plane bookkeeping is already just two ternaries and an identity
compare; the extra branch bought nothing and taxed the forked path.
ROLLED BACK per the "no complexity without measured wins" rule.

### Non-experiments (measured, deliberately not attempted)

- TrackFrame elimination in start/endTracking: heap profiling shows ZERO
  engine allocations in the steady and handler scenarios — V8's escape
  analysis already scalar-replaces the frames. Hand-optimizing would add
  complexity for a provably nonexistent win.

### Experiment C — helper extraction on propagate/link hot paths (KEPT, A/B-validated)

Context: the /simplify elegance pass extracted `isMutedSubscription(sub)`
(used per link visit in propagate/shallowPropagate) and `effectivePlanes(mask)`
(the steady-widens-to-both-planes rule, 5 call sites including readAtom/
readComputed linking). Both sit on benchmarked hot paths, so the extraction
was A/B tested rather than assumed free.

Method: three best-of-3 samples against the stored baseline — two with the
helpers, one with both manually inlined at every call site. alien-signals ran
as the untouched control in all samples.

Result: the inlined variant measured WORSE (large-web-app +9.0% vs +4.1–6.1%
with helpers; wide-dense +10.1% vs +4.4–4.5%; forked app tests flipped from
−5–7% to +1–9%) — but the control degraded in lockstep across successive
samples (control wide-dense drifted −4.8% → +3.9% with zero code change),
i.e. the machine slows under sustained back-to-back bench load. Conclusion:
helper-vs-inline is indistinguishable from thermal drift; V8 inlines both
forms. KEEP the helpers (more readable, provably not slower). The micro
create/updateComputations "regressions" (+20–160%) appear identically in the
control and flip sign between samples — pure noise on sub-3ms tests.

Real, reproducible win from the same pass: createDataSignals −70% steady /
−12–22% forked in every sample (Atom constructor no longer allocates a
lifecycle ctx + three closures unless the atom has an `effect` option).

Tooling: bench.sh now sets BENCH_FRAMEWORKS=react-signals,alien-signals (an
opt-in filter added to the vendored config) — the suite previously ran all 17
frameworks while the diff read 3, ~4× wall-clock for nothing. Override with
BENCH_FRAMEWORKS= (empty) to run everything.
