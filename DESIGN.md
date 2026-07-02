# react-signals — Design

A signals library for React with first-class concurrent rendering support:
no `useSyncExternalStore`, full `startTransition` integration, Suspense parity,
and a small React patch that exposes the render/commit lifecycle to userspace.

Research backing every claim here lives in `notes/research/` (exact file:line
references into the submodules). Read `notes/design/00-candidates.md` for the
alternatives we rejected and why.

---

## 1. The problem with external stores in concurrent React

`useSyncExternalStore` keeps a single mutable snapshot outside React, so it
must force synchronization: every store change notification schedules
**SyncLane** work regardless of context, and any store write that lands during
a concurrent render causes React to discard the finished render and re-render
the whole root **synchronously** (`isRenderConsistentWithExternalStores`,
see notes/research/react-uses-use-suspense.md §1.4). Store state can never ride
in a transition. That is the de-opt we are eliminating.

The insight (validated by the React team's `react-concurrent-store`
experiment, notes/research/react-concurrent-store.md): **React's hook update
queue is already a multi-version store.** Every queued update carries a lane;
a render at lanes `R` applies exactly the updates whose lane is in `R` and
rebases the rest. If a signal write notifies subscribed components by calling
their `setState` synchronously *in the writer's execution context*, React
assigns every one of those updates the writer's lane (transition, sync, default
— whatever `requestUpdateLane` decides), and lane bookkeeping, rebasing,
entanglement, batching, and infinite-update-loop protection all apply to signal
state exactly as they do to `useState`.

What userspace alone cannot do (all hit by react-concurrent-store, §5/§8 of its
report):

1. **Know which world a render wants.** A component mounting during a
   transition render has no queued update to tell it whether to read pending or
   committed values. Userland must guess, double-render, and has a genuine
   suspense bug. Needs: current render lanes.
2. **Know when a write's world commits.** Folding pending values into
   committed state requires a commit signal (their `CommitTracker` is an
   admitted kludge). Needs: per-root commit lifecycle.
3. **Keep a yielded render consistent.** A time-sliced render can resume after
   an unrelated write; reads must not tear. Needs: render-pass lifecycle.

These three, plus the (unrelated) DOM-mutation window, define the React patch
(§6). Everything else is userspace.

## 2. State model: committed base + write log

Signal state lives in the graph nodes (single storage, not copied per
subscriber). Each atom holds:

- `committedValue` — the value all *committed* React trees agree on.
- a small **write log**: entries `{value, lane, seq, committedEpoch?}` created
  only when React bindings are active. `lane` is the opaque update lane React
  assigned to the write's broadcast; `seq` is a global monotonic write counter;
  `committedEpoch` is set when the write folds into committed state.

Fast path: when no transition/concurrent work is pending, the log is empty and
atoms are just `committedValue` — pure-core users (and the benchmark) never pay
for worlds.

### Read rule

Every read resolves against a **read context**:

- **Head** (no context — writes/reads outside render, core effects,
  benchmarks): fold the whole log; i.e. the latest write wins. Matches the
  benchmark contract "reads mid-batch see fresh values".
- **Render** (inside a React render pass with lanes `R`, pinned at pass start
  with `pin = {epoch, maxSeq}`): value = `committedValue` as of `pin.epoch`,
  overlaid with log writes that are **uncommitted ∧ lane ∈ R ∧ seq ≤
  pin.maxSeq**.

This reproduces React's own update-queue semantics for graph reads:

- lane ∈ R ⇔ React would apply this update in this render.
- seq ≤ pin.maxSeq ⇔ the write existed when the render pass started — mirrors
  `finishQueueingConcurrentUpdates`, which hides mid-render arrivals from the
  in-progress pass.
- epoch pinning keeps a *yielded* render reading the same committed base even
  if another root commits (and folds) meanwhile. Old committed values are
  retained (per-atom mini-history) only while some active render pins an older
  epoch — races are rare and renders are short, so history is transient.

### Folding

On each root commit (patch callback with committed + remaining lanes):

- log writes whose lane committed → `committedValue = value`, stamp
  `committedEpoch`, bump the global epoch;
- log writes whose lane is no longer pending in any root that received its
  broadcast → fold too (the work was discarded, e.g. unmounted subtree; head
  semantics must still converge);
- entries fold immediately at write time when nothing subscribed (no broadcast
  → nothing will ever commit them).

Multi-root note: lanes are per-root but transition lanes are claimed from a
module-global cursor and all pending transition lanes render as **one batch**
in today's React (`getHighestPriorityLanes`; `enableParallelTransitions` off —
notes/research/react-lanes-transitions.md §10). v1 folds a write when the first
root commits its lane; other roots' urgent renders may briefly observe the new
committed value before their own transition commit lands. Their in-progress
passes are protected by epoch pins; the relaxation is documented and a
refcounted fold (wait for all broadcast-target roots) is a contained upgrade.

### Rebasing

Because atoms are last-write-wins, the interleaving that forces
react-concurrent-store to re-run reducers ("sync write while a transition is
pending") needs no special machinery: a sync write appends a sync-lane log
entry; a sync render reads committed+sync-entry; the transition render later
reads committed+both entries (transition lanes ∪ rebased base) — each render's
lane filter produces exactly React's rebase result.

## 3. Core graph (`src/core`, zero React imports)

A port of alien-signals' push-pull algorithm (data structures and invariants
documented in notes/research/alien-signals.md), adapted:

- **Nodes**: intrusive doubly-linked dependency/subscriber lists (`Link` shared
  between both lists), flags bitmask, cursor-based link reuse across re-runs,
  `purgeDeps` pruning. Plain `const` objects instead of `const enum`
  (stripping-only TS).
- **Push**: writes mark subscribers `Pending` (cheap); **pull**: reads resolve
  `Pending → Dirty/clean` via `checkDirty` with equality cutoff. Exact lazy
  pull counts (the `testPullCounts: true` club in the benchmark).
- **Equality**: `isEqual` option threaded through the three compare sites
  (write short-circuit, signal commit, computed update); defaults `Object.is`.
- **Worlds**: dirty/pending flags and propagation run on the **head** plane
  (head is what notification cares about). Committed-plane values for render
  reads are resolved by the read rule (§2) — committed reads of computeds
  validate with per-dependency epoch/seq stamps (pull-only, no second flag
  plane), caching one committed result per node keyed by global epoch.
- **Computed value states**: `{status: 'value' | 'error' | 'suspended', …}`.
  Evaluation never throws through the graph (a throwing getter or pending
  `ctx.use` thenable becomes a cached error/suspended state); read sites
  rethrow or suspend. Fixes alien-signals' throw-corrupts-flags hazard.
- **Suspense**: `ctx.use(thenable)` stamps `status/value/reason` on the
  thenable (same protocol React uses), caches it positionally per node so
  identity is stable across re-evaluations, and marks the computed
  `suspended`. Suspended computeds re-check thenable status on read; non-render
  watchers attach a settle listener that invalidates + notifies.
- **Writes inside computeds**: allowed by default. `runDepth`-style tracking
  is extended to computed evaluation (alien-signals only tracks effects);
  effect flush is deferred during evaluation; a write whose propagation reaches
  the currently-evaluating node (via the `isValidLink` machinery) or a read of
  a node currently evaluating (`RecursedCheck`) throws a cycle error.
  `configure({ forbidWritesInComputeds: true })` makes any in-computed write
  throw at write time.
- **Atom observed-lifecycle**: watcher refcount (hooks, signal-effects, and
  transitively-watched computeds count). 0→1 runs the atom's `effect(ctx)`;
  1→0 runs its cleanup, deferred to a post-commit sweep so remount-within-a-
  commit doesn't thrash remote subscriptions (react-concurrent-store's sweep
  pattern).
- **Effects & scheduling**: core effects are synchronous with an explicit
  queue + `flush()` (ancestors-first, alien-signals ordering). React bindings
  never use core effects' scheduler; the benchmark adapter drains the queue in
  `withBatch`.
- **Tracing slots**: a module-level `tracer` that is `null` unless the tracing
  module is loaded; every interesting transition does `tracer !== null &&
  tracer.emit(...)` with a cause id, so the untraced cost is one null check.

## 4. React bindings (`src/react`)

### `useSignal(signal)`

- One `useState(0)` version counter per hook — the re-render trigger. The
  value rendered is always read from the graph with the current render's read
  context (render lanes + pin via the patch API), so mounts inside a transition
  render read the pending world directly: no double render, no
  mount-mid-transition suspense bug (react-concurrent-store's known-bug test
  becomes a passing test for us).
- Subscribes in a layout effect. The subscriber is a graph watcher node whose
  notify = `setVersion(v => v + 1)` called synchronously in the writer's
  context — lane assignment, batching, async-action entanglement all inherited
  from React. Graph-level equality cutoff means no broadcast (no render) when
  a write doesn't change this node's output in the writer's world.
- Post-subscribe fixup in the same layout effect (covers writes racing between
  render and subscription): compare rendered value to current committed value
  (sync `setVersion` → pre-paint correction) and to head (fixup inside
  `startTransition` to join the pending batch) — Eldredge's protocol, needed
  only in race windows rather than on every mount.
- If the value is a suspended computed, rethrow via React's `use(thenable)`
  (conditional `use` is legal): React's replay machinery handles resolution;
  our positional thenable cache keeps promise identity stable across replays.
- Unmount: unsubscribe; watcher refcounts sweep post-commit.

### `useComputed(fn, deps)`

A component-local `Computed` held in a ref, recreated when `deps` change
(deps compared like `useMemo`). `fn` closes over props/state freely — that's
what `deps` is for; signal reads inside `fn` are auto-tracked by the graph.
Subscription and reads work exactly like `useSignal` on the local node.

### `useSignalEffect(fn, deps)`

Runs `fn` tracked after commit (passive effect). Re-runs when `deps` change
(React pathway) or when a tracked signal's committed value changes — the graph
queues the effect during fold (§2) and flushes in a microtask, i.e. effects
observe committed worlds only, matching useEffect's "after commit" semantics.
Cleanup supported like `useEffect`.

### `<SignalsProvider>` — not required

The patch's global registry callbacks make a library-owned root component
unnecessary (PROMPT allows one "if strictly necessary" — it is not). Multiple
roots work because callbacks carry the root.

### Infinite-loop integration

All re-renders flow through `setState`, so every broadcast passes
`throwIfInfiniteUpdateLoopDetected` and commit-time nested-update counting
(NESTED_UPDATE_LIMIT = 50), and render-phase loops hit RE_RENDER_LIMIT = 25.
Pure signal→signal effect cycles (never touching React) are bounded by the
core's own re-entrancy guard.

### SSR / hydration

Server rendering reads committed values with no subscriptions and no atom
`effect` mounting. Hydration renders from the same committed values; apps
serialize atom state and initialize atoms before `hydrateRoot` (documented
recipe + helper). No `getServerSnapshot` analogue needed — reads are plain.

## 5. Tracing (`react-signals/tracing`, lazy)

Event schema with causality: every event has `id`, `ts`, `cause` (id of the
triggering event) and a type-specific payload — `atom-write`, `invalidate`,
`computed-eval` (+ reason: pull|validate), `broadcast` (lane, subscriber
count), `render-read` (world decision), `fold`, `effect-run`, `atom-observed`
/ `atom-unobserved`, `suspend`/`resolve`. Loading the module installs the
tracer into the core slot; a ring buffer plus subscription API feed the future
devtools timeline; helpers answer "why did X re-run" by walking cause chains.
Zero overhead unless loaded (single null check per site).

## 6. React patch (vendor/react, minimal)

Two independent features, both following the established
`ReactSharedInternals` renderer-registration pattern (the `S`/
`onStartTransitionFinish` precedent — the reconciler fills slots on the shared
object at module init; isomorphic code calls them; multiple renderers chain).
No Fiber shapes cross the boundary; lanes pass as documented-opaque numbers;
roots pass as opaque tokens (identity only).

### 6.1 Concurrent lifecycle for external state (`unstable_externalRuntime`)

Registry callbacks (library subscribes once):

- `onRenderPassStart(root, lanes)` / `onRenderPassEnd(root)` — brackets a
  render *pass* (fresh stack → completion/discard), spanning yields. Drives
  epoch pins.
- `onCommit(root, committedLanes, remainingLanes)` — drives folding, effect
  scheduling, watcher sweeps.

Queries:

- `getCurrentUpdateLane()` — the lane `requestUpdateLane` would assign right
  now (transition scope / async-action entangled lane / event priority).
  Stamped on write-log entries at broadcast time.
- `getRenderContext()` — `null` outside render; `{root, lanes}` during render.
  Drives the read rule and "inside render" detection.
- `laneIntersects(lanes, lane)` — subset test without exposing bit layout.

### 6.2 DOM mutation window

`onBeforeMutation(root)` / `onAfterMutation(root)` bracketing exactly React's
commit mutation phase, so a `MutationObserver` can disconnect/reconnect around
React's own DOM writes while observing everything else. (Unrelated to signals;
same registry, delivered per root.)

Placement facts (notes/research/react-commit-and-build.md §1): the hooks must
live inside `flushMutationEffects` — not `commitRoot` — because with View
Transitions the mutation phase runs later, inside the browser's
`startViewTransition` update callback. Bracketing `commitMutationEffects` +
`resetAfterCommit` there covers every commit path (including `flushSync` via
`flushPendingEffects`) and fires only when mutations will actually occur.
Scope is React's *reconciliation* mutations: documented exceptions are the
layout-phase `<img src>` re-assignment, suspensey-CSS `<link>` insertion,
imperative Float APIs (`preload`/`preinit`), View Transition name attributes,
and user effect code — callers who need those too should filter, not expect
the bracket to cover them.

### Patch principles

- Additions are unconditional (no feature flag) but inert until a listener
  registers: near-zero cost on the hot path (one null check per site).
- Each hook site documents its invariant ("fires after X, before Y").
- Built and consumed via `scripts/build-react.sh` →
  `build/oss-experimental/*`, linked into the workspace through pnpm
  overrides; rebuilds require no reinstall.

## 7. Testing

- **Core**: graph semantics (laziness, cutoff, dynamic deps, repeated reads,
  cycles, write-in-computed policies, observed lifecycle), the shared
  reactive-framework conformance expectations, benchmark contract tests
  (sync effect flush, fresh mid-batch reads, exact pull counts).
- **React**: adopt react-concurrent-store's harness wholesale
  (vitest + jsdom + RTL; transitions held open by controlled promises;
  TestLogger render-order asserts with afterEach-empty; inline DOM snapshots
  for tear checks; listener-leak asserts; controlled thenables for suspense)
  and its 14-scenario suite as our conformance bar — including making their
  known-bug case (sync mount mid-transition with suspending head state) pass.
  Plus: signal+React-state lockstep in one transition, interruption/rebase,
  multiple roots, useComputed over props+state+signals, useSignalEffect
  re-runs, infinite-loop rejection, MutationObserver window, hydration.
- **Benchmark**: adapter over the core (§3) registered in
  js-reactivity-benchmark; conformance tests must pass with
  `testPullCounts: true`.

## 8. Performance stance

- Reads: bare bound-function call + null-ish checks on the world log (empty in
  steady state). Writes: alien-signals propagation; broadcasts only on real
  (per-world) value changes.
- No per-subscriber value copies, no consistency-check tree walks, no forced
  sync re-renders, no per-render allocations in uSES's style.
- Target: within noise of `useState` for re-render-on-change; alien-signals
  -class results on the core benchmark.
