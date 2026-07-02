# React internals research: lanes, update scheduling, transitions

Target: `vendor/react` submodule at commit `7ce677d406` ("[Fizz] Guard the shell-error callbacks…"), package version **19.3.0** (post-19.2 main; includes View Transitions, Gesture Transitions, warm lanes / sibling-prerendering rewrite). All paths below are relative to `vendor/react/`. Line numbers are exact for this commit.

Note on syntax: the codebase is Flow but this checkout uses `as any`-style casts (TS-flavored Flow tooling); files are still `@flow` headers + Flow types.

---

## 1. The lane model (packages/react-reconciler/src/ReactFiberLane.js)

### 1.1 Lane constants (ReactFiberLane.js:41-115)

31 lanes total (`TotalLanes = 31`, line 41). Lower bit = higher priority.

| Lane | Bit | Line |
|---|---|---|
| `SyncHydrationLane` | 0b…001 | 46 |
| `SyncLane` | 0b…010 | 47 (`SyncLaneIndex = 1`, line 48) |
| `InputContinuousHydrationLane` / `InputContinuousLane` | bits 2/3 | 50-51 |
| `DefaultHydrationLane` / `DefaultLane` | bits 4/5 | 53-54 |
| `SyncUpdateLanes = SyncLane \| InputContinuousLane \| DefaultLane` | | 56-57 |
| `GestureLane` | bit 6 | 59 |
| `TransitionHydrationLane` | bit 7 | 61 |
| `TransitionLanes` (14 lanes, bits 8–21) | | 62-76 |
| → `TransitionUpdateLanes` = TransitionLane1–10 | | 80-90 |
| → `TransitionDeferredLanes` = TransitionLane11–14 (reserved for useDeferredValue-spawned work) | | 91-92 |
| `RetryLanes` (4 lanes, bits 22–25) | | 94-98 |
| `SelectiveHydrationLane` | bit 26 | 102 |
| `NonIdleLanes` mask | | 104 |
| `IdleHydrationLane` / `IdleLane` | bits 27/28 | 106-107 |
| `OffscreenLane` | bit 29 | 109 |
| `DeferredLane` | bit 30 | 110 |
| `UpdateLanes = SyncLane \| InputContinuousLane \| DefaultLane \| TransitionUpdateLanes` — "any lane that might schedule an update… used to detect infinite update loops" | | 112-115 |

`EventPriority` **is** a Lane (packages/react-reconciler/src/ReactEventPriorities.js:22-28): `DiscreteEventPriority = SyncLane`, `ContinuousEventPriority = InputContinuousLane`, `DefaultEventPriority = DefaultLane`, `IdleEventPriority = IdleLane`, `NoEventPriority = NoLane`. `eventPriorityToLane` is the identity (line 51-53). `lanesToEventPriority` (line 55-67) buckets lanes back to the 4 priorities.

### 1.2 Lane assignment cursors (ReactFiberLane.js:176-178, 726-754)

```js
let nextTransitionUpdateLane: Lane = TransitionLane1;   // line 176
let nextTransitionDeferredLane: Lane = TransitionLane11; // 177
let nextRetryLane: Lane = RetryLane1;                    // 178
```

- `claimNextTransitionUpdateLane()` (ReactFiberLane.js:726-736): returns cursor, shifts left, wraps to TransitionLane1 when it leaves `TransitionUpdateLanes`. **This is what used to be called `claimNextTransitionLane`.** Module-global, shared by all roots.
- `claimNextTransitionDeferredLane()` (738-745): same over TransitionLane11–14.
- `claimNextRetryLane()` (747-754): same over RetryLanes.

### 1.3 FiberRoot lane fields (packages/react-reconciler/src/ReactInternalTypes.js:240-262)

`callbackNode`, `callbackPriority: Lane`, `expirationTimes: LaneMap<number>`, `hiddenUpdates: LaneMap<Array<ConcurrentUpdate>|null>`, `pendingLanes`, `suspendedLanes`, `pingedLanes`, `warmLanes`, `expiredLanes`, `indicatorLanes`, `errorRecoveryDisabledLanes`, `shellSuspendCounter`, `entangledLanes`, `entanglements: LaneMap<Lanes>`, plus `next: FiberRoot|null` (root schedule linked list), `cancelPendingCommit`, `timeoutHandle`.

---

## 2. requestUpdateLane — the full decision tree

`requestUpdateLane(fiber)` — packages/react-reconciler/src/ReactFiberWorkLoop.js:810-854:

```js
export function requestUpdateLane(fiber: Fiber): Lane {
  const mode = fiber.mode;
  if (!disableLegacyMode && (mode & ConcurrentMode) === NoMode) {
    return SyncLane;                                   // 1. legacy mode
  } else if (
    (executionContext & RenderContext) !== NoContext &&
    workInProgressRootRenderLanes !== NoLanes
  ) {
    // 2. render-phase update: adopt the current render's "thread"
    return pickArbitraryLane(workInProgressRootRenderLanes);   // line 828
  }
  const transition = requestCurrentTransition();       // reads ReactSharedInternals.T
  if (transition !== null) {
    // (gesture transitions throw here, line 833-842)
    return requestTransitionLane(transition);          // 3. transition, line 850
  }
  return eventPriorityToLane(resolveUpdatePriority()); // 4. event priority
}
```

Decision tree in order:
1. **Legacy (non-concurrent) fiber** → `SyncLane` (813-814).
2. **Render-phase update** (executionContext has `RenderContext` AND a render is in progress) → `pickArbitraryLane(workInProgressRootRenderLanes)` (815-829) — i.e. the highest-priority bit of the lanes currently being rendered (`pickArbitraryLane` = `getHighestPriorityLane` = `lanes & -lanes`, ReactFiberLane.js:756-774). Comment: "not officially supported… gives this the same 'thread' as whatever is currently rendering."
3. **Inside a transition** (`ReactSharedInternals.T !== null`, read via `requestCurrentTransition()` in packages/react-reconciler/src/ReactFiberTransition.js:193-195) → `requestTransitionLane(transition)` (see §3.2). In `__DEV__`, the fiber is added to `transition._updatedFibers` (843-848). If `transition.gesture` is set, throws (833-842).
4. **Otherwise** → `eventPriorityToLane(resolveUpdatePriority())` (853). `resolveUpdatePriority` is a host-config function; DOM impl at packages/react-dom-bindings/src/client/ReactDOMUpdatePriority.js:35-45: return `ReactDOMSharedInternals.p` (currentUpdatePriority) if set, else derive from `window.event` via `getEventPriority(event.type)` (packages/react-dom-bindings/src/events/ReactDOMEventListener.js:312+; discrete events like click → `DiscreteEventPriority`=SyncLane, scroll/mousemove → `ContinuousEventPriority`, everything else → `DefaultEventPriority`=DefaultLane). `ReactDOMSharedInternals.p` is set by DOM event dispatch (ReactDOMEventListener.js:121-139) and by `flushSync`/`discreteUpdates` etc.

Related forks:
- `requestRetryLane(fiber)` (ReactFiberWorkLoop.js:856-868) → `claimNextRetryLane()`.
- `requestDeferredLane()` (870-907): one deferred lane per render, cached in `workInProgressDeferredLane`; OffscreenLane while prerendering, else `claimNextTransitionDeferredLane()`; sets `DidDefer` flag on the enclosing suspense handler.

Where it's called from hooks: `dispatchReducerAction` (packages/react-reconciler/src/ReactFiberHooks.js:3576), `dispatchSetState` (3619), `startTransition`'s inner setState calls (3176, 3183, 3199).

---

## 3. Transitions

### 3.1 ReactSharedInternals.T and startTransition

Shape defined at packages/react/src/ReactSharedInternalsClient.js:24-56:

```js
export type SharedStateClient = {
  H: null | Dispatcher,        // current hooks dispatcher
  A: null | AsyncDispatcher,   // cache/owner dispatcher
  T: null | Transition,        // current transition ("ReactCurrentBatchConfig")
  S: null | onStartTransitionFinish,        // (Transition, returnValue) => void
  G: null | onStartGestureTransitionFinish, // gesture; only when enableGestureTransition
  // DEV-only: actQueue, asyncTransitions (count), isBatchingLegacy,
  // didScheduleLegacyUpdate, didUsePromise, thrownErrors, getCurrentStack,
  // recentlyCreatedOwnerStacks
};
```

Instance created at line 60-68 (prod fields: `H, A, T, S` (+`G`)); DEV fields added 70-80. Exposed as `React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE` (packages/react/src/ReactClient.js:110). The reconciler and react-dom import it via packages/shared/ReactSharedInternals.js, which just re-reads that property off the `react` package. **This is the established isomorphic channel between `react` and any renderer — the natural mount point for our patch.**

`Transition` object type (packages/react/src/ReactStartTransition.js:30-37): `{types, gesture, name, startTime, _updatedFibers(DEV)}`. Note: **the Transition object itself carries no lane.**

`startTransition(scope, options)` (ReactStartTransition.js:45-118):
1. Save `prevTransition = ReactSharedInternals.T`; create `currentTransition` (fresh object per call); set `ReactSharedInternals.T = currentTransition` (line 73).
2. Call `scope()`; then call `ReactSharedInternals.S` (`onStartTransitionFinish`) with `(currentTransition, returnValue)` (77-80).
3. If `returnValue` is thenable: DEV `asyncTransitions++`, and `returnValue.then(noop, reportGlobalError)` (81-93).
4. `finally`: restore `ReactSharedInternals.T = prevTransition` (116). **T does NOT survive an await** — it's saved/restored synchronously around `scope()`.

The reconciler registers its `S` handler at module init (module side-effect!) in packages/react-reconciler/src/ReactFiberTransition.js:78-130 (`onStartTransitionFinishForReconciler`): chains previous `S` (multi-renderer composition, comment 58-77); calls `markTransitionStarted()`; if returnValue is a thenable → `entangleAsyncAction(transition, thenable)` (line 98).

The hook version `startTransition(fiber, queue, pendingState, finishedState, callback)` (packages/react-reconciler/src/ReactFiberHooks.js:3093-3238), used by `useTransition`:
- Bumps update priority to at least `ContinuousEventPriority` (3101-3104).
- Sets `ReactSharedInternals.T = currentTransition` then **dispatches an optimistic update** `dispatchOptimisticSetState(fiber, false, queue, pendingState)` (3137-3138) — that's how `isPending=true` commits synchronously (SyncLane) and reverts on the transition lane.
- Calls callback; calls `S`; if thenable, sets state to `chainThenableValue(thenable, finishedState)` (a thenable resolving to `false`) via `dispatchSetStateInternal(..., requestUpdateLane(fiber))` (3172-3177); else sets `finishedState` directly (3179-3184). Errors → dispatch a rejected thenable (3186-3200).
- `updateTransition()` (3419-3432): `isPending` = the state value; if it's a thenable, `useThenable(booleanOrThenable)` — **suspends the pending flag until the async action scope resolves.**

### 3.2 requestTransitionLane & when two startTransitions share a lane

`requestTransitionLane(transition)` — packages/react-reconciler/src/ReactFiberRootScheduler.js:698-724:

```js
if (currentEventTransitionLane === NoLane) {
  // All transitions within the same event are assigned the same lane.
  const actionScopeLane = peekEntangledActionLane();
  currentEventTransitionLane =
    actionScopeLane !== NoLane
      ? actionScopeLane                  // inside async action scope: reuse
      : claimNextTransitionUpdateLane(); // fresh lane
}
return currentEventTransitionLane;
```

`currentEventTransitionLane` (module state, RootScheduler.js:114) is reset to `NoLane` at the end of `processRootScheduleInMicrotask` (343-347). Therefore:
- **Two `startTransition` calls within the same browser event/task (before the scheduling microtask runs) get the SAME lane.**
- Transitions in different events get different lanes (cursor advances, cycling through 10 lanes).
- Any transition update while an async action scope is pending gets the **action scope's lane** (see §3.4).
- `didCurrentEventScheduleTransition()` (726-728) exposes whether the current event claimed one.

Also used by `useOptimistic` reverts (ReactFiberHooks.js:3759) and gesture scheduling.

### 3.3 Lane entanglement

Two mechanisms:

**(a) Per-hook-queue transition entanglement** — `entangleTransitionUpdate(root, queue, lane)` (ReactFiberHooks.js:3843-3866), called after every `dispatchSetState`/`dispatchReducerAction` that scheduled work (3595, 3697). If `lane` is a transition lane: `queue.lanes = (queue.lanes & root.pendingLanes) | lane`, then `markRootEntangled(root, queue.lanes)`. Meaning: **all still-pending transition lanes that have ever updated this same hook queue are entangled with each other** — you can never render one update to a useState without also including earlier pending transition updates to the same hook, preventing state tearing/reordering within one queue. Class equivalent: `entangleTransitions` in packages/react-reconciler/src/ReactFiberClassUpdateQueue.js:276-302 (called from setState/replaceState/forceUpdate, ReactFiberClassComponent.js:184,210,236) and root render: ReactFiberReconciler.js:456.

**(b) Root-level entanglement** — `markRootEntangled(root, entangledLanes)` (ReactFiberLane.js:1028-1057). Sets `root.entangledLanes |= entangledLanes` and for each lane already entangled with any of them, ORs the new set in (transitive: "If C is entangled with A, entangling A with B also entangles C with B").

Consumption: `getEntangledLanes(root, renderLanes)` (ReactFiberLane.js:427-475), called from `prepareFreshStack` (ReactFiberWorkLoop.js:2268) to compute `entangledRenderLanes` (the superset actually given to begin/complete work — exported `let entangledRenderLanes`, WorkLoop.js:484), and from `markRootSuspended` when `enableParallelTransitions` (WorkLoop.js:1794-1797). Guarantee (comment ReactFiberLane.js:440-459): a lane "is not allowed to render in a batch that does not also include the other lane"; **best-effort** — entanglement applied after partial-work check, so it won't interrupt an in-progress render.

Also: `markSpawnedDeferredLane` (ReactFiberLane.js:997-1026) entangles useDeferredValue-spawned lanes with `DeferredLane` + parent update lanes; `upgradePendingLanesToSync` (1059-1074) entangles lanes into SyncLane for `flushRoot`.

### 3.4 Async actions (await inside startTransition)

Module: packages/react-reconciler/src/ReactFiberAsyncAction.js.

State (lines 46-54): `currentEntangledListeners`, `currentEntangledPendingCount`, `currentEntangledLane: Lane`, `currentEntangledActionThenable: Thenable<void>`.

`entangleAsyncAction(transition, thenable)` (71-101): if no scope open, opens one: `currentEntangledLane = requestTransitionLane(transition)` (82) and creates the scope thenable. Each async action increments `currentEntangledPendingCount`; every returned thenable pings `pingEngtangledActionScope` (103-139) which, when count hits 0, fulfills the scope thenable, notifies listeners, resets `currentEntangledLane = NoLane`.

Comment (37-43): *"If there are multiple, concurrent async actions, they are entangled. All transition updates that occur while the async action is still in progress are treated as part of the action… without AsyncContext we can't tell which action an update corresponds to, so we entangle them all into one."*

**How updates after `await` still get transition treatment:** after an await, `ReactSharedInternals.T` is `null`, so `requestUpdateLane` falls to event priority for plain `setState` — BUT for updates dispatched inside a *new* nested `startTransition` (the idiomatic pattern; React 19's async actions re-enter via `T` being restored only synchronously)… the key mechanism is `requestTransitionLane` → `peekEntangledActionLane()` (RootScheduler.js:713): **any transition-lane request while the action scope is open reuses `currentEntangledLane`**, so all updates across the entire async action (in any event, any await gap, as long as they are inside some `startTransition` or `useOptimistic`) land on the *same lane*. Additionally `dispatchOptimisticSetState` explicitly tolerates `T === null` when `peekEntangledActionLane() !== NoLane` (ReactFiberHooks.js:3735-3745) — optimistic updates after an await are associated with the pending action.

**How rendering waits for the action:** in `updateReducerImpl`, when an applied update's lane equals `peekEntangledActionLane()` (ReactFiberHooks.js:1461-1463, or revertLane match at 1478-1480), it sets `didReadFromEntangledAsyncAction`; if the reduced state changed, React **throws `peekEntangledActionThenable()`** (1550-1558) — the component suspends until the whole action scope finishes. Same signal for `useTransition`'s isPending (thenable state → `useThenable`, 3426-3431).

DEV-only `ReactSharedInternals.asyncTransitions` counts in-flight async transitions (ReactStartTransition.js:39-43, 87-91).

### 3.5 Popstate special case

`processRootScheduleInMicrotask` (RootScheduler.js:259-348): if `currentEventTransitionLane` was claimed during a popstate event, `shouldAttemptEagerTransition()` (DOM impl: packages/react-dom-bindings/src/client/ReactFiberConfigDOM.js:781-800) makes React render that transition **synchronously** via `getNextLanesToFlushSync` (ReactFiberLane.js:363-410) to preserve scroll restoration.

---

## 4. During render: reading current render state

### 4.1 Module state (ReactFiberWorkLoop.js:418-501)

```js
export const NoContext = 0b000;       // 420
const BatchedContext  = 0b001;        // 421
export const RenderContext = 0b010;   // 422
export const CommitContext = 0b100;   // 423
let executionContext: ExecutionContext = NoContext;  // 435
let workInProgressRoot: FiberRoot | null = null;     // 437
let workInProgress: Fiber | null = null;             // 439
let workInProgressRootRenderLanes: Lanes = NoLanes;  // 441
export let entangledRenderLanes: Lanes = NoLanes;    // 484 (superset incl. hidden-tree lanes)
```

`workInProgressRootRenderLanes` is set in exactly these places:
- `prepareFreshStack(root, lanes)` — WorkLoop.js:2244 (`workInProgressRootRenderLanes = lanes`). prepareFreshStack also resets ~15 WIP variables (2238-2268) and computes `entangledRenderLanes = getEntangledLanes(root, lanes)` (2268).
- Reset to `NoLanes` when a render completes: renderRootSync (2747), renderRootConcurrent (3031), and in `commitRoot` when the committed root was the WIP root (3612).

**Accessors** (already exported from the work loop):
- `getWorkInProgressRootRenderLanes(): Lanes` — WorkLoop.js:774-776.
- `getWorkInProgressRoot(): FiberRoot | null` — 766-768.
- `getExecutionContext()` — 1823-1825.
- `isAlreadyRendering(): boolean` = `(executionContext & (RenderContext|CommitContext)) !== NoContext` — 1942-1946.
- `isInvalidExecutionContextForEventFunction()` = RenderContext only — 1948-1951.
- `getEntangledRenderLanes()` — 1961-1963.
- `getCommittingRoot()` — 770-772 (pendingEffectsRoot).
- `getRootWithPendingPassiveEffects()`, `getPendingPassiveEffectsLanes()` — 785-793.
- `hasPendingCommitEffects()` — 778-783.

### 4.2 How hooks learn the current render's lanes (existing mechanism — YES)

`renderWithHooks(current, wip, Component, props, secondArg, nextRenderLanes)` (ReactFiberHooks.js:502-631) sets hooks-module-globals `renderLanes = nextRenderLanes; currentlyRenderingFiber = workInProgress` (510-511); cleared in `finishRenderingHooks` (663-664). Hooks that consume it:
- `updateReducerImpl` (1303+): skips updates whose lane is not a subset of `renderLanes` (`!isSubsetOfLanes(renderLanes, updateLane)`, 1377-1379; hidden updates checked against `getWorkInProgressRootRenderLanes()` at 1378); skipped lanes re-marked on `currentlyRenderingFiber.lanes` and `markSkippedUpdateLanes` (1428-1432). Optimistic updates applied/reverted by `isSubsetOfLanes(renderLanes, revertLane)` (1469).
- `updateDeferredValueImpl` (3032-3080): `includesOnlyNonUrgentLanes(renderLanes)` decides defer-vs-use (3059).
- `isRenderingDeferredWork()` (2990-3002): checks `renderLanes` for `DeferredLane` and `getWorkInProgressRootRenderLanes()` for `UpdateLanes` — a precedent of a hook reading root render lanes directly.

So: **during component render, the render lanes are available via `getWorkInProgressRootRenderLanes()` (exported from WorkLoop) and are also passed down as `renderLanes`/`entangledRenderLanes` into beginWork (`performUnitOfWork` calls `beginWork(current, unitOfWork, entangledRenderLanes)`, WorkLoop.js:3085/3098) and `renderWithHooks`.** There is no *userspace* export of any of this; only the reconciler module scope.

**Detecting "inside render" from library code today:** no public API. Internals-based options: `executionContext & RenderContext` (needs patch to expose; `getExecutionContext` is reconciler-internal), or heuristic `ReactSharedInternals.H !== null && H !== ContextOnlyDispatcher` (dispatcher set during renderWithHooks:548-564, reset to `ContextOnlyDispatcher` at 656). Note render can also be detected via `isAlreadyRendering` (used by `react-dom`'s `flushSync` warning path).

### 4.3 Render-phase updates

Two distinct paths:
- **Same-fiber render-phase update** (setState on the component currently rendering): `isRenderPhaseUpdate(fiber)` (ReactFiberHooks.js:3814-3820) → `enqueueRenderPhaseUpdate` (3822-3840) stashes on `queue.pending` and sets `didScheduleRenderPhaseUpdateDuringThisPass`; renderWithHooks re-invokes the component in a loop via `renderWithHooksAgain` (602-611, 787+), limit `RE_RENDER_LIMIT = 25` (ReactFiberHooks.js:292, error at ~809). Never reaches `scheduleUpdateOnFiber`.
- **Other-fiber render-phase update**: goes through `requestUpdateLane` branch 2 (same lanes as current render) → `scheduleUpdateOnFiber` which records `workInProgressRootRenderPhaseUpdatedLanes` and DEV-warns (`warnAboutRenderPhaseUpdatesInDEV`) (WorkLoop.js:1015-1030).

---

## 5. Update scheduling pipeline

`dispatchSetState` (ReactFiberHooks.js:3602-3630) → `dispatchSetStateInternal` (3632-3702): create `Update {lane, revertLane, gesture, action, hasEagerState, eagerState, next}` (3638-3646); eager-state bailout when fiber+alternate lanes are 0 (3652-3692, `enqueueConcurrentHookUpdateAndEagerlyBailout`); else `enqueueConcurrentHookUpdate` → `scheduleUpdateOnFiber(root, fiber, lane)` → `entangleTransitionUpdate`.

Concurrent update queue (packages/react-reconciler/src/ReactFiberConcurrentUpdates.js): updates buffered in flat array `concurrentQueues` (45-46) + immediately merged into `fiber.lanes` (108-112); drained by `finishQueueingConcurrentUpdates()` (50-84) which links updates into circular `queue.pending` lists and walks `markUpdateLaneFromFiberToRoot` (189-250) to bump `childLanes` up the return path (and `markHiddenUpdate` for hidden trees). Drained from `prepareFreshStack` (WorkLoop.js:2270) and at render completion (2750, 3034). `getRootForUpdatedFiber` (252-276) walks to the HostRoot and **first calls `throwIfInfiniteUpdateLoopDetected(false)` (line 258)** — every setState passes through here.

`scheduleUpdateOnFiber(root, fiber, lane)` (WorkLoop.js:973-1099):
1. If work loop is suspended on data/action, or a commit is suspended (`root.cancelPendingCommit !== null`): `prepareFreshStack(root, NoLanes)` + `markRootSuspended(...)` — interrupt and restart from top (992-1010).
2. `markRootUpdated(root, lane)` (1013; wrapper at 1754-1767 adds infinite-loop instrumentation; `_markRootUpdated` in ReactFiberLane.js:825-849 sets `root.pendingLanes |= lane`, `indicatorLanes`, and — for any non-idle update — **clears `suspendedLanes`/`pingedLanes`/`warmLanes`** so everything is retried).
3. If render-phase update on WIP root → track `workInProgressRootRenderPhaseUpdatedLanes` (1015-1030). Else: track interleaved update lanes (`workInProgressRootInterleavedUpdatedLanes`, 1053-1061); if WIP root already `RootSuspendedWithDelay`, mark it suspended immediately (interrupt, 1062-1076); `ensureRootIsScheduled(root)` (1079).

Root scheduler (packages/react-reconciler/src/ReactFiberRootScheduler.js):
- `ensureRootIsScheduled` (116-152): put root in the linked list `firstScheduledRoot/lastScheduledRoot`, `mightHavePendingSyncWork = true`, schedule one microtask (`ensureScheduleIsScheduled` 154-169 → `scheduleImmediateRootScheduleTask` 650-696; Safari workaround: defers to a Scheduler macrotask if fired inside Render/Commit context, 672-686).
- `processRootScheduleInMicrotask` (259-348): per root → `scheduleTaskForRootDuringMicrotask` (384-509): `markStarvedLanesAsExpired` (ReactFiberLane.js:541-588, expiration times per lane; transitions expire in `transitionLaneExpirationMs`, sync-ish in `syncLaneExpirationMs`), `getNextLanes`, then either leave sync work for end-of-microtask flush (returns SyncLane, 442-456) or schedule a Scheduler callback at mapped priority (480-507, `performWorkOnRootViaSchedulerTask`). Sync work flushed at end of microtask via `flushSyncWorkAcrossRoots_impl` (185-247) unless a commit is mid-flight (`hasPendingCommitEffects()`, 339-341).
- `getNextLanes(root, wipLanes, rootHasPendingCommit)` (ReactFiberLane.js:249-361): picks highest-priority unblocked (non-suspended) pending lanes; pinged lanes next; then "prewarm" lanes (`warmLanes` = suspended lanes already fully attempted). **Interruption rule** (337-358): if already rendering `wipLanes` and new `nextLanes` are equal-or-lower priority — or nextLane is DefaultLane vs wip transition — keep `wipLanes` (don't interrupt).

`performWorkOnRoot(root, lanes, forceSync)` (WorkLoop.js:1123-1311): throws if called inside Render/Commit (1128-1130: `'Should not already be working.'`). `shouldTimeSlice` = not forceSync && no blocking lane && not expired, or prerendering (1154-1163) → `renderRootConcurrent` else `renderRootSync`. After exit: consistency check for `useSyncExternalStore` (`isRenderConsistentWithExternalStores`, 1689-1746 — walks fibers with `StoreConsistency` flag calling `getSnapshot` again; on mismatch **re-renders synchronously from scratch**, 1209-1230); error retry (recoverFromConcurrentError 1313-1392); then `finishConcurrentRender` (1406-1562) → `completeRootWhenReady` (1564-1687; may suspend the commit for suspensey resources / view transitions → `root.cancelPendingCommit`, `markRootSuspended`) → `commitRoot` (3711+).

---

## 6. Transition render lifecycle: commit, interrupt, restart

### 6.1 Where a WIP render is discarded

`renderRootConcurrent`/`renderRootSync` both begin with (WorkLoop.js:2773, 2621):

```js
if (workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes) {
  ...
  prepareFreshStack(root, lanes);   // throw away current WIP tree
} else {
  // continuation of existing work-in-progress
}
```

So: **an in-progress transition render is restarted from scratch (fiber tree WIP discarded) whenever the next chosen lanes differ from the ones it was started with.** An urgent (sync/input/default) update arriving mid-transition-render causes `getNextLanes` to return the urgent lane (higher priority ⇒ interruption rule at ReactFiberLane.js:344-357 doesn't protect the transition; only Default-vs-Transition is protected), the urgent render runs `prepareFreshStack(root, urgentLane)`, commits, and afterwards `ensureRootIsScheduled`/`getNextLanes` pick the transition lane again — the transition **re-renders from the beginning** (its updates are still in the hook queues / `root.pendingLanes`; nothing is lost except CPU work). Skipped/interleaved bookkeeping: `workInProgressRootInterleavedUpdatedLanes` (492), `workInProgressRootSkippedLanes` (490).

Special cases that interrupt immediately rather than at the next work-loop entry:
- New update while suspended-on-data or during suspended commit: `scheduleUpdateOnFiber` 992-1010 (prepareFreshStack(NoLanes) + markRootSuspended).
- New update while WIP status is `RootSuspendedWithDelay`: 1062-1076 (markRootSuspended → the WIP lanes become suspended, so getNextLanes switches).
- `renderDidSuspendDelayIfPossible` (2538-2585): if skipped/interleaved non-idle work exists, mark current render suspended mid-flight so the scheduler switches to the skipped updates.

### 6.2 markRootSuspended

Wrapper WorkLoop.js:1788-1807: removes pinged + interleaved-updated lanes from the suspended set (and with `enableParallelTransitions` expands to entangled lanes) then calls `_markRootSuspended` = ReactFiberLane.js:851-885: `root.suspendedLanes |= suspendedLanes; root.pingedLanes &= ~suspendedLanes;` if `didAttemptEntireTree` also `warmLanes |= suspendedLanes`; clears expiration times; marks spawned deferred lane.

Callers: performWorkOnRoot prerender path (1186), fatal error (1293), `finishConcurrentRender` for `RootSuspendedWithDelay`/`RootSuspendedAtTheShell` on transitions/retries (1443-1450: *"This is a transition, so we should exit without committing a placeholder… Delay indefinitely until we receive more data"*), retry throttle (1502), suspended commit (1664), renderDidSuspendDelayIfPossible (2575), scheduleUpdateOnFiber (1004, 1070), commitRoot spawned-deferred (3645).

Un-suspending: `markRootPinged` (ReactFiberLane.js:887-892) via ping listeners (`attemptToPingSuspendedRoot`); or any new update (`markRootUpdated` clears all suspendedLanes).

### 6.3 Exit statuses & commit

`RootExitStatus` (WorkLoop.js:425-432): InProgress 0, FatalErrored 1, Errored 2, Suspended 3, SuspendedWithDelay 4, Completed 5, SuspendedAtTheShell 6.
- Transition suspends in already-visible content (no fallback allowed to appear) → `RootSuspendedWithDelay` (via `renderDidSuspendDelayIfPossible`; `shouldRemainOnPreviousScreen` WorkLoop.js:2418-2450 decides) → does **not** commit; waits for ping/data.
- Suspends with a Suspense fallback available → `RootSuspended`; commits the fallback (unless retry-only throttling, 1489-1543, `FALLBACK_THROTTLE_MS = 300`).

`markRootFinished(root, finishedLanes, remainingLanes, spawnedLane, updatedLanes, suspendedRetryLanes)` (ReactFiberLane.js:894-995), called from commitRoot (~WorkLoop.js:3600s): `root.pendingLanes = remainingLanes`; **resets suspendedLanes/pingedLanes/warmLanes to NoLanes** ("Let's try everything again"); prunes `expiredLanes`, `entangledLanes`, `errorRecoveryDisabledLanes`, per-lane `entanglements[i]`/`expirationTimes[i]`, un-hides `hiddenUpdates`; re-suspends freshly-spawned retry lanes (977-994).

Commit phases (for the DOM-mutation-notification requirement): `commitRoot` (3711) sets `pendingEffectsStatus = PENDING_MUTATION_PHASE` (3880) → `flushMutationEffects` (3995: `commitBeforeMutationEffects` + `commitMutationEffects` happen inside; status → PENDING_LAYOUT_PHASE at 4038) → `flushLayoutEffects` (4041) → `flushSpawnedWork` (4140) → passive (`PENDING_PASSIVE_PHASE` 4195, `flushPassiveEffects` 4677). Statuses enumerated at 722-730. `executionContext |= CommitContext` during each phase.

---

## 7. Infinite update loop protection

State (WorkLoop.js:748-762):

```js
const NESTED_UPDATE_LIMIT = 50;            // 749
let nestedUpdateCount = 0;                 // 750
let rootWithNestedUpdates: FiberRoot|null; // 751
const NO_NESTED_UPDATE=0; NESTED_UPDATE_SYNC_LANE=1; NESTED_UPDATE_PHASE_SPAWN=2; // 755-758
const NESTED_PASSIVE_UPDATE_LIMIT = 50;    // 760 (DEV-only warning)
```

**Counting** happens at the end of `completeRoot` (commit), WorkLoop.js:4324-4371: if the finished render `includesSomeLane(lanes, UpdateLanes)` **and** `includesSomeLane(root.pendingLanes-after-commit, SyncUpdateLanes)` → `nestedUpdateCount++` (same root) else reset. I.e. "the commit of an update-caused render synchronously scheduled more sync-priority work." Secondary branch (4347-4366) counts render/commit-phase spawned updates when `enableInfiniteRenderLoopDetection` (flag currently `false`, shared/ReactFeatureFlags.js:146; ForceThrow variant line 152, also false — the instrumentation in markRootUpdated/markRootPinged WorkLoop.js:1754-1786 is inert by default).

**Throwing**: `throwIfInfiniteUpdateLoopDetected(isFromInstrumentation)` (WorkLoop.js:5208-5287): if `nestedUpdateCount > 50` → reset counters and `throw new Error('Maximum update depth exceeded. …')` (5265-5270 in the default flag configuration). Called from:
1. `getRootForUpdatedFiber` (ReactFiberConcurrentUpdates.js:258) — **on every enqueued hook/class update**, i.e. every `setState`.
2. `markRootUpdated`/`markRootPinged` wrappers (WorkLoop.js:1765, 1784) — only under `enableInfiniteRenderLoopDetection`.

DEV passive-effect loop warning: `nestedPassiveUpdateCount > 50` → console.error (5274-5286).

**Answer for signals**: yes — any signal write that is ultimately delivered through `dispatchSetState`/`dispatchReducerAction` (or class setState / root.render) automatically passes through `getRootForUpdatedFiber` → `throwIfInfiniteUpdateLoopDetected`, and its commits participate in the nested-update counting, so a signals→setState bridge inherits the protection for the *sync cascade* case (update-lane render commits scheduling sync work). It does NOT count: (a) transition-lane cascades that don't leave sync-priority pending work, (b) loops entirely outside React (signal→signal effects that never setState), (c) render-phase same-fiber loops (those hit `RE_RENDER_LIMIT = 25` in ReactFiberHooks.js:292 instead).

---

## 8. ReactSharedInternals & other userspace-visible channels (patch candidates / precedents)

- **ReactSharedInternals (client)** — see §3.1. Fields `H, A, T, S, G` + DEV extras. Defined packages/react/src/ReactSharedInternalsClient.js; re-exported by shared/ReactSharedInternals.js (`React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`); server variant exists for Fizz/Flight (ReactSharedInternalsServer). The reconciler both reads (`requestCurrentTransition` ReactFiberTransition.js:193; dispatcher pushes: `pushDispatcher`/`pushAsyncDispatcher` WorkLoop.js ~2480-2500; ReactFiberHooks renderWithHooks 546-564, finish 656) and writes callbacks into it at module load (ReactFiberTransition.js:78-130 for `S`; 148-191 for `G`). **`S` is the exact precedent for our patch: renderer registers a hook on the shared object, isomorphic `react` code calls it; multiple renderers chain.**
- **ReactDOMSharedInternals** (packages/react-dom/src/ReactDOMSharedInternals.js): `{d: HostDispatcher, p: currentUpdatePriority, findDOMNode}` — how react-dom shares the current update priority between its isomorphic entry points and the reconciler host config.
- **DevTools hook** (packages/react-reconciler/src/ReactFiberDevToolsHook.js): `__REACT_DEVTOOLS_GLOBAL_HOOK__.inject / onCommitFiberRoot / onPostCommitFiberRoot` (injectInternals 50-91, onCommitRoot 111, onPostCommitRoot 154) + `injectProfilingHooks` (211) exposing `markRenderStarted/Yielded/Stopped, markCommitStarted/Stopped, markLayoutEffectsStarted, markPassiveEffectsStarted, markComponentRenderStarted, markStateUpdateScheduled…` (217-475). **This is the fullest existing render/commit lifecycle surface visible outside the reconciler** — but global, singleton, devtools-oriented.
- **Public exports revealing scheduling**: `useSyncExternalStore` consistency check (`pushStoreConsistencyCheck` ReactFiberHooks.js:1812-1822 + `isRenderConsistentWithExternalStores` WorkLoop.js:1689) — the sanctioned tear-detection precedent; `react-dom` `flushSync`; `unstable_batchedUpdates`; `ReactFiberReconciler.injectIntoDevTools`. Nothing exported reveals current lanes or "am I in render" to userspace.
- Internal-but-exported-from-workloop getters useful for a minimal patch (already exist, just need re-export through a shared channel): `getWorkInProgressRootRenderLanes`, `getExecutionContext`, `isAlreadyRendering`, `getCommittingRoot`, `hasPendingCommitEffects`, `getPendingTransitionTypes` (795-797), `peekDeferredLane` (969-971), `didCurrentEventScheduleTransition` (RootScheduler.js:726), `peekEntangledActionLane/Thenable` (AsyncAction.js:189-195).

---

## 9. Suspense plumbing notes (for promises inside computeds)

- `use(thenable)` → `useThenable` (ReactFiberHooks.js:1094-1148) → `trackUsedThenable` (packages/react-reconciler/src/ReactFiberThenable.js:107+): instruments thenable with `status/value/reason`; if still pending → stash `suspendedThenable` and `throw SuspenseException` (opaque sentinel Error, ReactFiberThenable.js:51, throw at 302). `SuspenseActionException` (line 66) variant for actions.
- `handleThrow` (WorkLoop.js:2288-2416): SuspenseException → `workInProgressSuspendedReason = SuspendedOnImmediate` (2325). SuspendedReason enum 443-453. **In this snapshot, `SuspendedOnData`/`SuspendedOnAction` are never assigned** (only compared) — the "suspend the work loop on data" optimization is disabled pending sibling-prerendering compat (comment 2319-2324); instead: yield, microtask-check, then `SuspendedAndReadyToContinue` → either `replaySuspendedUnitOfWork` (2836, 2881) if resolved or `throwAndUnwindWorkLoop` (3220+) to a fallback / prerender.
- Thrown-thenables from entangled async actions surface through updateReducerImpl (1550-1558) — see §3.4.
- Retries: fallback commit registers retry listener; `requestRetryLane`; `markSpawnedRetryLane` (3328-3336); throttled by `FALLBACK_THROTTLE_MS = 300` (526).

## 10. Misc facts worth keeping

- `pickArbitraryLane` = `getHighestPriorityLane(lanes)` = `lanes & -lanes` (ReactFiberLane.js:756-758, 768-774). Priority comparison: numerically smaller lane = higher priority (`higherPriorityLane` 810-813).
- `getHighestPriorityLanes` groups all `SyncUpdateLanes` together (181-184) and — unless `enableParallelTransitions` (flag false, FeatureFlags.js:224) — renders **all pending TransitionUpdateLanes 1-10 in one batch** (202-215: `return lanes & TransitionUpdateLanes`). So today separate transitions usually render together anyway once they're both pending.
- `enableGestureTransition` and `enableDefaultTransitionIndicator` are `__EXPERIMENTAL__` (FeatureFlags.js:87, 99).
- `flushSyncWork()` (WorkLoop.js:1934-1940) and `flushSyncFromReconciler` (1892-1930) — how flushSync enters; both check `executionContext` first.
- `batchedUpdates` is a no-op with `disableLegacyMode` (1840-1864).
- `deferredUpdates` (1827-1838) and `discreteUpdates` (1866-1886) both temporarily null out `ReactSharedInternals.T` and set update priority — pattern to copy for "run this signal flush at priority X".
- `RENDER_TIMEOUT_MS = 500` (533): time-slicing budget before CPU-suspense heuristics; concurrent loop yields every 25ms (non-idle)/5ms with `enableThrottledScheduling` (3042-3056) or via Scheduler `shouldYield` (3059-3065).
- Hook `Update` shape: `{lane, revertLane, gesture, action, hasEagerState, eagerState, next}` (ReactFiberHooks.js:3638-3646); `UpdateQueue`: `{pending, lanes, dispatch, lastRenderedReducer, lastRenderedState}` (3298-3309 shows the shape inline).
- `markSkippedUpdateLanes` (WorkLoop.js:2525-2530) accumulates `workInProgressRootSkippedLanes` — how React remembers there is lower-pri work left on visited fibers.
