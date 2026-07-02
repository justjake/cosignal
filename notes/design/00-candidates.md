# Design candidates: concurrent-safe signals without useSyncExternalStore

Status: pre-research hypotheses (written while research agents read the submodules).
To be validated/corrected against notes/research/*.

## Why useSyncExternalStore is disqualified

uSES guarantees consistency by forcing synchronous de-opt: store updates cannot
participate in transitions, and a store change during a concurrent render forces
a blocking re-render. We need signal writes inside `startTransition` to render
at transition priority, in lockstep with React state written in the same
transition, while urgent renders keep seeing the committed values.

## Key insight expected from react-concurrent-store

React's hook update queue is already a multi-version store: each queued update
is tagged with a lane; a render at lanes L applies only included updates and
keeps/rebases the rest. If a signal write broadcasts a `setState` to every
subscribed component *synchronously in the writer's execution context*, React
assigns all those updates the writer's lane (transition or sync), and per-lane
consistency, rebasing, entanglement, and infinite-loop protection all come for
free.

## Candidate A — value mirroring (react-concurrent-store style)

`useSignal` stores the signal's value in `useState`; writes broadcast
`setState(newValue)` eagerly.

**Fails for our library**: computed C(A, B) with interleaved writes
(transition writes A, urgent writes B) broadcasts eagerly-computed values;
rebase replays stale precomputed values → transition commit shows C(newA, oldB)
or worse. Eager values cannot rebase. Also every subscriber duplicates storage.

## Candidate B — version-bump subscription + world-resolved graph reads

- Graph keeps **committed world** (values folded at commit) plus **pending
  overlays** keyed by an opaque *world token* (≈ transition batch / lane).
- `useSignal` holds `useState(0)` as a re-render trigger only. Writes broadcast
  `setVersion(v+1)` in the writer's context → correct lane.
- During render, reads resolve: committed values + overlays for every world
  token included in *this render's lanes* → needs React to expose current
  render lanes (patch).
- Fold overlay → committed when React commits a render containing that token
  (patch: commit notification), then GC.
- Tear-proofing for yielded renders: pin the committed-world version at render
  start; keep prior versions until no render pins them (or rely on React
  discarding interrupted renders — verify restart semantics).

Pros: single storage in graph; computeds evaluate per-world with correct
rebase-equivalent semantics (overlay over *current* committed base).
Cons: needs patch APIs: (1) current-render lane/world introspection,
(2) update-token at write time, (3) per-root commit notification. Lanes are
per-root; world token must be library-owned and mapped to lanes per root.

## Candidate C — updater-closure world capture (patch-minimal variant)

Broadcast `setState(() => graph.read(signalId, worldToken))` where the closure
captures the write's world token. React only executes an updater in renders
that include its lane → the closure itself is the world selector; no
render-lane introspection needed for *subscribed* components. Value-equality
bailouts come free.

Remaining holes that still need the patch:
- **Mounting during a transition render**: a newly-mounted component has no
  queued update; its first read must know the render's world → needs
  current-render info anyway.
- Fold timing still needs commit notification.
- Eager-state evaluation at dispatch time runs the closure in the writer's
  context (correct world by construction — verify).

## Likely synthesis

B and C compose: closures/subscriptions piggyback React's queue for lane
bookkeeping; the graph reads always resolve via (pinned committed version +
overlays for current render worlds) using the patched introspection API; C's
bailout behavior can be recovered at the graph layer via equality cutoff
(don't broadcast at all when a subscribed node's world-value didn't change).

## React patch surface (draft, to validate)

1. Opaque **update token** readable in a write context (candidate: identity of
   `ReactSharedInternals.T` for transitions + per-root lane query), such that:
   - at render time: "does the current render include token X?" per root.
   - at commit time: "which tokens committed?" per root.
2. Per-root commit lifecycle callback (precedent: `createRoot` options like
   `onUncaughtError`).
3. DOM-mutation window (unrelated to signals): per-root `onBeforeMutation` /
   `onAfterMutation` callbacks bracketing exactly the commit mutation phase,
   for MutationObserver disconnect/reconnect.
4. Explicit non-goals: no Fiber shapes exposed; no reading internals from
   userspace without a patched accessor.

## Open questions for research

- Q1: Does React always discard a partially-rendered concurrent tree when a
  sync render commits in between (prepareFreshStack conditions)? Determines
  whether pinned committed versions are belt-and-braces or load-bearing.
- Q2: Update-queue processing: is an updater guaranteed to run only in renders
  whose lanes include the update's lane? Eager-state edge cases?
- Q3: What exists at write time to identify the transition/lane
  (ReactSharedInternals.T shape, requestUpdateLane decision tree)? Async
  transitions: do post-await writes still get transition treatment, and how?
- Q4: What commit lifecycle exists today (DevTools onCommitFiberRoot signature,
  createRoot options plumbing)?
- Q5: How does `use()` replay renders; can our useSignal call `use()`
  conditionally on catching a computed suspension?
- Q6: Suspense: when a transition render suspends on ctx.use(promise), what
  keeps the overlay alive; retry semantics.

## Suspense sketch

Computed evaluation calls `ctx.use(thenable)`: track thenable state per
computed (fulfilled → value; pending → throw SuspendSignal). `useSignal`
catches SuspendSignal and calls React's `use(thenable)` (legal conditionally)
→ React suspends/replays; on resolution computed re-evaluates. Thenable cache
lives on the computed node keyed by evaluation, mirroring ReactFiberThenable
semantics.

## Other components (less controversial)

- Core graph: alien-signals-style doubly-linked dep/sub lists, push-pull with
  lazy computed recomputation, equality cutoff (custom isEqual), effect
  scheduling. Extend nodes with per-world value slots.
- Atom observed-lifecycle effect: refcount watchers through the computed
  chain (alien-signals "watched" analog); mount on 0→1, cleanup on 1→0.
- Writes-in-computed: allowed unless written atom is (transitively) upstream of
  the writing computed → cycle error; global strict option to forbid entirely.
- useComputed(fn, deps): component-local Computed, deps invalidate like
  useMemo, signal deps auto-tracked, subscribe like useSignal.
- useSignalEffect(fn, deps): passive effect, auto-tracked, re-run on
  invalidation via our scheduler (batched, post-commit).
- Tracing: module-level `let tracer` slot, no-op unless `react-signals/tracing`
  loaded; every event carries a cause id → causality chains; ring buffer.
- Package: single `react-signals` package; src/core has zero React imports
  (benchmark adapter consumes it); subpath export `./tracing`.
