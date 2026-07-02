# React internals: useSyncExternalStore, use(), thenables, Suspense mechanics

Research target: `vendor/react` at commit `7ce677d40659f0fefd8ce122480716d0c8e926b4` (2026-07-02).
All paths below are relative to `vendor/react/packages/react-reconciler/src/` unless noted.
Line numbers are exact for this commit.

Files studied in depth:
- `ReactFiberHooks.js` (5241 lines)
- `ReactFiberThenable.js` (392 lines)
- `ReactFiberWorkLoop.js` (5669 lines)
- `ReactFiberThrow.js` (712 lines)
- `ReactFiberConcurrentUpdates.js` (288 lines)
- `ReactFiberCommitWork.js`, `ReactFiberCommitEffects.js`, `ReactFiberRootScheduler.js`, `ReactFiberLane.js`, `ReactEventPriorities.js`, `ReactHookEffectTags.js`, `ReactFiberBeginWork.js`

---

## 1. useSyncExternalStore — the baseline we must beat

### 1.1 Data structures

`ReactFiberHooks.js`:

```js
// :228
type StoreInstance<T> = { value: T, getSnapshot: () => T };
// :233
type StoreConsistencyCheck<T> = { value: T, getSnapshot: () => T };
// :246
export type FunctionComponentUpdateQueue = {
  lastEffect: Effect | null,
  events: Array<EventFunctionPayload<any, any, any>> | null,
  stores: Array<StoreConsistencyCheck<any>> | null,
  memoCache: MemoCache | null,
};
```

The `StoreInstance` lives on `hook.queue` (mount: `ReactFiberHooks.js:1701-1705`). Consistency
checks live on `fiber.updateQueue.stores` and the fiber gets the `StoreConsistency` flag
(`ReactFiberHooks.js:1817`).

### 1.2 mountSyncExternalStore (`ReactFiberHooks.js:1635-1724`)

1. Calls `getSnapshot()` **during render** — "This breaks the normal rules of React, and only
   works because store updates are always synchronous" (comment at 1697-1699).
2. If the render is *not* on a blocking lane, pushes a consistency check:
   ```js
   // :1691-1694
   const rootRenderLanes = getWorkInProgressRootRenderLanes();
   if (!includesBlockingLane(rootRenderLanes)) {
     pushStoreConsistencyCheck(fiber, getSnapshot, nextSnapshot);
   }
   ```
   `includesBlockingLane` (`ReactFiberLane.js:684-694`) = SyncHydration | Sync |
   InputContinuousHydration | InputContinuous | DefaultHydration | Default | Gesture. i.e. the
   check is pushed for transition/retry/idle/offscreen renders — exactly the concurrent ones.
3. `hook.memoizedState = nextSnapshot`; creates `StoreInstance {value, getSnapshot}` on
   `hook.queue`.
4. Schedules a passive effect `subscribeToStore` (via `mountEffect`, deps `[subscribe]`,
   `ReactFiberHooks.js:1708`).
5. Pushes a second raw passive effect `updateStoreInstance` unconditionally
   (`fiber.flags |= PassiveEffect; pushSimpleEffect(HookHasEffect|HookPassive, ...)`, 1715-1721).

### 1.3 updateSyncExternalStore (`ReactFiberHooks.js:1726-1810`)

1. Calls `getSnapshot()` every render (1748).
2. `snapshotChanged = !is(prevSnapshot, nextSnapshot)`; if changed:
   `hook.memoizedState = nextSnapshot; markWorkInProgressReceivedUpdate()` (1761-1766). This
   defeats React's bailout: the component always re-renders with the freshest value read at
   render time.
3. Re-pushes the `updateStoreInstance` passive effect if `inst.getSnapshot !== getSnapshot ||
   snapshotChanged || subscription effect scheduled` (1777-1791).
4. Pushes the consistency check again for non-blocking lanes (1804-1806) — every concurrent
   render of every component using uSES allocates a `StoreConsistencyCheck` and marks
   `StoreConsistency` on the fiber.

### 1.4 The three de-opt mechanisms (exact)

**(a) End-of-render consistency check → full synchronous re-render.**
`performWorkOnRoot` in `ReactFiberWorkLoop.js:1208-1230`:

```js
const finishedWork: Fiber = root.current.alternate;
if (renderWasConcurrent && !isRenderConsistentWithExternalStores(finishedWork)) {
  // A store was mutated in an interleaved event. Render again,
  // synchronously, to block further mutations.
  exitStatus = renderRootSync(root, lanes, false);
  renderWasConcurrent = false;
  continue;
}
```

`isRenderConsistentWithExternalStores` (`ReactFiberWorkLoop.js:1689-1746`) iteratively walks the
finished tree following `subtreeFlags & StoreConsistency`, and for each check runs
`is(getSnapshot(), renderedValue)`; a `getSnapshot` throw also counts as inconsistent (1716-1720).
Cost: a tree walk after **every** concurrent render that used uSES, plus — if any store changed
mid-render — throwing away the whole finished concurrent render and re-rendering the entire root
*synchronously* (blocking the main thread, no time slicing), even for a transition.

**(b) Store change notifications always schedule SyncLane.**
`subscribeToStore`'s `handleStoreChange` (`ReactFiberHooks.js:1860-1876`): on every store
notification it runs `checkIfSnapshotChanged(inst)` (calls latest `getSnapshot`, `is` compare
against the last *committed* value, 1878-1887), and if changed:

```js
// :1889-1894
function forceStoreRerender(fiber) {
  const root = enqueueConcurrentRenderForLane(fiber, SyncLane);
  if (root !== null) {
    scheduleUpdateOnFiber(root, fiber, SyncLane);
  }
}
```

There is no lane/transition attribution: a store change during an in-flight transition schedules
**SyncLane** work on the subscribed fiber. If the changed store affects the transition render
in progress, mechanism (a) additionally discards and sync-re-renders it. This is precisely why
uSES "de-opts" transitions: the store update cannot ride in the transition lane, so the UI
state visible during a transition can never include a store change without a sync flush.

**(c) Commit-time re-check in the passive phase.**
`updateStoreInstance` (`ReactFiberHooks.js:1838-1858`) runs as a passive effect, sets
`inst.value/getSnapshot` to what was rendered, then `checkIfSnapshotChanged` once more (catching
mutations between render and passive flush — e.g. from a layout effect) and calls
`forceStoreRerender` (SyncLane) if changed.

### 1.5 Also relevant

- On hydration, `getServerSnapshot` is required, no consistency check pushed; mismatch patched in
  a passive effect (1645-1662, 1737-1746).
- `enqueueConcurrentRenderForLane(fiber, lane)` (`ReactFiberConcurrentUpdates.js:165-171`)
  enqueues a null queue/update pair — i.e. "re-render this fiber at this lane" without payload —
  and returns the root by walking `fiber.return`.

---

## 2. The use() hook and the thenable state machine

### 2.1 Hook-side plumbing (`ReactFiberHooks.js`)

Module state (per component render):

```js
// :283-285
let thenableIndexCounter: number = 0;
let thenableState: ThenableState | null = null;
```

`use` (`:1150-1166`): thenable → `useThenable`; `REACT_CONTEXT_TYPE` → `readContext`; else throw.

`useThenable` (`:1094-1148`):
1. `index = thenableIndexCounter++` — the position of this `use()` call in the component
   (NOT part of the hook linked list; a parallel per-render counter).
2. Lazily `thenableState = createThenableState()` — in prod just `Array<Thenable>`
   (`ReactFiberThenable.js:35, 89-100`).
3. `trackUsedThenable(thenableState, thenable, index)`.
4. After a successful unwrap, dispatcher fixup (1116-1146): if there are no remaining
   work-in-progress hooks from the previous attempt, switch `ReactSharedInternals.H` from the
   rerender dispatcher back to mount/update dispatcher — because during a suspend-replay the
   hooks *before* the `use()` replay against saved state ("re-render" dispatcher), but hooks
   *after* the suspension point never ran and must mount/update normally.

### 2.2 trackUsedThenable (`ReactFiberThenable.js:107-305`) — the state machine

Statuses are expando fields on the promise itself (`status`, `value`, `reason`) — "an extension
of the Promise API" (comment 187-192).

1. **Index cache:** `trackedThenables[index]`; if a previous thenable exists at this index and
   `previous !== thenable`, the *new* thenable is dropped and the previous one reused
   ("components are idempotent", 117-157); the new one gets `.then(noop, noop)` to avoid
   unhandled rejections. DEV warns about uncached promises.
2. **`status === 'fulfilled'`** → return `thenable.value` (194-200).
3. **`status === 'rejected'`** → throw `thenable.reason` (201-220), with
   `checkIfUseWrappedInAsyncCatch` guarding against `SuspenseException` leaking through an
   async component (374-392, runs in prod).
4. **Unknown string status** → treat as pending, attach a dummy `.then(noop, noop)` (222-228).
5. **No status** → first-seen thenable:
   - Infinite ping-loop guard: `root.shellSuspendCounter > 100` → throw an error (233-255).
     (`shellSuspendCounter` is incremented once per *synchronous* render attempt that suspended
     in the shell, `ReactFiberWorkLoop.js:2725-2727`.)
   - Instrument: `status = 'pending'`, attach fulfill/reject handlers that write
     `status/value/reason` iff still `'pending'` (257-274).
6. **Re-check** in case it resolved synchronously (277-289).
7. **Suspend:**
   ```js
   // :298-302
   suspendedThenable = thenable;
   throw SuspenseException;
   ```
   `SuspenseException` (`:51`) is a singleton opaque Error; the real thenable is stashed in
   module state and retrieved by the work loop via `getSuspendedThenable()` (`:342-359`), which
   nulls it. This prevents userspace `try/catch` from capturing the thenable (DEV detects
   capture via `checkIfUseWrappedInTryCatch`, `:361-372`, called from `finishRenderingHooks`
   `ReactFiberHooks.js:730`).

Related singletons: `SuspenseyCommitException` (`:61`, suspensey host instances/resources),
`SuspenseActionException` (`:66`, useActionState), `noopSuspenseyCommitThenable` (`:78`).
`React.lazy` uses the same channel: `resolveLazy` (`:316-335`) catches a thrown thenable, sets
`suspendedThenable`, throws `SuspenseException`.

### 2.3 Work-loop handling: handleThrow → SuspendedReason

`ReactFiberWorkLoop.js:443-453`:

```js
NotSuspended=0, SuspendedOnError=1, SuspendedOnData=2, SuspendedOnImmediate=3,
SuspendedOnInstance=4, SuspendedOnInstanceAndReadyToContinue=5,
SuspendedOnDeprecatedThrowPromise=6, SuspendedAndReadyToContinue=7,
SuspendedOnHydration=8, SuspendedOnAction=9
```

`handleThrow` (`:2288-2416`) runs inside the catch of both work loops. It calls
`resetHooksAfterThrow()` (only resets `currentlyRenderingFiber` and the dispatcher —
`ReactFiberHooks.js:925-937`; hook lists are intentionally preserved for replay). Classification:
- `SuspenseException`/`SuspenseActionException` → swap in `getSuspendedThenable()`, reason =
  `SuspendedOnImmediate` (2309-2325).
- `SuspenseyCommitException` → `SuspendedOnInstance`.
- `SelectiveHydrationException` → `SuspendedOnHydration`.
- Thrown raw thenable (legacy pattern) → `SuspendedOnDeprecatedThrowPromise`; anything else →
  `SuspendedOnError` (2340-2354).
`workInProgressThrownValue = thrownValue; workInProgress` stays pointed at the suspended fiber.

### 2.4 Concurrent work loop resume-or-unwind (`renderRootConcurrent`, `:2765-3039`)

Top of each loop iteration, `resumeOrUnwind` switch (`:2816-2990`):
- **SuspendedOnImmediate** → set `SuspendedAndReadyToContinue`, `break outer` — i.e. yield to
  the main thread/microtask queue *without unwinding*, giving already-resolved (microtask)
  promises a chance to ping (2863-2869).
- **SuspendedOnData / SuspendedOnAction** (set by `shouldRemainOnPreviousScreen()` logic in
  ReactFiberBeginWork's throw path — reached when React decides to wait rather than show a
  fallback): if `isThenableResolved(thenable)` → `replaySuspendedUnitOfWork(unitOfWork)`;
  otherwise attach `onResolution` to the thenable which sets
  `workInProgressSuspendedReason = SuspendedAndReadyToContinue` (if still the same root) and
  `ensureRootIsScheduled(root)`, then `break outer` — the work loop literally parks with the
  suspended fiber's stack intact (2829-2862).
- **SuspendedAndReadyToContinue**: resolved → replay; not resolved → unwind
  (`throwAndUnwindWorkLoop`) (2875-2894).
- **SuspendedOnDeprecatedThrowPromise**: always unwind, never replay (2962-2976) — replay is
  exclusive to `use()`.
- **SuspendedOnError**: unwind (2817-2828).

### 2.5 Replay path (no unwind — this is what makes `use` cheap)

`replaySuspendedUnitOfWork` (`:3111-3128`) → `replayBeginWork` (`:3130-3218`):
- `FunctionComponent`/`SimpleMemoComponent`/`ForwardRef` →
  `replayFunctionComponent` (ReactFiberBeginWork) → `replaySuspendedComponentWithHooks`
  (`ReactFiberHooks.js:751-785`): does *not* reset hook state ("they weren't reset when we
  suspended"), clears `workInProgress.updateQueue = null` (776, so effects re-collect), then
  `renderWithHooksAgain`.
- `renderWithHooksAgain` (`:787-853`): loop with `RE_RENDER_LIMIT = 25` (`:292`); resets
  `thenableIndexCounter = 0` each pass (814); **only clears `thenableState` if a render-phase
  update was scheduled** (809-813) — so on replay, `use()` at index N gets back the same
  (now-fulfilled) thenable from the cache and unwraps synchronously. Uses the "Rerender"
  dispatcher, so hooks before the suspension replay against the partially-built WIP hook list.
- Note the replay bails out normally afterward: `replayFunctionComponent` also does
  `if (current !== null && !didReceiveUpdate) { bailoutHooks(...); return bailoutOnAlreadyFinishedWork(...) }`
  (`ReactFiberBeginWork.js:1565-1568`).
- `HostComponent` replay resets hooks (`resetHooksOnUnwind`) because its promises are known
  cached (3181-3193); other tags are fully reset via `unwindInterruptedWork` + fresh `beginWork`
  (3195-3211).

### 2.6 Re-render before resolution / unwinds

- If the work loop unwinds (fallback path), `resetHooksOnUnwind` (`ReactFiberHooks.js:939-977`)
  clears `queue.pending` for render-phase updates and resets
  `thenableIndexCounter/thenableState`. The *promise itself* stays instrumented; the retry
  render calls `use()` again, and if the component re-creates a new promise, the index cache in
  a fresh `thenableState` will adopt the new one (unless the fiber's previous attempt state is
  reused — the cache lives only for one render attempt; across attempts, memoization of the
  promise is the app/library's job, which is exactly why uncached promises warn and can
  infinite-loop).
- The sync work loop (`renderRootSync:2609-2753`) never waits and never replays-with-wait: any
  suspension immediately unwinds (`:2648-2710`), and suspending in the shell increments
  `root.shellSuspendCounter` (2725-2727). `SuspendedOnImmediate/Data/Action/DeprecatedThrowPromise`
  with no suspense handler sets `didSuspendInShell = true` (2680-2682).

---

## 3. Ping listeners and root retry

### 3.1 attachPingListener (`ReactFiberWorkLoop.js:4956-5000`)

```js
root.pingCache : WeakMap<Wakeable, Set<Lanes>>   // lanes act as "thread IDs"
```

Dedupe per (wakeable, renderLanes). Attaches `wakeable.then(ping, ping)` where
`ping = pingSuspendedRoot.bind(null, root, wakeable, lanes)`. Sets
`workInProgressRootDidAttachPingListener = true` (used to detect uncached-promise recovery
masking errors, `:1352-1360`).

### 3.2 pingSuspendedRoot (`:5002-5082`)

1. `pingCache.delete(wakeable)`, `markRootPinged(root, pingedLanes)` (sets `root.pingedLanes`;
   also feeds infinite-render-loop detection, `:1769-1786`).
2. If the pinged lanes equal the current in-progress render's lanes
   (`workInProgressRoot === root && isSubsetOfLanes(workInProgressRootRenderLanes, pingedLanes)`):
   - Restart-from-scratch if `workInProgressRootExitStatus === RootSuspendedWithDelay`, or
     (`RootSuspended` && only-retries && within `FALLBACK_THROTTLE_MS` of the last fallback):
     `prepareFreshStack(root, NoLanes)` — unless called from inside the render phase, in which
     case just record `workInProgressRootPingedLanes` (5037-5059).
   - Otherwise record `workInProgressRootPingedLanes` so `markRootSuspended` won't mark those
     lanes suspended (5060-5067; see `markRootSuspended` at 1788-1807 which removes pinged and
     interleaved-updated lanes).
3. `ensureRootIsScheduled(root)`.

### 3.3 Sync vs transition suspension — summary of differences

- **Transition render** (`shouldTimeSlice` true because transition lanes are not blocking,
  `:1150-1167`): concurrent work loop; `use()` suspension parks the loop
  (SuspendedOnData) or yields a microtask (SuspendedOnImmediate) and can replay in place;
  if it must unwind and there's no acceptable fallback (`shouldRemainOnPreviousScreen`,
  `:2418-2473`: shell boundary rules), exit status becomes `RootSuspendedWithDelay`, and
  `finishConcurrentRender` (`:1406-1467`) **does not commit** for transition/retry-only lanes —
  it `markRootSuspended`s and waits for a ping. Interleaved updates interrupt it
  (`scheduleUpdateOnFiber:1062-1076`).
- **Sync/blocking render**: `renderRootSync`; suspension unwinds immediately to the nearest
  fallback (no waiting); with no boundary, `markRootSuspended` at the shell and the work loop
  switches to prerendering (concurrent) on resume (`:1172-1187`); repeated shell suspends trip
  `shellSuspendCounter > 100` error.
- `scheduleUpdateOnFiber` (`:973-1010`): if the work loop is suspended on data/action or a
  commit is suspended (`root.cancelPendingCommit !== null`), ANY incoming update interrupts:
  `prepareFreshStack(root, NoLanes)` + `markRootSuspended`.

---

## 4. Suspense boundary capture and retry queues

### 4.1 throwException (`ReactFiberThrow.js:364-`)

- `sourceFiber.flags |= Incomplete` (372).
- Thenable branch (381-548): `resetSuspendedComponent` (203-239; propagates context changes to
  the deferred tree); `getSuspenseHandler()` (stack cursor in `ReactFiberSuspenseContext.js`,
  `shellBoundary` tracked at :37-40).
- **Suspense/Activity/SuspenseList boundary** (399-486):
  - Shell heuristics: suspended in shell → `renderDidSuspendDelayIfPossible()`
    (`ReactFiberWorkLoop.js:2538-2582`, sets `RootSuspendedWithDelay`, may flip
    `workInProgressRootIsPrerendering`); deeper + brand-new boundary → `renderDidSuspend()`
    (`RootSuspended`) (413-436).
  - `markSuspenseBoundaryShouldCapture` (241-362): concurrent mode = set
    `suspenseBoundary.flags |= ShouldCapture; suspenseBoundary.lanes = rootRenderLanes` (357-360).
    The unwind phase turns ShouldCapture→DidCapture and the boundary re-renders showing the
    fallback. (Legacy-mode branch does the DidCapture/ForceUpdateForLegacySuspense dance,
    260-313.)
  - **Retry queue:** `suspenseBoundary.updateQueue` is repurposed as `Set<Wakeable>`
    (470-476); plus `attachPingListener(root, wakeable, rootRenderLanes)` (482).
    Suspensey resources (`wakeable === noopSuspenseyCommitThenable`) instead set
    `ScheduleRetry` flag (465-468).
- **Offscreen boundary** (487-517): `ShouldCapture`, retryQueue on the OffscreenQueue,
  attachPingListener.
- **No boundary, concurrent root** (523-536): `attachPingListener` +
  `renderDidSuspendDelayIfPossible()` — suspends indefinitely without committing.
- Non-thenable: hydration recovery (552-609) then error-boundary walk (not copied here).

### 4.2 Retry after fallback commit

- Commit phase: when a Suspense boundary commits in fallback state,
  `attachSuspenseRetryListeners` (`ReactFiberCommitWork.js:1948-1978`, called at 2452, 2504,
  2622, 2637) walks the `retryQueue` and attaches
  `wakeable.then(retry, retry)` with `retry = resolveRetryWakeable.bind(null, finishedWork, wakeable)`,
  memoized in `retryCache` (boundary `stateNode` — a WeakSet).
- `resolveRetryWakeable` (`ReactFiberWorkLoop.js:5150-5185`) → `retryTimedOutBoundary`
  (`:5123-5139`): `retryLane = suspenseState.retryLane || claimNextRetryLane()`;
  `enqueueConcurrentRenderForLane(boundaryFiber, retryLane)`; `markRootUpdated`;
  `ensureRootIsScheduled`. Retry lanes are low priority; retry commits are throttled by
  `FALLBACK_THROTTLE_MS` (`finishConcurrentRender:1489-1543`, delayed via `root.timeoutHandle`).
- Two listener kinds coexist: **ping** (resolve while render in progress → maybe restart current
  render) and **retry** (resolve after fallback committed → schedule boundary re-render at
  retry lane).

---

## 5. useState/useReducer internals (performance parity target)

### 5.1 Structures (`ReactFiberHooks.js`)

```js
// :194 Hook
{ memoizedState, baseState, baseQueue: Update|null, queue, next }
// Update<S,A> (fields; see clones at :1410-1418)
{ lane, revertLane, gesture, action, hasEagerState, eagerState, next }  // circular list
// UpdateQueue<S,A> (:~172-180)
{ pending: Update|null, lanes: Lanes, dispatch, lastRenderedReducer, lastRenderedState }
```

Hooks are a singly-linked list on `fiber.memoizedState`. `mountWorkInProgressHook` (`:979-998`);
`updateWorkInProgressHook` (`:1000-1068`) clones from `current` hook (or reuses an existing WIP
hook after a render-phase update / replay).

### 5.2 Dispatch from outside render

`dispatchSetState` (`:3602-3630`) → `requestUpdateLane(fiber)` → `dispatchSetStateInternal`
(`:3632-3702`):

- **Eager state fast path** (3651-3692): only when `fiber.lanes === NoLanes &&
  (alternate === null || alternate.lanes === NoLanes)` (queue known empty). Computes
  `eagerState = lastRenderedReducer(queue.lastRenderedState, action)`, stashes
  `update.hasEagerState = true; update.eagerState = eagerState`. If
  `is(eagerState, currentState)` → `enqueueConcurrentHookUpdateAndEagerlyBailout` and **no
  render is scheduled at all** (return false). The update is still queued in case a later
  rebase happens with a different reducer.
  `enqueueConcurrentHookUpdateAndEagerlyBailout` (`ReactFiberConcurrentUpdates.js:127-151`)
  additionally drains the concurrent queue immediately if no render is in progress (leak
  prevention).
- Otherwise `enqueueConcurrentHookUpdate` + `scheduleUpdateOnFiber(root, fiber, lane)` +
  `entangleTransitionUpdate` (3694-3699).
- `dispatchReducerAction` (`:3559-3600`) is identical minus the eager path (reducer may be
  unstable).
- **Render-phase updates**: `isRenderPhaseUpdate` (`:3814-3820`) = fiber or its alternate is
  `currentlyRenderingFiber`; then `enqueueRenderPhaseUpdate` (`:3822-3840`) appends to
  `queue.pending` (circular) and sets `didScheduleRenderPhaseUpdateDuringThisPass`, which makes
  `renderWithHooks` loop via `renderWithHooksAgain` (`:602-611`) and `rerenderReducer`
  (`:1578-1633`) consume `queue.pending` entirely within the same render.

Concurrent update staging (`ReactFiberConcurrentUpdates.js`): `enqueueUpdate` (`:90-113`) pushes
(fiber, queue, update, lane) into a flat module array and merges `lane` into
`fiber.lanes`/`alternate.lanes` immediately (for eager-bailout checks). The queue is spliced into
`queue.pending` and `childLanes` are marked up the return path only in
`finishQueueingConcurrentUpdates` (`:50-84`), called when the render finishes/starts
(`prepareFreshStack:2270`, end of both work loops) — so updates arriving mid-render never corrupt
the in-progress pass.

### 5.3 updateReducerImpl (`:1303-1576`) — rebase machinery

- Merge `queue.pending` into `current.baseQueue` (1320-1346; note it's stored on the **current**
  hook so an aborted render doesn't lose updates).
- Walk the circular list from `baseQueue.next`:
  - `shouldSkipUpdate = !isSubsetOfLanes(renderLanes, updateLane)` (hidden-tree updates get an
    OffscreenLane bit removed first, 1371-1379). Skipped → clone into new base queue, first skip
    freezes `newBaseState`; re-merge `updateLane` into `currentlyRenderingFiber.lanes` and
    `markSkippedUpdateLanes` (1406-1432).
  - Applied-after-a-skip → clone with `lane: NoLane` so it's always re-applied on rebase (1442-1456).
  - `update.hasEagerState` → use `update.eagerState` instead of calling the reducer (1521-1527).
  - `revertLane` handling for useOptimistic (1464-1514).
  - Entangled async action: applying an update whose lane equals `peekEntangledActionLane()`
    and producing a changed state throws `entangledActionThenable` — i.e. useState can
    *suspend* on a pending action (1461-1463, 1550-1558).
- **Bailout signal**: `if (!is(newState, hook.memoizedState)) markWorkInProgressReceivedUpdate()`
  (1541-1542). The component-level bailout is in `updateFunctionComponent`
  (`ReactFiberBeginWork.js:1522-1525`):
  ```js
  if (current !== null && !didReceiveUpdate) {
    bailoutHooks(current, workInProgress, renderLanes);
    return bailoutOnAlreadyFinishedWork(current, workInProgress, renderLanes);
  }
  ```
  `bailoutHooks` (`ReactFiberHooks.js:904-923`) restores `updateQueue` from current and strips
  Passive/Update flags; `bailoutOnAlreadyFinishedWork` (`ReactFiberBeginWork.js:3789-3828`)
  returns null (skip subtree) if `!includesSomeLane(renderLanes, workInProgress.childLanes)`
  after lazy context propagation.
  NB: even on bailout the component function **has already run** — the cheaper pre-run bailout is
  `attemptEarlyBailoutIfNoScheduledUpdate` (`:3921`) gated by `checkScheduledUpdateOrContext`
  (`:3902-3919`: `current.lanes ∩ renderLanes` or context change).
- `finishRenderingHooks` (`ReactFiberHooks.js:710-727`) adds the context-change check to
  `didReceiveUpdate` if props/state didn't change.
- `requestUpdateLane` (`ReactFiberWorkLoop.js:810-854`): render-phase →
  `pickArbitraryLane(workInProgressRootRenderLanes)`; inside `startTransition`
  (`ReactSharedInternals.T !== null`) → `requestTransitionLane(transition)` (one transition lane
  per event, `ReactFiberRootScheduler.js:114`); else `eventPriorityToLane(resolveUpdatePriority())`
  (current event priority; `ReactEventPriorities.js`: Discrete=SyncLane, Continuous=
  InputContinuousLane, Default=DefaultLane).
- `entangleTransitionUpdate` (`ReactFiberHooks.js:3843-3866`): if transition lane, entangle
  `queue.lanes |= lane` and `markRootEntangled` — this is why all transition updates to the same
  hook queue finish together.

---

## 6. Effect scheduling and commit order

Hook effect tags (`ReactHookEffectTags.js`): `HasEffect=0b0001, Insertion=0b0010, Layout=0b0100,
Passive=0b1000`. Effects: `{tag, inst: {destroy}, create, deps, next}` circular list on
`fiber.updateQueue.lastEffect` (`pushEffectImpl`, `ReactFiberHooks.js:2581-2598`).
`updateEffectImpl` (`:2633-2671`): deps equal → re-push effect *without* `HookHasEffect` and no
fiber flags (nothing will fire); deps changed/absent → `fiber.flags |= fiberFlags` and push with
`HookHasEffect`.

Fiber flags per hook: useEffect → `PassiveEffect|PassiveStaticEffect` / `PassiveEffect`
(`:2673-2702`); useInsertionEffect → `UpdateEffect` + HookInsertion (`:2758-2770`);
useLayoutEffect → `UpdateEffect|LayoutStaticEffect` + HookLayout (`:2772-2791`).

### Commit pipeline (`ReactFiberWorkLoop.js`)

`commitRoot` (`:3711-3908`), phases run with `executionContext |= CommitContext`,
`setCurrentUpdatePriority(DiscreteEventPriority)`, `ReactSharedInternals.T = null`:

1. `markRootFinished`; **schedule passive-effects callback first** (NormalSchedulerPriority
   scheduler callback → `flushPassiveEffects`, 3757-3807 — "Do this as early as possible, so it
   is queued before anything else that might get scheduled in the commit phase").
2. **Before-mutation** (`commitBeforeMutationEffects`, 3849-3867): getSnapshotBeforeUpdate etc.
3. **Mutation** — `flushMutationEffects` (`:3995-4039`): `commitMutationEffects`. For a
   FunctionComponent with Update flag the order inside the mutation phase is
   (`ReactFiberCommitWork.js:2083-2096`):
   insertion-unmount → insertion-mount → **layout-unmount** (destroy of useLayoutEffect).
   Then `root.current = finishedWork` (4037).
4. **Layout** — `flushLayoutEffects` (`:4041-4138`): `commitLayoutEffects` → layout-mount
   (useLayoutEffect create), class componentDidMount/Update, refs.
5. `flushSpawnedWork` (`:4140-4432`): `requestPaint()`;
   - if `includesSyncLane(pendingEffectsLanes)` → `flushPendingEffects()` — **passive effects of
     a discrete/sync render are flushed synchronously at the end of the commit task, before
     paint** (4302-4315);
   - `ensureRootIsScheduled(root)`;
   - nested-update accounting: finished render included UpdateLanes && remaining includes
     SyncUpdateLanes → `nestedUpdateCount++` (limit `NESTED_UPDATE_LIMIT = 50`, `:749`;
     `throwIfInfiniteUpdateLoopDetected:5208-5272` throws "Maximum update depth exceeded");
   - `flushSyncWorkOnAllRoots()` (4387) — **updates scheduled by layout effects (which run at
     DiscreteEventPriority ⇒ SyncLane) render+commit synchronously here, before the browser
     paints**.
6. **Passive** — `flushPassiveEffects` (`:4677-4712`):
   ```js
   const renderPriority = lanesToEventPriority(pendingEffectsLanes);
   const priority = lowerEventPriority(DefaultEventPriority, renderPriority);
   setCurrentUpdatePriority(priority); ReactSharedInternals.T = null;
   ```
   ⇒ setState inside useEffect gets **DefaultLane at most** (or transition-ish lower if the
   render was lower-priority) — never SyncLane. `flushPassiveEffectsImpl` (`:4714-4861`):
   `commitPassiveUnmountEffects(root.current)` for the whole tree, then
   `commitPassiveMountEffects` (4774-4781); throws if called while rendering (4735-4737);
   afterwards `flushSyncWorkOnAllRoots()` (4804) so any sync-lane work spawned by passive
   effects flushes at the end of the passive flush; DEV `nestedPassiveUpdateCount` warning.
   Note view transitions can defer mutation/layout/spawned phases into `startViewTransition`
   callbacks (3881-3900); otherwise all three run synchronously back-to-back (3901-3907).

### Update priority during commit — summary

- Mutation/before-mutation/layout phases: currentUpdatePriority = DiscreteEventPriority ⇒
  `requestUpdateLane` returns **SyncLane**; flushed pre-paint via `flushSyncWorkOnAllRoots()` at
  the end of `flushSpawnedWork`.
- Passive phase: currentUpdatePriority = Default (or lower) ⇒ **DefaultLane**; a new render is
  scheduled normally via `ensureRootIsScheduled` (microtask → task,
  `ReactFiberRootScheduler.js:116-169, 259-`); sync-only work flushed at end of passive flush.
- `markRootUpdated` during Render/Commit context feeds
  `workInProgressRootDidIncludeRecursiveRenderUpdate` / `didIncludeCommitPhaseUpdate`
  (`:1754-1767`) which is a second infinite-loop heuristic (`NESTED_UPDATE_PHASE_SPAWN`,
  4347-4366).
- `useInsertionEffect` must not schedule updates (DEV error, `scheduleUpdateOnFiber:978-982`).

---

## 7. Root scheduler notes (`ReactFiberRootScheduler.js`)

- `ensureRootIsScheduled` (`:116-152`): adds root to a global linked list, sets
  `mightHavePendingSyncWork = true`, schedules ONE microtask (`ensureScheduleIsScheduled`,
  `:154-169`) that runs `processRootScheduleInMicrotask` (`:259-`): per-root
  `scheduleTaskForRootDuringMicrotask` picks callback priority from lanes; sync lanes are
  flushed in an immediate task/microtask via `flushSyncWorkAcrossRoots_impl` (`:185-247`).
- `prepareFreshStack` (`ReactFiberWorkLoop.js:2009-2279` incl. profiling): cancels
  `root.timeoutHandle` and `root.cancelPendingCommit`, resets all `workInProgressRoot*` module
  state, `entangledRenderLanes = getEntangledLanes(root, lanes)`, and
  `finishQueueingConcurrentUpdates()` (2224-2270).

---

## 8. Implications for react-signals (facts only, no design)

- The uSES tax = (1) per-concurrent-render `StoreConsistencyCheck` allocations + StoreConsistency
  tree walk, (2) any interleaved store write → discard + full **sync** re-render of the root,
  (3) all store-change notifications → SyncLane (no transition attribution), (4) an extra
  unconditional passive effect per store per commit re-checking the snapshot.
- `use()` gives concurrent-safe suspension with in-place replay; its cache is positional
  (`thenableIndexCounter`) and attempt-scoped (`thenableState`), reset in `finishRenderingHooks`
  (`ReactFiberHooks.js:700-701`) and `resetHooksOnUnwind` (975-976). Promise identity across
  attempts must come from userspace memoization.
- Bailout parity requires: per-hook `is()` compare feeding `markWorkInProgressReceivedUpdate`,
  the fiber.lanes-based early bailout, and the eager-state pre-render bailout
  (`fiber.lanes===NoLanes` check) — all of which key off React-owned fiber fields.
- Every "external" scheduling entry point React itself uses:
  `enqueueConcurrentHookUpdate`/`enqueueConcurrentRenderForLane` + `scheduleUpdateOnFiber`
  (updates), `markRootPinged`+`ensureRootIsScheduled` (pings),
  `enqueueConcurrentRenderForLane`+`markRootUpdated` (retries).
- Infinite-loop integration points: `throwIfInfiniteUpdateLoopDetected`
  (NESTED_UPDATE_LIMIT=50, called from `getRootForUpdatedFiber` on every update and from
  `markRootUpdated` under the `enableInfiniteRenderLoopDetection` flag), RE_RENDER_LIMIT=25 for
  render-phase update loops, `shellSuspendCounter > 100` for ping loops, DEV
  `nestedPassiveUpdateCount` for passive loops.
