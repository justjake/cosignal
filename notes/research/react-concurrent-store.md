# Research: vendor/react-concurrent-store

Deep-read of the entire `vendor/react-concurrent-store` submodule (repo: thejustinwalsh/react-concurrent-store, latest commit `2842481` "Improve TS exports and types (#20)", 2026-01-15 by Mark Erikson). All paths below are relative to `vendor/react-concurrent-store/` unless absolute.

## 0. Provenance / who wrote what

Two distinct implementations live in this repo (`git log --format='%an %ad %s'`):

1. **Root ponyfill** (`packages/use-store/src/useStore.ts` + `src/useStore.spec.tsx`), authored by **Justin Walsh** (Jun–Jul 2025). A ponyfill of the API surface proposed in React PR [#33215](https://github.com/facebook/react/pull/33215) ("initial stubs" of concurrent stores, per README.md:16). Focused on stores whose value is a **promise** consumed via `use()`.
2. **Experimental impl** (`packages/use-store/src/experimental/*`), authored by **Jordan Eldredge <jeldredge@meta.com>** (Meta; Relay lead, React contributor), Oct 2025, commits `532aef0` ("[WIP] Stub new impl (#4)") through `7e8861d`. This is the serious concurrency work: full rebasing semantics, commit tracking, mount-mid-transition handling. Exported as `experimental` from `src/index.ts:2-7`.

The README's "How It Works" (README.md:95-106) describes only the root ponyfill. The experimental impl has its own README at `src/experimental/README.md` which is the single most valuable design document in the repo.

Note: I checked `vendor/react` (our React submodule) for the first-party concurrent-store stubs (`REACT_STORE_TYPE` symbol, `useStore` in react-reconciler) — **not present** in our checkout; PR #33215 content is not in this tree.

## 1. Package layout

```
packages/use-store/                  # the npm package "react-concurrent-store"
  src/index.ts                       # exports { createStore, useStore } (root ponyfill) + `experimental` namespace
  src/types.ts                       # REACT_STORE_TYPE symbol, ReactStore, ISource, Reducer
  src/useStore.ts                    # ROOT PONYFILL: createStore + useStore
  src/useStore.spec.tsx              # root ponyfill tests (incl. suspense/promise stores)
  src/experimental/
    index.ts                         # exports useStore, useStoreSelector, createStore, createStoreFromSource, StoreProvider, Store
    Store.ts                         # Store class: head state + committed state + rebasing dispatch
    StoreManager.ts                  # ref-counted registry of stores, snapshot/commit helpers
    Emitter.ts                       # trivial listener list (subscribe/notify)
    useStore.tsx                     # StoreProvider, CommitTracker, useStoreSelector, useStore
    useStore.spec.tsx                # THE concurrency test suite (14 tests)
    README.md                        # design goals, known issues
    testUseCases/
      MiniRelay.tsx                  # toy Relay: versioned RecordSource chain, fragment reads, recycleNodesInto
      reduxUseCase.spec.tsx          # Redux Toolkit enhancer binding
      relayUseCase.spec.tsx          # MiniRelay tests (memoized selectors, structural sharing)
      README.md
  test/setup.ts                      # vitest setup: why-did-you-render proxy over React
  test/TestLogger.ts                 # Scheduler.log/assertLog emulation
  types/react-internals.d.ts         # declares __CLIENT_INTERNALS.{A.getCacheForType, H.useCacheRefresh}
  vitest.config.ts                   # jsdom + setup file
packages/docs/                       # Astro/Starlight docs for the ROOT ponyfill only
```

Peer dep: `react ^19.0.0` (package.json:46-48). Tests use React 19.1, vitest 3, @testing-library/react 16, jsdom.

## 2. Public API

### Root ponyfill (`src/useStore.ts`)

```ts
createStore<Value>(initialValue): ReactStore<Value, Value>
createStore<Value, Action>(initialValue, reducer): ReactStore<Value, Action>
useStore<Value>(store): Value          // returns cached value; if Value is a Promise, pass to use()
store.update(action)                   // dispatch
```

`ReactStore` is branded with `$$typeof: Symbol.for("react.store")` (types.ts:1, useStore.ts:39); `useStore` throws on non-stores (useStore.ts:66-70). No provider component needed.

### Experimental (`src/experimental/`)

```ts
createStore<S, A>(reducer, initialState): Store<S,A> & { dispatch(action) }   // useStore.tsx:37-54
createStoreFromSource<S, A>(source: ISource<S,A>): Store<S,A>                 // useStore.tsx:56-60
<StoreProvider>                       // REQUIRED, exactly one, at root (experimental/README.md:40-42)
useStore<S>(store): S                 // = useStoreSelector(store, identity), useStore.tsx:263-265
useStoreSelector<S,T>(store, selector): T
```

`ISource<S,A>` (types.ts:12-26) is the contract for wrapping external stores:

```ts
export interface ISource<S, A> {
  getState(): S;         // immutable snapshot of current (head) state
  reducer: Reducer<S,A>; // PURE — "React needs this in order to generate temporary states.
                         //  See: https://jordaneldredge.com/notes/react-rebasing/"
}
```

For `createStoreFromSource`, the source must call `store.handleUpdate(action)` **after** each of its own updates (experimental/README.md:133-136); the returned store is read-only from React's side.

## 3. Core concurrency mechanism (experimental impl — the one that matters)

### Where state lives

- **Per-consumer, in React's own `useState`.** `useStoreSelector` keeps `{value, selector}` in a `useState` (useStore.tsx:171-174). Everything a component renders comes out of that hook, so React's lane machinery versions it for free. The setState payloads are **pre-computed values captured at notify time** (`setHookState(selector(store.getState()))`, useStore.tsx:236-238) — render never reads mutable store fields on the update path. React's hook update queue is the multi-version store; React's own rebasing replays the queued values per lane.
- **The Store keeps exactly two states** (Store.ts:22-24): `state` (head/canonical — all chronological updates applied) and `committedState` (last state React actually committed to the tree). No version numbers, no history list. Transient rebased states are computed on demand and live only inside setState closures.
- Exception to "render never reads the store": the `useState` **initializer** reads `selector(store.getState())` — the HEAD state — on mount (useStore.tsx:171-174), and the dynamic-selector path re-reads head during render (useStore.tsx:179-180). Both are deliberately head-reads and are fixed up post-commit (see §3.4).

### Broadcast

`Store extends Emitter` (Store.ts:21); `Emitter` is a plain listener array (Emitter.ts:1-15). Each mounted `useStoreSelector` subscribes in its `useLayoutEffect` (useStore.tsx:236-238). Notification is synchronous fan-out of `setState` calls; the *React context* in which `notify()` runs (inside vs. outside a `startTransition` scope) determines the lane of every resulting setState. That's the entire "lane awareness": transition detection is

```ts
// Store.ts:6-11
const sharedReactInternals: { T: unknown } =
  React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE as any;
function reactTransitionIsActive() { return !!sharedReactInternals.T; }
```

`ReactSharedInternals.T` is React's current-transition slot, set while a `startTransition` scope runs. This is the only React internal the experimental impl touches.

### Commit tracking (how the store learns what React committed)

`StoreProvider` (useStore.tsx:94-102) creates one `StoreManager` and renders `<CommitTracker/>` before children. CommitTracker (useStore.tsx:68-89, self-described as "an awkward kludge"):

- subscribes (in `useEffect`) to the StoreManager, which itself holds a **ref-counted subscription to every store currently read anywhere in the tree** (StoreManager.ts:41-53);
- on any store notify → `setAllStates(storeManager.getAllStates())` — a `Map<Store, headState>` snapshot in CommitTracker's own `useState`. Because this setState fires in the same React context (same transition scope or same sync batch) as the consumers' setStates, **it lands in the same lane and commits in the same commit**;
- `useLayoutEffect` on `allStates` → `storeManager.commitAllStates(allStates)` (useStore.tsx:84-86) → `store.commit(state)` sets `committedState` for each store (StoreManager.ts:55-60, Store.ts:32-34), then `sweep()` unsubscribes/deletes stores whose refcount dropped to 0.

So the commit of CommitTracker's `useState` is used as a proxy for "the transition (or sync flush) containing these store values has committed."

### 3.1 Update flow (a): urgent/sync update, no pending transition

`store.dispatch(action)` (useStore.tsx:48-51: source reduces head, then `handleUpdate(action)`). In `handleUpdate` (Store.ts:41-89): `noPendingTransitions = committedState === state` (before pulling new head) is true → `committedState = state` eagerly (Store.ts:57-58) and `notify()`. All consumer setStates are sync-lane; React flushes synchronously; CommitTracker commits (redundantly). Consecutive dispatches in one event autobatch (tested, useStore.spec.tsx:952-999).

### 3.2 Update flow (b): update inside startTransition

`startTransition(() => store.dispatch(action))` → head advances → `reactTransitionIsActive()` true → plain `notify()` (Store.ts:46-49). Every consumer's setState and CommitTracker's setAllStates are transition-lane. React renders the transition in background; the DOM keeps showing committed values (test useStore.spec.tsx:94-112 asserts nothing flushes). On transition commit, all consumers swap together and CommitTracker's layout effect sets `committedState = head`. Async transition scopes (`startTransition(async () => { dispatch(); await promise; })`) hold the transition pending until the promise resolves — this is how tests create long-lived transitions.

### 3.3 Update flow (c): sync update interleaved with a pending transition — rebasing

State machine going in: `committedState = C`, `state = T = reduce(C, a1)` (transition pending). Sync `dispatch(a2)`: source head becomes `reduce(T, a2)`. `handleUpdate` (Store.ts:60-87):

```ts
const newState = this.state;                                       // reduce(reduce(C,a1),a2) — chronological head
this.committedState = this.source.reducer(this.committedState, action); // reduce(C, a2) — REBASED: sync as if transition never happened
this.state = this.committedState;   // temporarily, so notify-readers see rebased state
this.notify();                      // sync-lane setStates → flushes reduce(C,a2)
this.state = newState;              // restore chronological head
startTransition(() => { this.notify(); }); // re-dispatch head into a transition;
// "With existing transition semantics this should result in these updates entangling
//  with the previous transition and that transition will now include this state" (Store.ts:80-83)
```

This exactly mirrors React's own useState update-queue rebasing (linked note: jordaneldredge.com/notes/react-rebasing). Verified by tests: initial 2, `DOUBLE` in transition, `INCREMENT` sync → UI shows **3** (=2+1) immediately, then **5** (=(2*2)+1) when the transition resolves (useStore.spec.tsx:558-688); multi-sync variant → 4 then 6 (690-822); `flushSync` variant (824-950). **This is why the pure `reducer` must be exposed to the store** — it is the only way to compute the temporary rebased state.

### 3.4 Why this is safe where useSyncExternalStore is not

- uSES has one mutable `getSnapshot` read during render + a forced **sync de-opt** whenever the snapshot changes mid-render — a single mutable snapshot cannot represent two lanes at once, so React bails to sync rendering, killing transitions (README.md:14, react.dev caveat).
- Here, each rendered value is React hook state, updated by value-carrying setStates issued in the correct lane context. React itself maintains as many concurrent versions as it has pending lanes; the userland store never needs to answer "what is the value for lane X."
- The residual unsoundness is precisely the places render *does* read the store directly (mount initializer, selector change), which are patched by post-commit fixups — see §5 limitations.

### 3.5 Mount / late subscriber protocol (useStore.tsx:139-249)

The dense comment at useStore.tsx:156-174 is load-bearing:

> "Counterintuitively we initially render with the transition/head state instead of the committed state. This is required ... where we mount as part of a transition which is actively changing the state we observe. ... React forces all setStates fired during render into their own lane, and by the time our useLayoutEffect fires, the transition will already be completed."

So: **initial render = selector(head)**. Then in `useLayoutEffect` (runs only if this render actually committed):

1. `storeManager.addStore(store)` (refcount++, subscribe manager if new) — useStore.tsx:184.
2. Compute `mountState = selector(head)`, `mountCommittedState = selector(committed)` — useStore.tsx:185-186.
3. **Sync fixup**: if the value we rendered `!== mountCommittedState`, we mounted in a sync commit while a transition was pending (or a sync update raced between our render and our effect — e.g. dispatched from a sibling's useLayoutEffect) → `setHookState(mountCommittedState)` sync, causing an immediate second render before paint (useStore.tsx:200-210).
4. **Transition catch-up**: if `mountState !== mountCommittedState`, a transition is still pending and we are not part of it → `startTransition(() => setHookState(mountState))`, "(unsafely) depend[ing] upon current transition entanglement semantics" so this update joins the pending transition and this component flips together with everyone else (useStore.tsx:212-234).
5. Subscribe; cleanup = unsubscribe + `storeManager.removeStore(store)` (useStore.tsx:236-242). Effect deps `[selector]` only.

`setHookState` bails out (returns previous object identity) when `is(prev.value, value) && prev.selector === selector` (useStore.tsx:189-198) — this is the render-skipping/equality layer (`is` = polyfilled Object.is, useStore.tsx:255-261).

Mounting **inside its own transition** while another transition is pending needs no fixup at all: initial render with head state is already correct and entangles (test at useStore.spec.tsx:165-256 asserts zero fixup renders).

Dynamic selector (changed identity): value derived during render from head (useStore.tsx:179-180), same layout-effect fixups apply; tested including a selector change during a pending transition (spec:1372-1457 — renders 4, fixes up to 2, resolves to 4). Dynamic **stores** throw: `"useStoreSelector does not currently support dynamic stores"` (useStore.tsx:149-154; test spec:1001-1053).

### 3.6 Unmount / GC

`removeStore` only decrements the refcount, deliberately **not** unsubscribing immediately: "a state update could cause the last store subscriber to unmount while also mounting a new subscriber ... we don't lose the currently committed state ... So, we cleanup unreferenced stores after each commit" (StoreManager.ts:69-81). `sweep()` (StoreManager.ts:83-90) runs after every `commitAllStates` and on CommitTracker unmount (useStore.tsx:79-81). Every test asserts `store._listeners.length === 0` after unmount.

### 3.7 Multiple roots / SSR

- **Multiple roots: not supported/tested.** experimental/README.md:42: "exactly one instance of `<StoreProvider/>` at the root ... an implementation detail of our user-space approach and should not be needed in a first-party implementation." Two providers sharing one store would each write `committedState` from their own commit cadence and clobber each other during interleaved transitions.
- **SSR/hydration: nothing.** Only mention in the whole repo is README.md:10 TODO "Investigate SSR and streaming of promises and store values". No `getServerSnapshot` analogue; tests are jsdom-only client renders.

## 4. Root ponyfill mechanism (simpler, weaker)

`createStore` keeps three mutable fields `_current`, `_sync`, `_transition` (useStore.ts:38-59). `update()` reduces into `_transition` and notifies. Each `useStore` consumer: `useState(() => store._current)` + **its own `useTransition`**, and in `useEffect`:

```ts
// useStore.ts:75-82
return store.subscribe(() => {
  store._sync = store._transition;
  startTransition(() => {
    setCache((store._current = store._sync));
  });
});
```

Every update — urgent or not — is funneled through the consumer's transition (`abe4b4c "fix: potential tear"` removed the sync path). There is no rebasing, no commit tracking; `_current` is mutated when the transition *callback* runs (immediately), not when it commits, so a component mounting mid-transition initializes from the head value → can tear against committed siblings. This impl is adequate mainly for its target use: **store-of-promise + `use()`**, where transitions swap one promise for another and Suspense handles pendingness. History note: earlier iterations (`ed678e1`) used React internals `A.getCacheForType`/`H.useCacheRefresh` for per-root cache versioning with `_uuid`/`_version` counters — abandoned for the plain useState approach; `types/react-internals.d.ts:3-12` still declares those internals but current code only uses `.T` in the experimental Store.

## 5. Stated limitations / TODOs / design rationale

1. **Sync-mount-mid-transition double render + suspense correctness bug** (experimental/README.md:26-30): mounting sync during a transition renders head then fixes up → renders twice (perf), and "if the newly mounted component suspends when attempting to render the transition state it will not mount and thus be unable to apply the fix-up. If that same component would not have suspended in the sync state, this is incorrect behavior and technically a bug." Encoded as passing test "gets stuck in suspense when transition state suspends on mount" (useStore.spec.tsx:1110-1248): the fallback shows and the already-mounted sibling is hidden with `display: none` — the UI is wrong until the promise resolves. **Unfixable in userland**: would require React to render the fresh subtree at the committed lane's state.
2. **Selector constraints** (experimental/README.md:172-175): must be identity-stable (now relaxed to "supported but triggers fixup renders" by PR #18); *should* be memoized because "there may be multiple states in play at any given time. A `WeakMap` memoization technique is recommended" (keyed on state object — see MiniRelay).
3. **Reducer must be pure**, "may occasionally be invoked to produce temporary states" (experimental/README.md:99-101).
4. **All updates must be expressible as pure `(state, action) => state`** so the store can rebase (experimental/README.md:105). Redux needs an enhancer to capture the reducer + actions since its `subscribe` doesn't expose actions (reduxUseCase.spec.tsx:30-70); Relay needs updater functions.
5. **Entanglement assumption**: both Store.ts:80-83 and useStore.tsx:226-229 explicitly "(unsafely) depend upon current transition entanglement semantics" — i.e., that any new transition-lane update joins the pending transition. If React ever un-entangles independent transitions, both the rebasing re-dispatch and the mount catch-up break.
6. **StoreProvider is a kludge**; CommitTracker comment (useStore.tsx:64-67) calls itself "an awkward kludge which attempts to signal back to the stores when a transition containing store updates has been committed."
7. **MiniRelay memory leak** (MiniRelay.tsx:158-165): `next._older = source` chains every version; "NOTE! This creates a memory leak today since we don't have any kind of compaction/cleanup when new states commit." (The CommitTracker commit signal is exactly where compaction would hook in.)
8. Root README TODOs (README.md:7-10): docs in progress; "Investigate SSR and streaming of promises and store values" unchecked.

## 6. Test suite — the goldmine

### Harness

- **vitest + jsdom** (vitest.config.ts), `@testing-library/react` `render`/`act`, `react-dom` `flushSync`. **No Scheduler mock, no react-test-renderer, no internal test builds** — everything drives public React 19 through real timing.
- **Long-running transition idiom** (the key trick, e.g. useStore.spec.tsx:94-101):
  ```ts
  let resolve: () => void;
  await act(async () => {
    startTransition(async () => {
      store.dispatch({ type: "INCREMENT" });
      await new Promise<void>((r) => { resolve = r; });   // holds the transition pending
    });
  });
  // ... interleave sync updates, mount components, assert committed DOM ...
  await act(async () => { resolve(); });                   // completes the transition
  ```
  React 19 async transitions stay pending until the scope's promise resolves, giving deterministic control of the transition window without touching Scheduler.
- **Interleaving**: sync `act(() => store.dispatch(...))`, `flushSync(() => dispatch(...))`, mounting via leaked `setShowOther` setState, dispatching from `useEffect`/`useLayoutEffect` of sibling components mounted before the reader (subscription-race coverage).
- **Render-order logging**: `test/TestLogger.ts` — "Emulate the Scheduler.log/assertLog pattern from React internal tests"; components `logger.log({testid, count})` in render; `logger.assertLog([...])` consumes and asserts; `afterEach(() => logger.assertLog([]))` guarantees no unasserted renders leak between assertions. Intermediate (pre-fixup) renders are asserted explicitly, e.g. spec:119-126 expects `otherCount: 2` then `otherCount: 1`.
- **Committed-DOM assertions**: `asFragment()` + `toMatchInlineSnapshot` at every step — tearing is checked by all counters showing the same value in the committed DOM.
- **Suspense**: manually controlled thenables passed to `use()`; components log "suspend" when `promise.status !== "fulfilled"` (React stamps `.status` on used thenables) — useStore.spec.tsx:1119-1133.
- **Leak checks**: `expect(store._listeners.length).toBe(0)` after every `unmount()`.
- **Root-suite extra**: `test/setup.ts:15-86` monkey-patches React with **why-did-you-render** via `vi.mock("react")` + a Proxy allowing WDYR to overwrite only a whitelisted property set; notifications collected to `globalThis.WDYR.notifications`; custom matcher `toOnlyRerenderWhenPromiseChanges` (setup.ts:89-132) asserts components re-render *only* because the stored promise changed — an automated "no spurious re-renders" audit.

### Scenario inventory (experimental/useStore.spec.tsx)

| line | scenario |
|---|---|
| 53 | No tearing: new reader mounts sync mid-transition → mounts at committed state via fixup (renders head→fixup), flips with transition |
| 165 | Reader mounts in its **own** transition mid-transition → zero fixups, entangles, flips together |
| 258 | Updates dispatched from `useEffect`/`useLayoutEffect` before reader subscribes are not missed (subscription race) |
| 393 | Sync dispatches from effects **during a long-running transition** flush sync (fixups must not entangle with the transition) |
| 558 | Sync update interrupting transition → rebasing: shows `reduce(C,sync)` now, `reduce(reduce(C,t),sync)` on resolve |
| 690 | Multiple sync updates interrupting transition (repeated rebase of committedState) |
| 824 | `flushSync` update interrupting transition |
| 952 | Consecutive sync dispatches autobatch into one render |
| 1001 | Dynamic stores throw (documented unsupported) |
| 1055 | Transition update itself mounts a **new** reader (conditional child appears at transition state; single render+mount) |
| 1115 | **Known bug as test**: sync mount mid-transition where head state suspends → stuck on fallback, sibling hidden `display:none`, recovers on resolve |
| 1250 | Two independent stores update independently (only affected readers render) |
| 1320 | Dynamic selectors supported (new selector → new value, no remount) |
| 1372 | Selector changes sync **during** pending transition → renders head-with-new-selector, fixup to committed, resolves to head |

### Root suite (src/useStore.spec.tsx)

Basic value/reducer/update tests (34-493); suspense: initial suspend + resolve (498-540); **transition suppresses fallback**, `isPending` flag asserted via `data-pending` attr (542-623); **interrupted transitions resolve to final state** — three clicks before resolve → shows 3 (625-717). All with the WDYR matcher.

### Use-case suites

- **reduxUseCase.spec.tsx**: `StoreEnhancer` monkey-patches `dispatch` to also call `reactStore.handleUpdate(action)` and captures the root reducer for `createStoreFromSource` (30-70); re-runs the mount-mid-transition tearing scenario against Redux Toolkit + Immer.
- **relayUseCase.spec.tsx + MiniRelay.tsx**: the closest thing here to a signals/derived-data story. `RecordSource` versions state as a **linked chain** (`_older`, MiniRelay.tsx:27-54) of sparse maps; `useFragment` builds a **stable memoized selector** with a `WeakMap<RecordSource, Snapshot>` cache (MiniRelay.tsx:190-224): cache hit per state version; if only the immediate-older version is cached, `keysChangedInThisVersion(seenIds)` (read-set intersection, MiniRelay.tsx:46-53) decides whether to reuse as-is, else re-read + `recycleNodesInto` (Relay's structural sharing, MiniRelay.tsx:233-282) to preserve subtree identity. Tests: fragment re-read on change (41-149); **no re-render when read-set untouched** (151-219); **structural sharing keeps memoized child from re-rendering** (221-329). This demonstrates manual dependency tracking (seenIds = read-set) layered on top of the whole-store-notify model — i.e., what our library must automate.

## 7. Versioning / copies / GC summary

- Store: exactly 2 copies (head + committed). Store.ts:22-24.
- N in-flight copies live in **React's hook update queues** as captured setState values; the library never enumerates them.
- Transient rebased states: computed per sync-interrupt, not retained.
- GC: refcounted store subscriptions swept post-commit (StoreManager.sweep). No version GC needed because only 2 copies exist. MiniRelay's version chain is the exception and leaks by admission.
- Lane awareness: only `ReactSharedInternals.T` (boolean "in a transition scope now"). No lane IDs, no per-transition identity, no commit callback API — commit detection is the CommitTracker kludge; multiple *distinct* concurrent transitions are indistinguishable (all assumed entangled).

## 8. What it fundamentally cannot do that react-signals needs

1. **No computed/derived values.** Selectors are per-component, whole-store-notified, equality-bailed. A `Computed` shared across components with caching per state version would need MiniRelay-style `WeakMap<stateVersion, value>` memoization because **multiple states are alive simultaneously** (committed, head, transient rebased). A classic eager signals graph (one current value per node, alien-signals style) is structurally incompatible with lanes: the graph would need either (a) pure recompute-from-snapshot per version (what selectors do — loses incremental algorithms), or (b) value-per-version nodes with commit-driven GC (needs the commit signal React doesn't expose — CommitTracker is the workaround; our React patch should expose this properly).
2. **No automatic dependency tracking.** Notification granularity is the whole store; fine-grained-ness is achieved only by *render bailout* after the setState is already scheduled (useStore.tsx:189-198), so every reader's selector runs on every store change. Signals need read-set tracking (MiniRelay's `seenIds` is the hand-rolled version) to notify only affected consumers.
3. **Rebasing requires pure `(state, action) => state`.** Atom writes fit (action = set → last-write-wins rebases fine), but it means our store must retain action semantics, not just new values, if we want React-consistent sync-interrupts-transition ordering — or we accept simpler last-write-wins per atom.
4. **Mount-mid-transition is unsolvable in userland** without double renders and the suspense bug (§5.1): userland cannot ask React "render this new subtree at the committed lane's version." This is a headline motivation for our React patch — expose (a) which lane/transition a render is for, or (b) let a hook supply lane-appropriate initial state.
5. **No commit lifecycle API**: CommitTracker + StoreManager + mandatory single provider exist solely to learn "a commit containing store values happened." Our patch should expose a real commit hook (also needed for our DOM MutationObserver requirement).
6. **Transition identity/entanglement is guessed, not known.** Two comments admit relying "unsafely" on entanglement semantics. A first-party API (or our patch) should let a store attach updates to a *specific* transition.
7. **No SSR/hydration story, no multiple-roots story** — both explicitly out of scope here; both on our requirements list. Multi-root needs per-root committed tracking (per-root lanes commit independently), which conflicts with a single shared `committedState` per store.
8. **Per-consumer useTransition/fixups cost**: every reader carries a useState + layout effect + potential double-render on mount; performance goal "competitive with useState" argues for pushing versioning into React rather than fixups.

## 9. Direct steals for our project

- The **test harness pattern** wholesale: vitest+jsdom+RTL, async-startTransition-held-open-by-promise for deterministic transition windows, TestLogger assertLog with afterEach-empty invariant, inline DOM snapshots for tear checks, listener-leak asserts, controlled thenables + `.status` for suspense, WDYR proxy + custom matcher for re-render-cause auditing.
- The scenario list in §6 as our conformance suite (we should pass all of them, including making test #1115's known-bug case *correct* via our React patch).
- `ISource` contract + Redux/Relay bindings as the shape for `Atom.effect` external-subscription interop.
- MiniRelay's `WeakMap<stateVersion, {seenIds, value}>` + read-set invalidation + `recycleNodesInto` as the blueprint for version-keyed computed caching with structural sharing.
- `ReactSharedInternals.T` as the existing (hacky) transition probe; our patch should replace it with a supported API.
- StoreManager's deferred-unsubscribe/sweep-after-commit pattern for refcounting observers across unmount/remount within one commit.
