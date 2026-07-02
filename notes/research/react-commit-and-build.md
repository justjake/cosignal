# React internals research: commit phase, patch points, shared internals, feature flags, build system

Submodule: `vendor/react` @ `7ce677d4` ("[Fizz] Guard the shell-error callbacks…", 2026-07-02). Version `19.3.0` (canary label `canary`), see `vendor/react/ReactVersions.js:21`.

All paths below are relative to `/Users/jitl/src/react-signals-fable/vendor/react/` unless absolute.

---

## 1. Commit phase sequence

### 1.1 Top-level flow (concurrent root)

```
performWorkOnRoot (ReactFiberWorkLoop.js:1123)
  → finishConcurrentRender (:1406)
    → completeRootWhenReady (:1564)      // may DELAY the commit ("suspended commit")
      → completeRoot (:3497)             // flushes any previous pending commit first (:3516-3524)
        → commitRoot (:3711)             // or applyGestureOnRoot (:4425) for gesture renders
```

`commitRoot` splits the commit into *resumable sub-phases* driven by a module-level
state machine `pendingEffectsStatus` (ReactFiberWorkLoop.js:722-730):

```js
const NO_PENDING_EFFECTS = 0;
const PENDING_MUTATION_PHASE = 1;
const PENDING_LAYOUT_PHASE = 2;
const PENDING_AFTER_MUTATION_PHASE = 3;
const PENDING_SPAWNED_WORK = 4;
const PENDING_PASSIVE_PHASE = 5;
const PENDING_GESTURE_MUTATION_PHASE = 6;
const PENDING_GESTURE_ANIMATION_PHASE = 7;
let pendingEffectsStatus = 0;
let pendingEffectsRoot: FiberRoot = null;   // :731
let pendingFinishedWork: Fiber = null;      // :732
let pendingEffectsLanes: Lanes = NoLanes;   // :733
```

Inside `commitRoot` (ReactFiberWorkLoop.js:3711-3908):

1. `markRootFinished(...)` (:3745), schedule the passive-effect callback early (:3792-3806,
   `scheduleCallback(NormalSchedulerPriority, … flushPassiveEffects)`) unless
   `enableYieldingBeforePassive`.
2. **Before-mutation phase** (:3849-3867): if `(finishedWork.subtreeFlags|flags) & (BeforeMutationMask|MutationMask)`,
   calls `commitBeforeMutationEffects(root, finishedWork, lanes)` (:3860) wrapped in
   `executionContext |= CommitContext`, `setCurrentUpdatePriority(DiscreteEventPriority)`,
   `ReactSharedInternals.T = null`.
3. `pendingEffectsStatus = PENDING_MUTATION_PHASE` (:3880).
4. **Fork** (:3881-3907):
   - View-transition commit (`enableViewTransition && shouldStartViewTransition`):
     `pendingViewTransition = startViewTransition(suspendedState, root.containerInfo, pendingTransitionTypes, flushMutationEffects, flushLayoutEffects, flushAfterMutationEffects, flushSpawnedWork, flushPassiveEffects, reportViewTransitionError, …)` (:3885-3900).
     The DOM host config (`packages/react-dom-bindings/src/client/ReactFiberConfigDOM.js:2160`)
     calls `ownerDocument.startViewTransition({ update() { … mutationCallback(); … } })`
     (ConfigDOM :2179, `mutationCallback()` at :2189). **The mutation & layout phases run
     asynchronously inside the browser's ViewTransition update callback.**
   - Normal path — synchronous (:3901-3907):
     ```js
     flushMutationEffects();
     flushLayoutEffects();
     // Skip flushAfterMutationEffects
     flushSpawnedWork();
     ```

### 1.2 The DOM-mutation window (what to bracket for MutationObserver)

`flushMutationEffects` — **ReactFiberWorkLoop.js:3995-4039**. This is the single choke
point through which every normal commit's DOM mutations flow:

```js
function flushMutationEffects(): void {
  if (pendingEffectsStatus !== PENDING_MUTATION_PHASE) return;
  pendingEffectsStatus = NO_PENDING_EFFECTS;
  ...
  if (subtreeMutationHasEffects || rootMutationHasEffect) {   // MutationMask check :4004-4006
    ... // priority + CommitContext save/restore
    commitMutationEffects(root, finishedWork, lanes);          // :4017  ← DOM mutations happen here
    ...
    resetAfterCommit(root.containerInfo);                      // :4024  ← restores selection, re-enables events
  }
  root.current = finishedWork;                                 // :4037  ← tree swap
  pendingEffectsStatus = PENDING_LAYOUT_PHASE;                 // :4038
}
```

- **(a) Moment just BEFORE React mutates the DOM:** entry of `flushMutationEffects`
  (ReactFiberWorkLoop.js:3995), or more precisely just before `commitMutationEffects` (:4017).
  Note the phase is *skipped entirely* when there are no MutationMask flags — a hook placed
  inside the `if` (:4008) fires only when mutations will actually occur, which is what a
  MutationObserver disconnect wants.
- **(b) Moment DONE mutating:** after `resetAfterCommit` (:4024) — i.e. end of the `if`
  block — or at latest before `pendingEffectsStatus = PENDING_LAYOUT_PHASE` (:4038).
  `resetAfterCommit` itself (ConfigDOM :450-455) only calls `restoreSelection` and
  `ReactBrowserEventEmitterSetEnabled(eventsEnabled)` — selection/property writes, **not**
  MutationObserver-visible tree/attribute mutations, so bracketing outside it is safe either way.

Because of the ViewTransition fork, hooks MUST live inside `flushMutationEffects` (not in
`commitRoot`), since with VT the mutation phase runs later inside
`document.startViewTransition`'s update callback.

There is a second synchronous entry: `flushPendingEffects` (ReactFiberWorkLoop.js:4648-4675)
forces all remaining phases (`flushGestureMutations(); flushGestureAnimations();
flushMutationEffects(); flushLayoutEffects(); flushSpawnedWork(); flushPassiveEffects()`) —
used by flushSync and before starting new work — but it still goes through
`flushMutationEffects`, so a hook there covers all paths.

### 1.3 What `commitMutationEffects` covers (it IS the complete tree-mutation story)

`commitMutationEffects` — **ReactFiberCommitWork.js:1997-2014**, recursing via
`recursivelyTraverseMutationEffects` (:2016) / `commitMutationEffectsOnFiber` (:2042).
Includes, all within the mutation phase:

- Deletions: `commitDeletionEffects` (:2027).
- Placements (insert/append/move): `commitReconciliationEffects` (:2760) →
  `commitHostPlacement` (:2769; impl `ReactFiberCommitHostEffects.js:631`).
- Host updates (attribute/prop diffs): `commitHostUpdate` calls at :2186, :2210, :2254
  (→ ConfigDOM `commitUpdate` :992 → `updateProperties`).
- Text updates: `commitHostTextUpdate` (:2308 → ConfigDOM `commitTextUpdate` :1011,
  `textInstance.nodeValue = newText`).
- `resetTextContent`: `commitHostResetTextContent` (:2241 → ConfigDOM :1007, `setTextContent(el,'')`).
- **Portals**: `commitHostPortalContainerChildren` (:1661, :2420) — portal children are
  committed in the same mutation traversal (persistent-mode only path uses `replaceContainerChildren`;
  in mutation mode portal children get Placement/Deletion like everything else).
- **Hydration commit work**: `commitHostHydratedContainer` (:2339, HostRoot `ForceClientRender`
  recovery — `retryIfBlockedOn`), `clearSuspenseBoundary`/`clearSuspenseBoundaryFromContainer`
  (:1629-1638, deleting dehydrated Suspense fallback DOM between comment markers),
  `commitHostRootContainerChildren` (:2345).
- Suspense visibility: `hideInstance`/`unhideInstance` (ConfigDOM :1399/:1422) — writes
  `instance.style.display` → **attribute mutation** (Offscreen/Suspense hide/show).
- Hoistables (Float): stylesheet/script insertion via `acquireResource`/hoistable mount inside
  the mutation phase (`currentHoistableRoot` machinery, ReactFiberCommitWork.js:2040+).
- `clearContainer` (ConfigDOM :3671) on root when needed.

DOM host mutation primitives: ConfigDOM `appendChild` :1025, `appendChildToContainer` :1075,
`insertBefore` :1128, `removeChild` :1206, `removeChildFromContainer` :1213 (uses
`moveBefore` when `enableMoveBefore`, :1019-1023).

### 1.4 React-driven DOM writes OUTSIDE the mutation window (caveats for MutationObserver)

These are the exceptions an implementer must know about:

1. **Layout phase `commitMount`** (`commitHostMount`, called from `commitLayoutEffectOnFiber`,
   ReactFiberCommitWork.js:686 region; ConfigDOM `commitMount` :884): for `<img>` with
   `onLoad`, re-assigns `domElement.src = src` / `.srcset` (ConfigDOM :938-943) → **attribute
   mutation in the LAYOUT phase**, not the mutation phase. Also `.focus()` for autoFocus
   (:901-909; not MutationObserver-visible). `commitHostHydratedInstance`
   (ReactFiberCommitWork.js:688; ConfigDOM `commitHydratedInstance` :949) patches
   input/select/textarea value/checked **properties** in layout phase (not observer-visible).
2. **Suspensey CSS before commit**: for a "suspended commit", `completeRootWhenReady`
   (WorkLoop :1564) calls `startSuspendingCommit()` (ConfigDOM :6278),
   `accumulateSuspenseyCommit` (:1604), then `waitForCommitToBeReady` (ConfigDOM :6447)
   which calls `insertSuspendedStylesheets` (:6455, impl :6582) — **inserts `<link rel=stylesheet>`
   into `<head>` after render but BEFORE `commitRoot`** (and again from timeouts, :6470/:6496).
   `suspendResource` creates the `<link>` element during this pre-commit walk (:6391).
3. **Imperative Float APIs** (`ReactDOM.preload/preinit/preinitScript/preinitStyle/…`):
   dispatched through `ReactDOMSharedInternals.d` and executed immediately when called —
   including **during the render phase** of a component. They append `<link>`/`<script>` to
   `document.head` (ConfigDOM :4951, :5046, :5103, :5109-5172, :5227, :5284).
4. **View Transitions (enableViewTransition=true by default, ReactFeatureFlags.js:81)**: when a
   commit is VT-eligible and `<ViewTransition>` is used, React writes
   `element.style.viewTransitionName/Class` (ConfigDOM `applyViewTransitionName` :1509-1524,
   restore :1672-1738) in the **before-mutation phase** (snapshot of exiting elements;
   `commitBeforeMutationEffects_begin` walks deletions, ReactFiberCommitWork.js:364-403), in the
   **after-mutation phase** (`commitAfterMutationEffects`, ReactFiberCommitWork.js:2799, called
   from `flushAfterMutationEffects` WorkLoop :3983-3993, only during a `startViewTransition`
   commit), and cancels/restores names when the transition finishes. These are `style`
   **attribute mutations** outside the mutation window.
5. **Gesture transitions (experimental, `enableGestureTransition = __EXPERIMENTAL__`,
   ReactFeatureFlags.js:87)**: separate commit path `applyGestureOnRoot` (WorkLoop :4425)
   calls `insertDestinationClones` (:4454) and `flushGestureMutations` → `applyDepartureTransitions`
   (:4499) — DOM clone insertion/removal outside the normal mutation phase.
6. **User code**: `getSnapshotBeforeUpdate` (before-mutation; `commitClassSnapshot` call at
   ReactFiberCommitWork.js:518), `useLayoutEffect`/`componentDidMount/Update` (layout phase,
   `commitLayoutEffects` ReactFiberCommitWork.js:2978, invoked from `flushLayoutEffects`
   WorkLoop :4111), `useEffect` (passive phase, `commitPassiveUnmountEffects` :4617 /
   `commitPassiveMountEffects` :3528, invoked from `flushPassiveEffectsImpl` WorkLoop
   :4774-4781) can all mutate DOM arbitrarily. React cannot bracket these for you; a
   patch hook pair should be documented as covering *React's own reconciliation mutations* only.

Summary for the patch: bracket `commitMutationEffects` + `resetAfterCommit` inside
`flushMutationEffects` (WorkLoop :4008-4031); optionally also bracket the layout-phase
`commitMount` img-src case, `insertSuspendedStylesheets`, Float dispatcher inserts, and VT
name application if "React-caused mutation" must be airtight rather than "reconciliation
mutations".

### 1.5 Phase order & the rest of the pipeline

- `flushLayoutEffects` (WorkLoop :4041-4138): default-transition-indicator cleanup
  (:4066-4091, runs `root.pendingIndicator` cleanup at Discrete priority), then
  `commitLayoutEffects` (:4111) if `LayoutMask` flags. Sets `PENDING_AFTER_MUTATION_PHASE` (:4137).
- `flushAfterMutationEffects` (:3983-3993): VT-only; `commitAfterMutationEffects` (:3991).
- `flushSpawnedWork` (:4140-…): `requestPaint()` (:4175); decides `PENDING_PASSIVE_PHASE` vs done
  (:4194-4207); **DevTools `onCommitRootDevTools(finishedWork.stateNode, renderPriority)` at :4235**;
  fires `root.onRecoverableError` for recoverable errors (:4247-…); `ensureRootIsScheduled`;
  infinite-update-loop accounting (`didIncludeCommitPhaseUpdate`, `NESTED_UPDATE_LIMIT = 50` :749).
- `flushPassiveEffects` (:4677) → `flushPassiveEffectsImpl` (:4714):
  `commitPassiveUnmountEffects(root.current)` (:4774), `commitPassiveMountEffects` (:4775),
  `flushSyncWorkOnAllRoots()` (:4804), **DevTools `onPostCommitRootDevTools(root)` :4853**.
- Useful existing exports from the work loop for a patch to reuse:
  `getCommittingRoot()` (:770), `hasPendingCommitEffects()` (:778),
  `getRootWithPendingPassiveEffects()` (:785), `getWorkInProgressRoot()` (:766),
  `getWorkInProgressRootRenderLanes()` (:774).

---

## 2. createRoot options plumbing (precedent for onBeforeMutation/onAfterMutation per-root callbacks)

Chain (all file:line exact):

1. **`packages/react-dom/src/client/ReactDOMRoot.js`** — `createRoot(container, options)`:
   option types `CreateRootOptions` :34-49 (`onUncaughtError` :34, `onCaughtError` :38,
   `onRecoverableError` :45, `onDefaultTransitionIndicator` :49); defaults assigned :184-187;
   options read :220-236 (`onDefaultTransitionIndicator` gated by
   `enableDefaultTransitionIndicator` :229-233); passed positionally to
   `createContainer(container, ConcurrentRoot, null, isStrictMode, …, onUncaughtError,
   onCaughtError, onRecoverableError, onDefaultTransitionIndicator, transitionCallbacks)` :239-251.
   Then `markContainerAsRoot(root.current, container)` :252 and
   `listenToAllSupportedEvents(rootContainerElement)` :258.
   `hydrateRoot` does the same at :296-360 → `createHydrationContainer` (:339-355, plus `formState`).
2. **`packages/react-reconciler/src/ReactFiberReconciler.js`** — `createContainer` :235-280
   (params :243-259) → `createFiberRoot(...)` :263-277; also
   `registerDefaultIndicator(onDefaultTransitionIndicator)` :278.
   `createHydrationContainer` :282-… (same plumbing :313-327).
3. **`packages/react-reconciler/src/ReactFiberRoot.js`** — `FiberRootNode` constructor :50-155
   stores them as **plain fields on the FiberRoot**:
   ```js
   this.onUncaughtError = onUncaughtError;        // :94
   this.onCaughtError = onCaughtError;            // :95
   this.onRecoverableError = onRecoverableError;  // :96
   if (enableDefaultTransitionIndicator) {
     this.onDefaultTransitionIndicator = onDefaultTransitionIndicator; // :99
     this.pendingIndicator = null;                // :100
   }
   ```
   `createFiberRoot` :157-… forwards (params :170-185, ctor call :194-197).
4. **Consumption**: e.g. `const onRecoverableError = root.onRecoverableError;`
   (ReactFiberWorkLoop.js:4255 in `flushSpawnedWork`; also :3916 in `reportViewTransitionError`).
   `onUncaughtError`/`onCaughtError` are read in `ReactFiberErrorLogger`.

So adding `onBeforeCommitMutation`/`onAfterCommitMutation` per-root callbacks means touching:
ReactDOMRoot.js (option type + read + pass), ReactFiberReconciler.js `createContainer`/
`createHydrationContainer` signatures, ReactFiberRoot.js ctor + `createFiberRoot`, and reading
`pendingEffectsRoot.onBeforeCommitMutation` inside `flushMutationEffects`. Note other renderers
(react-art, react-native, test-renderer, Fabric) also call `createContainer` — its signature is
positional, so either append optional params or (lower friction) pass `null` from them.
Alternative with smaller blast radius: a react-dom-only API (e.g. accept the callbacks in
`CreateRootOptions`, store on FiberRoot via a single "hostCallbacks" object param).

---

## 3. ReactSharedInternals, secret internals, DevTools hook

### 3.1 react's client internals

- Exported: `packages/react/index.js:28` →
  `__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`
  (alias of `ReactSharedInternals`, `packages/react/src/ReactClient.js:110`).
- Object shape: `packages/react/src/ReactSharedInternalsClient.js` (`SharedStateClient` type):
  - `H` — current hooks Dispatcher (null outside render)
  - `A` — AsyncDispatcher (cache)
  - `T` — **current Transition (ReactCurrentBatchConfig)** — non-null inside
    `startTransition` scope; this is how a sibling library can detect/join transitions
  - `S` — onStartTransitionFinish callback, `G` — gesture variant (flagged)
  - DEV-only: `actQueue`, `asyncTransitions`, `didUsePromise`, `thrownErrors`,
    `getCurrentStack`, `recentlyCreatedOwnerStacks`, …
- How react-dom gets it: `packages/shared/ReactSharedInternals.js` literally does
  `import * as React from 'react'; export default React.__CLIENT_INTERNALS_…`. During bundling,
  `scripts/rollup/forks.js:55-89` replaces this module with the real
  `ReactSharedInternalsClient.js` only for the `react` entry itself; renderer bundles keep the
  indirection (react is external), so **any sibling package can do exactly the same import** —
  verified at runtime: keys `['H','A','T','S','G', …dev keys]`.

### 3.2 react-dom's internals

- Exported: `packages/react-dom/index.js:10` →
  `__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`.
- Shape (`packages/react-dom/src/ReactDOMSharedInternals.js`):
  `{ d: HostDispatcher (f flushSyncWork, r requestFormReset, D prefetchDNS, C preconnect, L preload, m preloadModule, X preinitScript, S preinitStyle, M preinitModuleScript), p: currentUpdatePriority, findDOMNode }`.
  The reconciler bundle *overwrites* `d` and mutates `p` at runtime. Runtime-verified keys:
  `['d','p','findDOMNode']`.
- **Key structural fact**: the shipped `react-dom` bundle is FLAT — `react-reconciler`,
  `react-dom-bindings`, and `shared/*` are inlined (externals are only each package.json's
  `dependencies` + `peerDependencies` = `react` + `scheduler`; `scripts/rollup/modules.js:50-63`).
  A sibling package **cannot** import react-dom's reconciler state. Any new lifecycle exposure
  must be exported from react-dom entry points, threaded through `ReactDOMSharedInternals`, or
  delivered via per-root callbacks (§2). The npm `react-reconciler` package is a separate build
  for custom renderers — not the instance react-dom uses.

### 3.3 DevTools global hook (`__REACT_DEVTOOLS_GLOBAL_HOOK__`)

- `packages/react-reconciler/src/ReactFiberDevToolsHook.js`:
  `isDevToolsPresent` :47, `injectInternals(internals)` :51 (calls `hook.inject(internals)` :75),
  `onCommitRoot` :113 → `injectedHook.onCommitFiberRoot(rendererID, root, schedulerPriority, didError)`,
  `onPostCommitRoot` :154 → `onPostCommitFiberRoot(rendererID, root)`,
  `onCommitUnmount` :171 → `onCommitFiberUnmount`.
- Injection happens at react-dom module evaluation:
  `packages/react-dom/src/client/ReactDOMClient.js:54` `const foundDevTools = injectIntoDevTools();`
  → `ReactFiberReconciler.js:873-913`, which passes
  `{ bundleType, version, rendererPackageName, currentDispatcherRef: ReactSharedInternals,
  reconcilerVersion, … DEV-only overrides (overrideHookState, scheduleUpdate, setErrorHandler,
  setSuspenseHandler, scheduleRefresh, getCurrentFiber…) }`.
- **Timing**: `onCommitFiberRoot` fires in `flushSpawnedWork` (WorkLoop :4235) — i.e. AFTER
  mutation + layout phases, before passive. `onPostCommitFiberRoot` fires at the end of the
  passive flush (:4853). There is NO pre-mutation hook — the DevTools hook cannot give us the
  "before React mutates DOM" moment, and with view transitions `onCommitFiberRoot` fires inside
  the VT update callback well after paint-blocking work. It IS a viable no-patch channel for
  "a commit happened on root X" (a hook object must be installed on globalThis before react-dom
  is imported; `hook.inject` returns a renderer id; also needs `supportsFiber: true`, `checkDCE`).
- Scheduling-profiler marks (`markCommitStarted/Stopped`, `injectProfilingHooks` :210+) are gated
  by `enableSchedulingProfiler` which is currently **false** in all channels because
  `enableSchedulingProfiler = !enableComponentPerformanceTrack && __PROFILE__` and
  `enableComponentPerformanceTrack = true` (ReactFeatureFlags.js:237, :246-247). React now emits
  its timeline via the Performance API ("Component Performance Track") in DEV/profiling builds.

---

## 4. Feature flags

- Canonical file: `packages/shared/ReactFeatureFlags.js` (categorized by comment banners;
  values are `true`/`false`/`__EXPERIMENTAL__`/`__PROFILE__`).
- Fork files (`packages/shared/forks/`): `ReactFeatureFlags.www.js`,
  `ReactFeatureFlags.www-dynamic.js`, `ReactFeatureFlags.native-fb.js`,
  `ReactFeatureFlags.native-fb-dynamic.js`, `ReactFeatureFlags.native-oss.js`,
  `ReactFeatureFlags.test-renderer.js`, `ReactFeatureFlags.test-renderer.www.js`,
  `ReactFeatureFlags.test-renderer.native-fb.js`, `ReactFeatureFlags.eslint-plugin.www.js`,
  `ReactFeatureFlags.readonly.js`.
- Fork selection at build time: `scripts/rollup/forks.js:134-183` (by bundle entry/type);
  OSS NODE/ESM builds use the main file with `__EXPERIMENTAL__`/`__DEV__`/`__PROFILE__`
  replaced as compile-time constants (`scripts/rollup/build.js:432-441`:
  `__DEV__: isProduction ? 'false' : 'true'`, `__PROFILE__: isProfiling || !isProduction`,
  `__EXPERIMENTAL__` from `RELEASE_CHANNEL`).
- Repo skill doc: `vendor/react/.claude/skills/feature-flags/SKILL.md` — adding a flag requires
  adding it to the main file **and every fork file** (Flow + a flags consistency test enforce
  it); `yarn flags` (`scripts/flags/flags.js`) prints per-channel values; tests gate via
  `@gate flagName` / `gate(flags => …)`.
- Relevant existing flags: `enableViewTransition = true` (:81), `enableGestureTransition =
  __EXPERIMENTAL__` (:87), `enableDefaultTransitionIndicator = __EXPERIMENTAL__` (:99),
  `enableYieldingBeforePassive = false` (:70), `enableProfilerTimer = __PROFILE__` (:231).
- **Recommendation for our fork**: for a private fork whose only consumer is us, unconditional
  code (no flag) in the reconciler + react-dom is minimal-friction — flags exist to stage
  rollouts across Meta channels we don't ship. If we do add a flag (keeps diffs greppable and
  lets us diff against upstream easily), we must add it to all ~10 fork files or CI
  (`yarn flow`, flags test) fails. A middle ground used upstream for DOM-only behavior is to
  not touch shared flags at all and keep logic in `react-dom-bindings` / ReactDOMRoot options.

---

## 5. Build system (verified by running it)

### 5.1 Toolchain

- Node: `.nvmrc` = `v20.19.0`; no `engines` field; **verified working on Node v24.16.0**.
- Yarn classic: `"packageManager": "yarn@1.22.22"` (root `package.json`).
- `yarn install --frozen-lockfile` in `vendor/react`: **~18s** (warm cache), runs postinstall
  flow-config generation. `prebuild` script runs `scripts/react-compiler/link-compiler.sh`
  (yarn-links `babel-plugin-react-compiler` from `compiler/`); direct `scripts/rollup/build.js`
  invocations work without it (verified).

### 5.2 Commands

- `yarn build` = `node ./scripts/rollup/build-all-release-channels.js`. With no
  `--releaseChannel`, builds **both** stable and experimental into `./build` (slow — every
  bundle × every type). Args pass through to `build.js`
  (build-all-release-channels.js:158-177 spawns `node ./scripts/rollup/build.js <same argv>`
  with `RELEASE_CHANNEL` env).
  - `yarn build <names> --type=<TYPES> -r experimental` → builds one channel and
    post-processes `build/node_modules` → **`build/oss-experimental/`** (or `oss-stable`,
    plus `oss-stable-semver`), rewriting versions to `19.3.0-experimental-<sha8>-<yyyymmdd>`
    (processStable/processExperimental, build-all-release-channels.js:179-…).
  - **Caution**: build-all-release-channels.js **overwrites
    `packages/shared/ReactVersion.js`** with a placeholder version (lines 49-53) — it dirties
    the submodule working tree (currently dirty in our checkout for this reason).
- Direct fast path (what CI scripts like `build-for-vt-dev` use):
  `RELEASE_CHANNEL=experimental node ./scripts/rollup/build.js <bundle,names> --type=NODE_DEV[,NODE_PROD] [--unsafe-partial]`
  - Output stays at `build/node_modules/<pkg>` with source version (19.3.0); the repo's own
    scripts then `mv ./build/node_modules ./build/oss-experimental` (see `build-for-vt-dev`
    in package.json).
  - `--unsafe-partial` skips the `rm -rf build` (build.js:831-833) for incremental rebuilds.
  - `RELEASE_CHANNEL` unset ⇒ defaults to **experimental** (`build.js:33-38`).
  - `--watch` exists; `--pretty` for readable prod output.
- Bundle names are fuzzy-matched against bundle labels (comma-separated). Useful set for us:
  `react/index,react/jsx,react-dom/index,react-dom/client,scheduler`.
- Bundle types (scripts/rollup/bundles.js `bundleTypes`): `NODE_DEV`, `NODE_PROD`,
  `NODE_PROFILING`, `NODE_ES2015`, `ESM_DEV`, `ESM_PROD`, `BUN_*`, `FB_WWW_*`, `RN_*`,
  `BROWSER_SCRIPT`, `CJS_DTS`, `ESM_DTS`.

### 5.3 Measured timings (M-series mac, warm)

| Command | Time |
|---|---|
| `yarn install --frozen-lockfile` | 18s |
| `build.js react/index,react/jsx,react-dom/index,react-dom/client,scheduler --type=NODE_DEV` | **13s** |
| same set `--type=NODE_PROD,NODE_PROFILING --unsafe-partial` (Closure compiler) | **10s** |

i.e. a scoped react+react-dom+scheduler rebuild is ~10-25s; full `yarn build` (all bundles,
both channels) takes many minutes and is unnecessary.

### 5.4 Artifact layout (verified)

`build/node_modules/react-dom/` (→ renamed `build/oss-experimental/react-dom/` by the channel
script) is a complete npm package:

- `package.json` (copied from `packages/react-dom/package.json`, entry points **filtered to the
  channel** by `filterOutEntrypoints`, packaging.js:173-251; version rewritten only by
  build-all-release-channels), `LICENSE`, `README.md`
- npm shims copied from `packages/react-dom/npm/*`: `index.js`, `client.js`, `profiling.js`, …
  each doing `process.env.NODE_ENV === 'production' ? require('./cjs/react-dom-client.production.js') : require('./cjs/react-dom-client.development.js')`
  (+ a `checkDCE` call in prod)
- `cjs/react-dom.development.js`, `cjs/react-dom.production.js`,
  `cjs/react-dom-client.development.js`, `cjs/react-dom-client.production.js`,
  (`cjs/react-dom-profiling.profiling.js` when NODE_PROFILING type is built for the
  `react-dom/profiling` bundle)
- Packaging runs `npm pack` + re-extract to normalize (packaging.js:253-273).
- Built `react-dom/package.json`: `"dependencies": {"scheduler":"^0.28.0"}`,
  `"peerDependencies": {"react":"^19.3.0"}`, full `exports` map.

### 5.5 How fixtures consume the local build (precedent)

`fixtures/view-transition/package.json`: deps `react: ^19.0.0`, `react-dom: ^19.0.0`, with
`"predev"/"prestart"/"prebuild": "cp -r ../../build/oss-experimental/* ./node_modules/ && rm -rf node_modules/.cache"`.
`fixtures/dom/package.json`: `"predev": "cp -a ../../build/oss-experimental/. node_modules"`.
I.e. install placeholder versions from npm, then clobber `node_modules/{react,react-dom,scheduler,…}`
with the local build.

### 5.6 Recipe for our pnpm workspace (verified constraints)

Runtime checks I ran:

- Loading via **symlink** into a consumer `node_modules` FAILS: Node resolves the realpath, so
  `require('scheduler')` from inside the bundle walks up to `vendor/react/node_modules/scheduler`
  → the Flow **source** (yarn workspace self-links) → `SyntaxError`/ERR_MODULE_NOT_FOUND.
  So `link:` deps will not work without bundler resolution overrides.
- Loading via **copies** placed in consumer `node_modules` WORKS
  (`react version: 19.3.0-experimental-7ce677d4-20260702`, `createRoot: function`, internals
  keys present).

Therefore for the pnpm workspace either:

1. `file:` protocol deps (pnpm copies file: dirs into the virtual store — same as the working
   copy test) in the consuming package, plus root `pnpm.overrides` so every transitive
   `react`/`react-dom`/`scheduler` resolves to the same build:
   ```jsonc
   // package.json (workspace root)
   "pnpm": { "overrides": {
     "react": "file:vendor/react/build/oss-experimental/react",
     "react-dom": "file:vendor/react/build/oss-experimental/react-dom",
     "scheduler": "file:vendor/react/build/oss-experimental/scheduler"
   }}
   ```
   Re-run `pnpm install` after each React rebuild (pnpm does not watch file: contents; use
   `pnpm install --force` or delete the store entry if it caches).
2. Or the fixtures approach: normal npm deps + a script that copies
   `vendor/react/build/oss-experimental/{react,react-dom,scheduler}` over the installed
   packages (works with pnpm if the packages are made "public-hoisted"/not symlinked, or by
   copying into the `.pnpm` store paths — simplest with `node-linker=hoisted` in `.npmrc`).
3. For Vite-based dev, `resolve.alias` for `react`, `react-dom/client`, `scheduler` pointing at
   the built cjs files also works and gives instant rebuild pickup.

Build command to standardize on:

```sh
cd vendor/react && yarn install --frozen-lockfile
RELEASE_CHANNEL=experimental node ./scripts/rollup/build.js \
  react/index,react/jsx,react-dom/index,react-dom/client,scheduler \
  --type=NODE_DEV,NODE_PROD
mv build/node_modules build/oss-experimental   # match fixtures/pnpm layout
```

(NODE_DEV alone is enough for dev-mode work; the npm shims then require `NODE_ENV !== 'production'`.)

### 5.7 Release channels & global flags

- `__EXPERIMENTAL__` (channel): experimental enables `enableGestureTransition`,
  `enableDefaultTransitionIndicator`, `enableViewTransitionParentEnterExit`, experimental-only
  entry points (`unstable_ViewTransition`, `unstable_addTransitionType`, etc. — entry points are
  filtered per channel in packaging). `enableViewTransition` core machinery is `true` in BOTH
  channels. Version strings: stable → `19.3.0-canary-<sha>-<date>`, experimental →
  `0.0.0-experimental-<sha>-<date>` (only when built via build-all-release-channels; direct
  build.js keeps `19.3.0`). **Use the experimental channel** for our work (matches all fixtures,
  gives us transition-indicator + gesture APIs).
- `__DEV__`: NODE_DEV vs NODE_PROD file pairs, selected by consumer's `NODE_ENV` via npm shims.
- `__PROFILE__`: `true` in all DEV builds and in `NODE_PROFILING` (prod+profiling) builds
  (build.js:437). Profiling builds differ only additively for us: `enableProfilerTimer`,
  `enableProfilerCommitHooks`, `enableComponentPerformanceTrack` compile in commit timing,
  `root.effectDuration` bookkeeping, performance-track logging, and extra profiling-only
  arguments (e.g. `suspendedCommitReason`, `completedRenderEndTime` params of `commitRoot`).
  Commit *sequencing* is identical; our patch hooks should not be gated on `__PROFILE__`.
  `react-dom/profiling` is a separate bundle entry (`react-dom/profiling` → NODE_PROFILING,
  bundles.js:205) whose shim picks `react-dom-profiling.profiling.js` in prod.

---

## 6. Miscellaneous facts useful for the patch design

- Every commit-phase sub-flush wraps user-visible work in:
  `ReactSharedInternals.T = null`, `setCurrentUpdatePriority(DiscreteEventPriority)`,
  `executionContext |= CommitContext` and restores after (pattern at WorkLoop :4009-4030,
  :4098-4120, etc.). New hooks should follow the same pattern (and probably fire callbacks in a
  try/catch reporting via `reportGlobalError` like the indicator cleanup does :4082-4083).
- `prepareForCommit` (ConfigDOM :417-429) runs in the before-mutation phase
  (ReactFiberCommitWork.js:348): saves selection + **disables React's event system**
  (`ReactBrowserEventEmitterSetEnabled(false)` :427); re-enabled in `resetAfterCommit` (:452).
  So the "before mutation … after mutation" window is already a first-class concept in the
  host config — `prepareForCommit`/`resetAfterCommit` are natural anchors, BUT they only run
  when the before-mutation/mutation masks match (both call sites are conditional), and
  `prepareForCommit` runs in the *before-mutation* phase which can be separated in time from
  the actual mutations by `startViewTransition` (async) — hence the recommendation to hook
  `flushMutationEffects` instead.
- Multiple roots: all `pendingEffects*` state is module-global (one pending commit at a time);
  `completeRoot` force-flushes any previous pending commit before starting a new one (:3516-3524).
  Per-root callbacks therefore need the root threaded from `pendingEffectsRoot` (available in
  `flushMutationEffects` at :4001).
- Infinite-loop protection: `NESTED_UPDATE_LIMIT = 50` / `nestedUpdateCount` (WorkLoop :749-751),
  `NESTED_PASSIVE_UPDATE_LIMIT = 50` (:760), `didIncludeCommitPhaseUpdate` (:3755) — relevant to
  the project goal "integrate with React's infinite-render-loop rejection".
- The `react` package build is tiny (50KB dev) and rarely needs patching; the reconciler ships
  *inside* `react-dom-client.*.js` (1.21MB dev), so reconciler edits ⇒ rebuild react-dom only.
- `yarn test` = `scripts/jest/jest-cli.js` (channels: `--release-channel=stable|experimental|www-*`);
  repo has skills: `/test`, `/flags`, `/flow`, `/fix`, `/extract-errors` (new invariant error
  messages must be added to `scripts/error-codes/codes.json` via `yarn extract-errors`).
- `vendor/react/build` currently contains `oss-experimental/` (react, react-dom, scheduler,
  jest-react) built from HEAD; `packages/shared/ReactVersion.js` is dirty (placeholder version
  written by build-all-release-channels).
