# v2 proposal: opaque batch tokens + a log-first engine rewrite

Status: assessment/proposal (2026-07-02), not yet implemented. Prompted by two
questions after the rebasing work landed: (1) would a from-scratch rewrite,
knowing the rebase semantics, simplify the engine? (2) can the React patch
express what the library needs without leaking lanes into userspace?

Short answers: yes and yes — and they are one project, not two, because the
opaque boundary reshapes the engine's world model into exactly the form that
simplifies it.

---

## 1. Why the current engine is confusing (specifics)

The engine is correct (95 tests, adversarial regressions) but grew in layers:
first an eager two-plane cache model, then a write log for render worlds, then
log replay for rebasing. The result is that **the same value is derived in
four places that must agree**:

| place | what it computes | mechanism |
|---|---|---|
| `writeAtomImpl` | eager BASE (`buffered`) and HEAD (`headValue`) | incremental apply at write time |
| `resolveAtomInWorld` | a render pass's value | replay of visible log entries |
| `retireBatch` | new committed value | replay of retired + urgent entries |
| `sweepLogs` | collapsed pre-log value | replay of the swept prefix |

Three replay loops plus incremental eager updates that must stay equivalent to
them. Every rebasing bug risk lives in that equivalence.

Second source of confusion: **plane bookkeeping on computeds**. A computed
carries `value/status/payload` twice (BASE and HEAD mirrors), plus three
trust-tracking fields (`headGen`, `baseGen`, `evaluated` bitmask) whose only
job is to answer "may I trust this mirror for the current fork?" — the
`seedHead` rules. Two of the adversarial review's confirmed bugs were exactly
these rules being subtly wrong. Per-plane dirty flags packed into one bitfield
(with the "clear both when steady" hygiene rule) were a third bug class.

None of this is essential complexity. The essential complexity is: multiple
worlds exist concurrently; computeds cache per world; React timing decides
when worlds merge. The accidental complexity is that "world" is spelled three
different ways in the code (plane fields, log replays, RenderWorld objects).

## 2. The rewrite shape: log as truth, worlds as keys

Knowing what we know now, the clean formulation is:

1. **The write log is the single source of truth for an atom.** One function
   derives every value: `replay(atom, includes: (entry) => boolean)`.
2. **A world is an opaque key** — "committed", "head", or a pinned render
   pass — that maps to an `includes` predicate over log entries.
3. **`buffered`/`headValue` become explicitly-memoized replays** for the two
   hot world keys, with a stated invariant (cache equals replay, invalidated
   by write/fold) instead of hand-maintained incremental updates scattered
   through the write path.
4. **Computed caches become a uniform small map: world key → result**
   (value/error/suspended + a validity stamp). `seedHead`, `headGen`,
   `baseGen`, and `evaluated` all collapse into "is there a valid entry for
   this key?" — one mechanism replaces four fields and their interaction
   rules. Steady mode keeps a single entry; forked mode two; pinned passes
   use the existing per-pass slot.
5. **Dirty tracking**: keep alien-signals push-pull marking, but mark a single
   "possibly stale" bit; *which world* is stale is resolved at
   confirmation/pull time by comparing per-world version stamps (an atom
   bumps a committed-version on urgent writes/folds and a head-version on all
   writes). This removes the per-plane flag bits, the per-plane clear-mask
   hygiene, and the per-link plane-membership bits — the three most
   bug-prone mechanisms per the review. (Perf note: this trades flag-bit
   branch tables for version compares; the benchmark must arbitrate. If the
   deep-chain numbers regress, per-link stamps can live in the existing
   `Link` fields.)

What would NOT change, because it is proven and orthogonal: the notification
protocol (mark-all → confirm subscriptions → flush effects, batch-deferred),
pins and fold-time visibility stamps, watched refcounts and the atom
lifecycle, suspense-as-status, the tracing slots, the hooks and their mount
fixup. The full test suite — especially the React integration scenarios and
the useReducer side-by-side — is implementation-agnostic and carries over as
the safety net.

Estimated effect: engine ~1800 → ~1300 lines, but the real win is fewer
invariants: "cache = replay(key)" is one sentence; the current plane-mirror
trust rules are a page.

## 3. The boundary: batch tokens instead of lanes

Userspace currently touches lanes in five places: write attribution
(`getCurrentUpdateLane` + `isTransitionLane`), entry visibility
(`lanesInclude` against render lanes), fold decisions (`lanesInclude` against
committed/remaining lanes), and the runtime's `pendingLanesByContainer`
abandonment sweep. That is real coupling: we reason about React's bit
assignment policy in userspace, and a React upgrade that changes lane
semantics (e.g. `enableParallelTransitions`) means rewriting react-signals
internals.

It is also a latent correctness hole: **transition lane bits are recycled**
(10 lanes, module-global cursor — notes/research/react-lanes-transitions.md
§1.2/§3.2; the cursor freezes during async actions, and reuse requires a batch
to stay pending across ten transition-starting events — realistic when a
transition suspends on slow data while the user keeps interacting). Examined
closely, most collisions are *inherited coarsening*: React itself merges the
two batches, our entries merge identically, and nothing observably diverges
under today's all-transitions-render-together scheduling. The genuine dangers:

- **The abandonment/resurrection race.** An entry is orphaned (its subtree
  unmounted, React discarded the queued updates) but not yet swept; the bit is
  reclaimed by a new transition before the sweep's "lane no longer pending"
  check runs; the stale entry survives and folds into committed state when the
  unrelated new batch commits. A dead form's write resurrects seconds later —
  rare, user-visible, unreproducible.
- **Async-action edges**: React suspends components on entangled pending-action
  state; bare lane-tagged entries carry no such guard.
- **enableParallelTransitions** makes the coarsening argument collapse
  entirely: independently-scheduled batches must be independently visible, and
  bits can no longer stand in for identities.

Bits are not identities. What the library actually needs are identities, with
an explicit retire-exactly-once lifecycle that contract tests can check —
rather than lifetime bookkeeping that must shadow React's queue lifetimes by
coincidence.

### What the library actually needs (semantically)

1. **At write time**: an identity for the *batch* this write belongs to, and
   one bit of classification — is the batch *deferred* (transition-like: its
   renders won't block paint, it commits later) or *immediate*?
2. **At render time**: which batch identities does this render pass include?
3. **At retirement**: this batch committed (fold its writes) or was abandoned
   (fold-or-drop per policy) — exactly once, per identity.

### Proposed patch API (replaces the lane surface)

```ts
type BatchToken = opaque object; // identity, never recycled

// Write attribution (replaces getCurrentUpdateLane + isTransitionLane):
unstable_getCurrentWriteBatch(): { token: BatchToken; deferred: boolean };

// Render lifecycle (replaces renderLanes + lanesInclude):
onRenderPassStart(container, includes: ReadonlySet<BatchToken>): void;
onRenderPassEnd(container): void;

// Retirement (replaces onCommit's committedLanes/remainingLanes and the
// userspace abandonment sweep):
onCommit(container): void; // ordering signal for fold timing
onBatchRetired(token: BatchToken, committed: boolean): void;
```

React-side, the registry is **edge-triggered from the three places React
already mutates its own books** — never sampled:

1. **Claim** (`requestTransitionLane`'s once-per-event claim): bump the lane
   slot's generation counter. No allocation; a token is minted lazily only if
   a signal write later lands in this batch.
2. **Pending** (`markRootUpdated`, first set of the lane on a root this
   generation): refcount the roots the batch has work on. One slot check;
   inert when no token exists.
3. **Finish** (`markRootFinished`): for each lane leaving `root.pendingLanes`,
   count down the token's root refcount; emit `onBatchRetired` at zero.

Why this gets abandonment "for free": React itself has no separate
abandonment mechanism. Updates orphaned by an unmount keep their lane bit
pending; React eventually schedules that lane, renders nothing, and commits —
retirement flows through the ordinary commit path. Edge-triggering inherits
exactly that: claim → retire → claim are strictly ordered synchronous events,
so a reused bit can never be observed under a stale generation and the
resurrection race becomes unrepresentable, rather than merely unlikely. (This
is also why React is immune in the first place: its updates are owned by
fibers — lifetime is structural, bits never carry identity. A global store
can't anchor writes to fibers, so the honest substitute is relaying React's
book mutations at the moment they happen.)

All lane lifetime reasoning moves inside `vendor/react`, next to the code it
depends on — which is where it gets maintained when the patch is rebased onto
a new React. Userspace log entries store a token reference; visibility is
`entry.token ∈ pass.includes` or "retired-committed before my pin"; folds are
driven by retirement events. The `pendingLanesByContainer` map, the
abandonment sweep, and every bitwise operation in runtime.ts disappear —
replaced by nothing, not by equivalent userspace logic. Semantics note: for a
global store, an orphaned write still folds (the component was only a
subscriber; head state must converge) — the race was about timing and
attribution, which edge-triggering eliminates; the retirement event's
`committed` flag stays available if a drop policy is ever wanted.

A **contract test file** (userspace side, driving the token API through real
React renders: deferred write → not visible to urgent pass → visible to its
own pass → retired-committed exactly once; abandoned batch retires
uncommitted; recycled-lane scenarios get distinct tokens) becomes the
definition of the boundary. Rebasing the React patch = making that suite pass
again, with zero userspace changes. That's the upgrade story asked for.

## 4. Recommendation

Do both together, as one change, in this order:

1. Add the token registry to the patch + the contract test suite (the lane
   APIs can remain temporarily as the tokens' implementation detail).
2. Rewrite the engine log-first with worlds-as-keys (§2), consuming tokens.
   Keep the notification protocol and all public APIs unchanged.
3. The existing 95-test suite + benchmark conformance gate the swap; the
   forked-overhead benchmark variant tells us whether version-stamp dirt
   tracking holds the perf line.

Scope estimate: patch +~150 lines (registry + events), engine rewrite ~1300
lines replacing ~1800, runtime.ts shrinks by roughly half, bindings and
public API untouched. Risk is moderate and mostly covered by the regression
suite; the main open perf question is flag-bits vs version-stamps on deep
chains.

## 5. If we don't rewrite yet: cheap contained cleanups

- Extract the three replay loops into one `replayLog(atom, includes)` helper
  (mechanical; removes the equivalence risk).
- Unify `unwrapResult` / `unwrapResultOrThrow` / `unwrapCached` (three copies
  of the same status switch).
- Extract the shared eager-plane-update block from `writeAtomImpl`'s two
  branches.
- Move all lane touching in runtime.ts behind a tiny `BatchAdapter` interface
  — the token API's shape, implemented over lanes — so the engine stops
  seeing lanes even before the patch changes.

## 6. Registry overhead budget

Costs by path (design constraints for the implementation):

- **No React consumers**: zero — the write provider's `consumerCount === 0`
  gate short-circuits before any registry code, exactly as today.
- **Per logged write**: one 31-slot array index + generation compare on top of
  today's lane computation (which React already caches per event). No
  allocation.
- **Per batch**: one small token object, minted lazily at the first signal
  write inside a batch that has none — never at startTransition/event
  dispatch, never for renders. Transitions without signal writes allocate
  nothing. Urgent batches: at most one tiny object per event-with-writes
  (free-listable to zero once retired and unreferenced, if it ever matters).
- **Per render pass**: one 1–2 element included-tokens collection (linear
  scan beats a Set at that size), replacing part of the RenderWorld we
  already allocate.
- **Per read**: token membership is consulted only on the log-replay slow
  path (pinned passes / diverged worlds); steady-state reads never see
  tokens. Identity compare vs today's bitwise AND — nanoseconds on an
  already-slow path.
- **Per commit**: one retirement callback per batch, replacing today's
  per-commit pendingLanesByContainer scan (a small win).

**The observability gate (zero-allocation urgent writes).** A log entry for
an urgent write only matters if some observer could distinguish worlds. Gate:
log an entry (and consult the token registry) only when the engine is forked
OR a render pass is currently pinned. A plain `fooAtom.set(1)` in an event
handler — no transition pending, no render in flight — therefore allocates
nothing: compare, store, mark, confirm, setState. Two supporting rules:
`getCurrentWriteBatch()` returns the token itself (`deferred` is a field on
it), never a fresh wrapper object; and `unstable_isCurrentWriteDeferred()`
(pure classification, no minting, no side effects) lets the bindings apply
the gate BEFORE asking for a token — so gated immediate writes mint nothing
at all, and invariant 2 below holds strictly (contract-tested: classification
alone produces no retirement event). The documented relaxation is that an
ungated urgent write is visible to a lower-priority pass starting inside the
write→commit window (reachable only if the urgent render suspends; identical
to the existing consumerCount===0 semantics; closable later via a cached
`hasPendingLowPriorityWork` flag from the patch if ever needed).

Invariants to encode in the contract tests:
1. Tokens are per-batch, never per-write.
2. No token is allocated unless a consumer exists AND a write lands in a
   not-yet-tokened batch that the observability gate says must be logged.
3. A lane slot's generation bump must not release the old token while any
   retained log entry (pinned pass) still references it — the correctness
   rule raw lane numbers silently lack today.
4. Retirement fires exactly once per token (committed or abandoned), and an
   abandoned token's entries can never ride a later batch — the
   resurrection race from §3 must have a dedicated contract test.
