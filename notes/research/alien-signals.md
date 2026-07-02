# alien-signals deep read (vendor/alien-signals)

Version: **alien-signals 3.2.1**, commit `c00e639` (2026-06-10). Two source files only:

- `vendor/alien-signals/src/system.ts` (263 lines) — the value-agnostic core: link/unlink, propagate, checkDirty, shallowPropagate. Zero allocations except Link objects and tiny stack cons-cells. No recursion, no Array/Set/Map.
- `vendor/alien-signals/src/index.ts` (441 lines) — the public API (signal/computed/effect/effectScope/trigger/batch) built on the core via the `createReactiveSystem` factory.

The README (vendor/alien-signals/README.md:182-268) contains equivalent *recursive* reference versions of `propagate` and `checkDirty` — much easier to read than the iterative ones; consult them when porting.

---

## 1. Core data structures

### ReactiveNode (system.ts:1-7)

```ts
export interface ReactiveNode {
	deps?: Link;      // head of "what I read" list
	depsTail?: Link;  // tail of that list; doubles as the tracking CURSOR during a re-run
	subs?: Link;      // head of "who reads me" list
	subsTail?: Link;  // tail
	flags: ReactiveFlags;
}
```

Every entity — signal, computed, effect, effectScope, and `trigger()`'s temp sub — is a ReactiveNode. The core (system.ts) only ever touches these five fields; value storage, getters, cleanup fns all live in index.ts subtypes:

- `SignalNode` (index.ts:16-19): `currentValue`, `pendingValue` (double-buffered — see §4), no deps.
- `ComputedNode` (index.ts:11-14): `value`, `getter(previousValue?)`.
- `EffectNode` (index.ts:6-9): `fn()`, `cleanup`.
- `EffectScopeNode` (index.ts:3-4): nothing extra.

Type dispatch is duck-typed by property presence, not a tag: `'getter' in node` = computed, `'currentValue' in node` = signal, `'fn' in node` = effect, else scope (index.ts:42-51, 73-89, 247, 286).

### Link (system.ts:9-17)

```ts
export interface Link {
	version: number;             // tracking-cycle stamp for intra-run dedupe
	dep: ReactiveNode;
	sub: ReactiveNode;
	prevSub: Link | undefined;   // \ node in dep's subscriber list
	nextSub: Link | undefined;   // /
	prevDep: Link | undefined;   // \ node in sub's dependency list
	nextDep: Link | undefined;   // /
}
```

One Link object is simultaneously a node in **two** intrusive doubly-linked lists (Preact's "signal boosting" layout):

- the **dep's subscriber list** (`prevSub`/`nextSub`, head `dep.subs`, tail `dep.subsTail`) — walked by `propagate`/`shallowPropagate` to push invalidation downstream;
- the **sub's dependency list** (`prevDep`/`nextDep`, head `sub.deps`, tail `sub.depsTail`) — walked by `checkDirty` to pull/validate upstream, and by the tracking cursor to reuse links across runs.

Why doubly-linked: O(1) `unlink` from both lists with no search; dep-list preserves *read order*, which is what makes cursor-based link reuse work (§3).

### ReactiveFlags (system.ts:24-32)

```ts
export const enum ReactiveFlags {
	None = 0,
	Mutable = 1,        // node produces a value that can change: signals (always), computeds
	                    //   (once evaluated), effectScopes (as a hack, see §6). Gates whether
	                    //   propagate descends through the node and whether checkDirty may
	                    //   update()/recurse into it.
	Watching = 2,       // node is an effect that wants notify() when invalidated. Cleared by
	                    //   notify() as an "already queued" marker; restored by run()/flush().
	RecursedCheck = 4,  // node is CURRENTLY executing its fn/getter (set for the duration of
	                    //   tracking). Tells propagate "a write reaching me may be a self-write;
	                    //   validate with isValidLink". Also suppresses notify in shallowPropagate.
	Recursed = 8,       // node re-triggered itself during its own run (or was left in the queue
	                    //   after a flush exception); the NEXT propagate that reaches it treats
	                    //   it as fresh again (branch 3).
	Dirty = 16,         // definitely stale: a direct dep definitely changed value. Skip checkDirty.
	Pending = 32,       // possibly stale: something upstream was written; must run checkDirty
	                    //   to resolve to Dirty or clean.
}
```

Plus one user-level bit outside the enum, `HasChildEffect = 64` (index.ts:21-25): set on a parent effect/scope/computed whose deps list contains at least one child effect; gates the dispose-children slow path so leaf effects skip an extra deps walk. system.ts never touches it.

The Dirty/Pending pair is Reactively's graph coloring (red/green-with-question-mark): `propagate` only ever marks **Pending** downstream (cheap push); **Dirty** is set only at the write source and by `shallowPropagate`/`checkDirty` when a value is *proven* changed (pull).

### Global state (index.ts:27-34)

```ts
let cycle = 0;        // monotonic counter, ++ per tracking run (updateComputed/run); used as
                      //   Link.version to dedupe re-reads of the same dep within one run
let runDepth = 0;     // depth of currently-executing effect fns; !!runDepth is passed to
                      //   propagate as `innerWrite`
let batchDepth = 0;   // startBatch/endBatch; flush deferred until 0
let notifyIndex = 0;  // flush read cursor into `queued`
let queuedLength = 0; // flush write cursor
let activeSub: ReactiveNode | undefined;  // current tracking context
const queued: (EffectNode | undefined)[] = [];  // flat effect queue, plain array, no Set
```

All module-level singletons. `createReactiveSystem` (system.ts:34) itself is a factory parameterized by three callbacks — `update(sub): boolean` (recompute; return "value changed?"), `notify(sub)` (enqueue effect), `unwatched(sub)` (last subscriber left) — so the core is reusable, but index.ts's globals are not.

---

## 2. Dependency linking: `link` / `unlink`

### link(dep, sub, version) (system.ts:51-91) — four cases in order:

1. **Consecutive duplicate**: `sub.depsTail.dep === dep` → no-op (same dep read twice in a row).
2. **Reuse from previous run**: the link *after* the cursor (`prevDep.nextDep`, or `sub.deps` if cursor is unset) already points at `dep` → stamp `nextDep.version = version`, advance `sub.depsTail` cursor onto it. **Zero allocation when deps are re-read in the same order.**
3. **Non-adjacent duplicate within this run**: `dep.subsTail.version === version && dep.subsTail.sub === sub` → no-op. (Works because new links append at dep's subsTail; the version stamp makes false positives impossible. Can miss dedupe if another sub linked in between — then a redundant Link is created, which is harmless.)
4. **Allocate**: new Link spliced in at `sub.depsTail` (into the dep list, *before* any leftover stale links) and appended at `dep.subsTail`.

Version passed is the global `cycle` for signal/computed reads (index.ts:364, 392) and the constant `0` for structural child-effect→parent links (index.ts:177, 202).

### unlink(link, sub) (system.ts:93-116)

Splices the link out of both lists in O(1). Crucially, if the dep's subscriber list becomes empty (`(dep.subs = nextSub) === undefined`), calls the **`unwatched(dep)`** hook (system.ts:112-114). Returns `link.nextDep` so callers can iterate-and-unlink.

`unwatched` in index.ts:73-89:
- **computed**: if it has deps → `flags = Mutable | Dirty` (forces full recompute on next read) and `disposeAllDepsInReverse` (index.ts:426-433) — recursively unlinks its deps in reverse order, which can cascade `unwatched` up the chain and disposes child effects LIFO.
- **signal**: nothing.
- **effect / scope**: disposed (`effectOper` / `effectScopeOper`) — this is how child effects die when a parent unlinks them.

---

## 3. Tracking: how a computed/effect run records deps (no startTracking/endTracking)

Older alien-signals versions had explicit `startTracking`/`endTracking` in the core; **v3 inlines them into index.ts**. The pattern, identical in `updateComputed` (index.ts:241-265) and `run` (index.ts:272-314):

**Begin** (start-tracking equivalent):
1. If `flags & HasChildEffect`: walk deps *in reverse* and `unlink` every dep that is an effect/scope (`!('getter' in dep) && !('currentValue' in dep)`) — child effects from the previous run are disposed (cleanups run LIFO) **before** the new run (index.ts:242-252, 281-291).
2. `node.depsTail = undefined` — reset the cursor to the head **without clearing the list**.
3. `node.flags = Mutable|RecursedCheck` (computed) or `Watching|RecursedCheck` (effect) — clears Dirty/Pending/Recursed, sets the "currently running" bit.
4. `prevSub = setActiveSub(node)`; `++cycle` (and `++runDepth` for effects).

**During**: every signal/computed read calls `link(dep, activeSub, cycle)`; the cursor mechanism (case 2 above) re-consumes last run's links in order.

**End** (end-tracking equivalent, in `finally`):
1. restore `activeSub`;
2. `node.flags &= ~RecursedCheck`;
3. **`purgeDeps(node)`** (index.ts:435-441): unlink everything *after* the cursor —

```ts
function purgeDeps(sub: ReactiveNode) {
	const depsTail = sub.depsTail;
	let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps;
	while (dep !== undefined) {
		dep = unlink(dep, sub);
	}
}
```

So stale deps (read last run, not this run) are pruned in O(stale); pruning may fire `unwatched` on upstream nodes.

`getActiveSub()`/`setActiveSub()` (index.ts:92-100) are public — `untracked` is implemented as `setActiveSub(undefined)` around the read (see tests/conformance.spec.ts:31-38). Clearing `RecursedCheck` on `getActiveSub()!.flags` inside an effect is the sanctioned way to opt into self-recursive effects (tests/effect.spec.ts:5-17).

---

## 4. Write path: signal write → propagate (push phase)

`signalOper` write (index.ts:369-380):

```ts
if (this.pendingValue !== (this.pendingValue = value[0])) {
	this.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
	const subs = this.subs;
	if (subs !== undefined) {
		propagate(subs, !!runDepth);
		if (!batchDepth) flush();
	}
}
```

Signals are **double-buffered**: writes touch `pendingValue` only and mark the signal Dirty. The commit happens lazily at the next read via `updateSignal` (index.ts:267-270): `s.currentValue !== (s.currentValue = s.pendingValue)` — clears Dirty, returns whether the committed value actually differs. A write A→B→A therefore marks subscribers Pending, but `checkDirty`'s `update(signal)` returns false and no effect re-runs (equality cutoff at the source, using `!==` / reference identity only).

### propagate(link, innerWrite) (system.ts:118-174)

Iterative DFS over the *subscriber* graph. `link` iterates a subs list via `nextSub`; a minimal `Stack<Link|undefined>` cons-list holds sibling continuations, pushed **only** when descending into a subs list with ≥2 entries (system.ts:149-153) — single-subscriber chains descend with zero allocation. Per subscriber, a 5-way branch on `sub.flags` (README recursive version at README.md:190-226 is the readable spec):

1. flags has none of `RecursedCheck|Recursed|Dirty|Pending` → **first notification**: set `Pending` (+`Recursed` if `innerWrite`, i.e. the write happened inside a running effect fn).
2. else if no `RecursedCheck|Recursed` → node already Pending/Dirty: **skip entirely** (local `flags = None`) — no double-notify, no re-descend. This is the queue/traversal dedupe.
3. else if no `RecursedCheck` (has stale `Recursed`) → clear `Recursed`, set `Pending`; treat as fresh (notify + descend).
4. else if node is **currently running** (`RecursedCheck`), not yet Dirty/Pending, and `isValidLink(link, sub)` → **self-write during own run**: set `Recursed|Pending` but keep only `Mutable` in local flags — the effect is *not* notified (suppresses immediate self re-run; it will be picked up by branch 3 on a later propagate), but a mutable computed still lets propagation descend to its subscribers.
   - `isValidLink` (system.ts:252-261) walks from `sub.depsTail` **backward** — i.e. only deps tracked *so far in the current run*. Writing a dep you haven't (re-)read yet this run marks nothing (branch 5).
5. else → skip.

Then: `if (flags & Watching) notify(sub)` (queue the effect); `if (flags & Mutable)` and sub has subscribers → descend (a computed's invalidation propagates transitively; a plain effect is a leaf).

**propagate never reads or computes values and never sets Dirty** — it is the pure push half. Cost is O(reachable clean subgraph); already-Pending regions are skipped by branch 2.

### notify callback (index.ts:52-72) — effect queueing

Appends the effect to `queued`, clears its `Watching` bit (= "already queued"), then walks **up the parent chain** (`effect.subs?.sub` — an effect's first subscriber is its parent effect/scope, see §6) enqueueing every still-Watching ancestor the same way, then **reverses the just-inserted segment** so ancestors sit *before* descendants in the queue. Rationale: an outer effect re-run may dispose the inner effect, so outer must run first (Svelte-style inner-effect scheduling; see tests/effect.spec.ts:19-42, 211-234).

### flush (index.ts:316-332)

```ts
while (notifyIndex < queuedLength) { const e = queued[notifyIndex]!; queued[notifyIndex++] = undefined; run(e); }
```

Synchronous drain; `queuedLength` can grow during the loop. `finally`: if `run` threw, the *remaining* queued effects get `flags |= Watching | Recursed` (so a later propagate re-queues them via branch 3), and indices reset. Note: a signal write from inside a running effect calls `flush()` re-entrantly (batchDepth is 0 during flush), draining the queue depth-first; the shared `notifyIndex`/`queuedLength` make this safe, and `run`'s dirty check makes duplicate runs no-ops.

`startBatch`/`endBatch` (index.ts:106-114) just bump `batchDepth`; `endBatch` flushes at zero. Batching only defers *effect execution* — propagation/marking still happens per write.

### run(e) (index.ts:272-314)

```ts
if (flags & Dirty || (flags & Pending && checkDirty(e.deps!, e))) {
	// dispose child effects (HasChildEffect reverse walk), runCleanup(e) (aborts if the
	// cleanup disposed e: `if (!e.flags) return`), then re-track & re-run fn (§3)
} else if (e.deps !== undefined) {
	e.flags = Watching | (flags & HasChildEffect);  // false alarm: restore Watching, keep child marker
}
```

The effect's user cleanup runs *after* its children are disposed and *before* the new run, with `activeSub` nulled during cleanup (index.ts:398-408).

---

## 5. Pull phase: checkDirty + shallowPropagate + lazy computed

### checkDirty(link, sub) (system.ts:176-237)

Called with a Pending node's deps head. Iterative depth-first walk of the *dependency* graph (recursive spec: README.md:233-266). Per dep:

- If `sub.flags & Dirty` → dirty (something in this loop already proved it, e.g. via shallowPropagate).
- If dep is `Mutable|Dirty` (written signal or known-dirty computed) → **`update(dep)`** right here (commit signal / recompute computed). If the value truly changed: `shallowPropagate(dep.subs)` — but only if the dep has ≥2 subscribers (`subs.nextSub !== undefined`, system.ts:190) — and dirty=true.
- If dep is `Mutable|Pending` (possibly-dirty computed) → push current link on the stack and recurse into `dep.deps` (`sub = dep`, `++checkDepth`).
- If still not dirty → advance `link = link.nextDep`; when a level's deps are exhausted, **unwind**: for each stacked level, if dirty → `update(sub)` (recompute the intermediate computed); if its value changed → shallowPropagate its subs and stay dirty; if unchanged (**equality cutoff**) → `dirty = false` and keep checking the parent's remaining deps. If not dirty → `sub.flags &= ~Pending` (validated clean; future reads skip checkDirty entirely).
- Final `return dirty && !!sub.flags` (system.ts:235): the `!!sub.flags` guards against the sub having been *disposed* (flags=None) by an update/notify side effect mid-check.

So the pull phase recomputes intermediate computeds **top-down along the dep chain, only as far as needed**, and unchanged intermediate values stop the dirtiness from spreading (Dirty is never set on the checked sub unless a dep truly changed).

### shallowPropagate(link) (system.ts:239-250)

One-level walk of a subs list: every sub that is `Pending` but not `Dirty` is upgraded to `Dirty`; if it's `Watching` and not `RecursedCheck` (not currently running) it gets `notify`'d. Purpose: when a lazy pull *proves* a computed changed, its *other* subscribers (who were only Pending) must be promoted so (a) their own reads skip checkDirty and (b) effects among them get queued even though no new propagate happened. Also used after a lazy signal-commit on read (index.ts:383-388) and by `trigger` to force-dirty (index.ts:232).

### computedOper — lazy read (index.ts:334-367)

```ts
if (flags & Dirty
	|| (flags & Pending && (checkDirty(this.deps!, this) || (this.flags = flags & ~Pending, false)))) {
	if (updateComputed(this)) { if (this.subs) shallowPropagate(this.subs); }
} else if (!flags) {           // first-ever read: evaluate with tracking, no old-value compare
	this.flags = Mutable | RecursedCheck; ...this.value = this.getter()...
}
const sub = activeSub;
if (sub !== undefined) link(this, sub, cycle);
return this.value!;
```

- Dirty → recompute unconditionally. Pending → checkDirty; clean → just clear Pending (the comma-expression). Fresh (flags=None) → first evaluation.
- `updateComputed` (index.ts:241-265) returns `oldValue !== (c.value = c.getter(oldValue))`; on change, shallowPropagate its subs. **Equality is hard-coded `!==`**; the getter receives the previous value as an argument.
- Reads outside any tracking context still work (no link created).
- A computed with **no subscribers** is never propagated to (nothing links it), so on next read after its deps changed it relies on... note: an unwatched computed that previously had subs was reset to `Mutable|Dirty` by `unwatched` and its deps were torn down, so it fully recomputes on next read. A computed that *never* had subs but was read untracked keeps flags=Mutable and stale deps links — but since it has no subs, propagate from its deps stops at it only if... it *is* linked into deps' subs lists (link is created only when there's an activeSub). Untracked-only computeds have no dep links at all after the first read? No: dep links are created (computed is the sub); it *does* get marked Pending by propagate even with zero subs, so laziness works for untracked reads too.

---

## 6. Effects, scopes, ownership tree

`effect(fn)` (index.ts:165-189): node `flags = Watching|RecursedCheck`; **if created under an activeSub (parent effect/scope/computed-in-flight), the child links itself as a *dependency* of the parent** (`link(e, prevSub, 0)`, parent gets `HasChildEffect`). The dep edge is the ownership edge: parent re-run/disposal walks its deps in reverse, unlinks child effects, and `unlink`→`unwatched`→dispose cascades depth-first LIFO (tests/effect.spec.ts:44-130, effectScope.spec.ts). fn runs immediately, tracked. Returns `effectOper.bind(e)` as the disposer.

`effectOper` (index.ts:410-415): `effectScopeOper` (flags=None; `disposeAllDepsInReverse`; unlink from own parent via `this.subs`) then run own cleanup. `effectScope(fn)` (index.ts:191-210) is the same minus tracking/cleanup; scope flags = `Mutable` — the Mutable bit makes the generic `update` fallback (index.ts:49-50) a harmless no-op and, since scopes are **not Watching**, `notify`'s ancestor walk stops at a scope boundary.

Effects created inside a **computed's getter** are owned by the computed the same way; `updateComputed`'s HasChildEffect walk (index.ts:242-252) disposes them before re-evaluating (tests/effect.spec.ts:132-176).

Scheduling summary: **fully synchronous, no microtask**. Write → mark → queue effects → flush immediately unless batched. Nested/inner writes during flush drain re-entrantly. Effects run ancestors-first; a not-actually-dirty queued effect (Pending but checkDirty false) is a cheap no-op that just restores `Watching`.

`trigger(fn)` (index.ts:212-239): runs `fn` under a throwaway tracked sub with batching; afterwards, for each dep the fn read: `propagate(subs)` **then `shallowPropagate(subs)`** — the second call force-upgrades Pending→Dirty, bypassing value-equality, for in-place mutations (array push etc.). Then unlinks the temp sub and flushes.

Brand checks `isSignal/isComputed/isEffect/isEffectScope` (index.ts:116-130) compare `fn.name === 'bound ' + oper.name` — zero-field brand via bound-function names.

---

## 7. Re-entrancy / self-writes / cycles — current behavior

- **Write to a dep from inside an effect that already read it this run**: propagate branch 4 (RecursedCheck + isValidLink) marks `Recursed|Pending`, no notify — the effect does **not** re-run now; the Recursed bit makes a *future* propagate re-queue it (branch 3). Clearing `RecursedCheck` manually (tests/effect.spec.ts:5-17) opts into immediate synchronous recursion (re-entrant flush → nested `run`; recursion depth = number of self-triggered re-runs; stack-bound).
- **Write from inside a computed getter**: `runDepth` is **not** incremented by `updateComputed` (only by effect creation/run), so `innerWrite` is false unless the recompute happens inside a running effect. The write propagates and — if `batchDepth===0` — **flushes effects synchronously in the middle of the getter**. Those effects may read the still-RecursedCheck computed and get its **stale value** plus a link. Nothing forbids or detects this.
- **True cycles**: none detected. A computed reading itself (directly or transitively) while `RecursedCheck` is set falls through every branch in `computedOper` and silently **returns the stale/undefined value and creates a self-link**. Effect ping-pong loops are only bounded by the Recursed suppression or the JS stack.
- `cycle` (the global counter) is **not** cycle *detection* — it's the link-version stamp for dedupe.

---

## 8. Performance tricks worth keeping

1. **Intrusive dual doubly-linked lists** — no Set/Map/Array anywhere in the graph; O(1) link/unlink; auto-`unwatched` when a subs list empties.
2. **Cursor-based link reuse** (`depsTail` as cursor + `purgeDeps` after) — re-runs with a stable dep set allocate nothing.
3. **Link.version stamping** for O(1) duplicate-read dedupe instead of a per-run Set.
4. **Flags bitmask branch table** in propagate — one flags load, 5 branches, covers notify-dedupe, recursion guard, and traversal pruning simultaneously.
5. **Iterative traversals with cons-cell stacks** allocated only at real branch points (≥2 subscribers / dep recursion); single-child chains are loop iterations.
6. **Push Pending only / pull Dirty lazily** — writes are O(reachable-clean-subgraph) marking, no recompute; recompute is demand-driven and equality-cut.
7. **Double-buffered signal values** — commit-on-read gives free A→B→A cutoff.
8. `shallowPropagate` skipped when a dep has exactly one subscriber (system.ts:190, 217) — the puller *is* the only subscriber.
9. **Value-agnostic monomorphic core**: system.ts touches only the 5 ReactiveNode header fields (same object-layout prefix across all node types); values/equality live entirely in the `update` callback.
10. **Bound-function API** (`signalOper.bind(node)`) — reads are bare calls, node rides in `this`; also enables the `fn.name` brand check.
11. Flat array queue with two integer cursors; `Watching`-bit-as-queued-marker instead of a dedupe Set; in-queue segment reversal for ancestor-first order.

Caveat for our port: `const enum` (system.ts:24) violates our stripping-only guideline — use plain `const` objects / literal numbers.

## 9. What must change for react-signals requirements

**(a) Per-"world" values (committed vs pending transition):** system.ts is already value-free — worlds are an index.ts-level concern for *values*, but **flags are single-world**: Pending/Dirty marks, the `depsTail` cursor, and `checkDirty`'s Pending-clearing would race between worlds (one world's validation erases another's invalidation). Signals' existing `currentValue`/`pendingValue` split (index.ts:16-19) is a degenerate 2-world version of exactly this — generalize to per-world value slots + per-world dirty state (either a second flags word per world, or version/epoch stamps per node compared against a world clock). The global `cycle`/`activeSub`/`queued`/`batchDepth` singletons must become per-runtime (the `createReactiveSystem` factory pattern already points the way); link `version` semantics must be world-aware or replaced.

**(b) Custom isEqual:** three hard-coded `!==` sites, all in index.ts: write-time `pendingValue` check (index.ts:371), `updateSignal` commit (index.ts:269), `updateComputed` (index.ts:259). The core only consumes `update()`'s boolean, so this is trivial. Note write-time short-circuit must also use isEqual (or be dropped) for custom equality to be sound.

**(c) Suspense (promise inside a computed):** today a getter that throws leaves the computed in a bad state — `updateComputed`'s finally (index.ts:260-264) restores tracking but `c.value` keeps the old value and flags become plain `Mutable` (Dirty cleared) → node looks *clean with a stale value*; and a throw during `checkDirty`'s `update(dep)` unwinds through system.ts (no try/catch) leaving stacked nodes' Pending flags inconsistent. Required: make pending/error a first-class *value state* on ComputedNode (store `{status, value|error|promise}`, never let `update()` throw; rethrow/suspend at the read API layer), plus an invalidation hook when the promise settles (equivalent to a write). The `ctx.use(promise)` design in PROMPT.md fits: `use` records the promise as a dep-like input rather than throwing.

**(d) Writes to atoms from inside computeds + cycle detection:** today it half-works and is unguarded (§7): mid-getter flush of effects, stale reads of in-flight computeds, silent self-links. Needed: (1) increment `runDepth` (or equivalent) in `updateComputed` so `innerWrite` is accurate; (2) defer flush during computed evaluation (auto-batch around `update`); (3) actual cycle detection — `RecursedCheck` already marks "currently evaluating", so a *read* (`computedOper`) hitting a node with `RecursedCheck` set from a different sub is a dependency cycle → throw (cheap, no extra state); for write-created cycles, detect when propagate from a mid-getter write reaches the writing computed itself (branch-4's `isValidLink` machinery is the starting point); (4) a library-init switch to forbid computed-writes outright (check `activeSub` is a computed in `signalOper` write).

## 10. Test-derived invariants (tests/)

- Cleanup ordering (effect.spec.ts, effectScope.spec.ts): on parent re-run/dispose, children clean up **before** parent cleanup, siblings LIFO, depth-first-reverse for nesting; computeds' child effects dispose before getter re-runs.
- Outer effect must keep responding to its own deps after an inner-only re-run (effect.spec.ts:211-234; the `run` else-branch restoring Watching + HasChildEffect).
- conformance.spec.ts runs the shared `reactive-framework-test-suite`; `untracked` = swap `activeSub` to undefined; `batch` = startBatch/endBatch.
- trigger.spec.ts: `trigger` notifies subs of read signals exactly once, tolerates read-then-write, and does not notify the trigger's own temp sub.
