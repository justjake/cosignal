# js-reactivity-benchmark: deep read + recipe for adding react-signals

Submodule: `vendor/js-reactivity-benchmark` (fork: github.com/transitive-bullshit/js-reactivity-benchmark, HEAD `8a91576`).
Standalone pnpm package with its own `pnpm-lock.yaml`; it is NOT part of the root pnpm workspace (root `pnpm-workspace.yaml` only lists `packages/*`).

All paths below are relative to `vendor/js-reactivity-benchmark/` unless absolute.

---

## 1. The framework adapter interface

`src/util/reactiveFramework.ts` (entire file, lines 1–22):

```ts
export interface ReactiveFramework {
  name: string;
  signal<T>(initialValue: T): Signal<T>;
  computed<T>(fn: () => T): Computed<T>;
  effect(fn: () => void): void;
  withBatch<T>(fn: () => T): void;
  withBuild<T>(fn: () => T): T;
}

export interface Signal<T> {
  read(): T;
  write(v: T): void;
}

export interface Computed<T> {
  read(): T;
}
```

`src/util/frameworkTypes.ts:47-53`:

```ts
export interface FrameworkInfo {
  framework: ReactiveFramework;
  /** verify the number of nodes executed matches the expected number */
  testPullCounts?: boolean;
}
```

### Semantic expectations (enforced by `src/frameworks.test.ts` and the benches)

The conformance test `src/frameworks.test.ts` runs every registered framework through vitest (`pnpm test`). It encodes the contract:

1. **Computeds are auto-tracking and pull-consistent.** `frameworks.test.ts:34-45`: after `s.write(3)` (with NO batch and NO effect observing), `c.read()` must immediately return `6`. Reads must always return fresh values, batched or not, observed or not.

2. **Effects run eagerly at creation.** `frameworks.test.ts:109-130`: after `framework.effect(() => spy(c.read()))` inside `withBuild`, `expect(spy.mock.calls.length).toBe(1)` — the effect body must have executed synchronously by the time `effect()` returns. (Adapters for lazy-effect libs call `fn()` manually first — see reactively/oby.)

3. **`withBatch` flushes effects synchronously before returning, exactly once per batch.** Same test: after `framework.withBatch(() => s.write(3))`, `expect(spy.mock.calls.length).toBe(2)` — exactly 2, so effects must be (a) run by the time `withBatch` returns, (b) deduplicated within a batch. Microtask/async effect scheduling breaks this: adapters for schedulers (vue, angular, tc39 polyfill) drain their queue synchronously inside `withBatch`.

4. **Reads inside an open batch must see fresh values.** `src/util/dependencyGraph.ts:76-96` (`runGraph`): for all frameworks except s-js/solid, the ENTIRE iteration loop — thousands of writes each followed by leaf reads — runs inside ONE `withBatch(...)` call. Leaf `read()` inside the batch must reflect the write made earlier in the same batch. A design that defers computed recomputation to "batch end" returns stale sums and fails verification.

5. **Unbatched writes must be legal.** `src/sBench.ts:221-291` (`updateComputations*`) writes signals in a plain loop with no `withBatch` at all.

6. **`read`/`write` must be `this`-free.** `src/sBench.ts:144`, `:222` etc. destructure them (`const { read: get } = sources[i]`, `sources[i * 2].read` passed as a bare function). Return closures or bound functions.

7. **`withBuild` is a creation scope** (ownership root for Solid `createRoot`, Svelte `$.effect_root`, vue `effectScope`, S.js `S.root`). It must return the callback's return value (`frameworks.test.ts:97-107`). Frameworks with no ownership concept use `withBuild: (fn) => fn()`. Note: signals are sometimes created OUTSIDE `withBuild` (`frameworks.test.ts:112`), so creation must not require a scope.

8. **`effect` return value is ignored; there is no dispose API.** Graphs (including live effects) are dropped and rebuilt every run (`src/dynamicBench.ts:21-33`) and reclaimed only by GC. If your effect registry roots effects globally, the benchmark leaks and slows down. Effects must be GC-able when the graph is dropped, or at least inert.

9. **Exact pull counts if `testPullCounts: true`.** Every computed body increments a shared `Counter` (`dependencyGraph.ts:160-186`). `verifyBenchResult` (`src/util/perfTests.ts:17-42`) asserts count equals `expected.count` exactly when `testPullCounts` is set (or when `readFraction === 1`). This requires perfect memoization: a computed executes iff its transitive sources changed AND it is pulled — no eager recompute, no redundant recompute, no recompute of equal-value parents' children (graph values do change every write, so equality-cutoff isn't the main mechanism; dirty-marking + version checks are). MobX over-executes → registered with `testPullCounts: false` (`src/config.ts:37`). Verification failures are `console.assert` — they print but do NOT fail the process (vitest tests DO fail).

10. **Dynamic dependency sets.** ~25% of nodes in "dynamic" configs drop one source based on a value read at runtime (`dependencyGraph.ts:169-187`); `src/kairo/unstable.ts` swaps deps every iteration. Dependency tracking must handle sources appearing/disappearing between runs, and repeated reads of the same source in one computed (`kairo/repeated.ts` reads the same signal 30x in one body).

---

## 2. Exemplar adapters (full source)

### alien-signals (push-pull hybrid) — `src/frameworks/alienSignals.ts`

```ts
import { getDefaultSystem } from "alien-signals/esm";
import { ReactiveFramework } from "../util/reactiveFramework";

const { signal, computed, effect, startBatch, endBatch } = getDefaultSystem();

export const alienFramework: ReactiveFramework = {
  name: "alien-signals",
  signal: (initial) => {
    const data = signal(initial);
    return { read: data, write: data };   // one polymorphic fn for both
  },
  computed: (fn) => ({ read: computed(fn) }),
  effect: effect,
  withBatch: (fn) => { startBatch(); fn(); endBatch(); },
  withBuild: (fn) => fn(),
};
```

### Preact Signals (lazy pull, eager sync effects) — `src/frameworks/preactSignals.ts`

```ts
import { ReactiveFramework } from "../util/reactiveFramework";
import { batch, computed, effect, signal } from "@preact/signals";

export const preactSignalFramework: ReactiveFramework = {
  name: "Preact Signals",
  signal: (initialValue) => {
    const s = signal(initialValue);
    return { write: (v) => (s.value = v), read: () => s.value };
  },
  computed: (fn) => { const c = computed(fn); return { read: () => c.value }; },
  effect: (fn) => effect(fn),
  withBatch: (fn) => batch(fn),
  withBuild: (fn) => fn(),
};
```

### @reactively (pull-based; shows manual eager-effect + stabilize) — `src/frameworks/reactively.ts`

```ts
import { Reactive, stabilize } from "@reactively/core";
import { ReactiveFramework } from "../util/reactiveFramework";

export const reactivelyFramework: ReactiveFramework = {
  name: "@reactively",
  signal: (initialValue) => {
    const r = new Reactive(initialValue);
    return { write: (v) => r.set(v), read: () => r.get() };
  },
  computed: (fn) => { const r = new Reactive(fn); return { read: () => r.get() }; },
  effect: (fn) => {
    fn();                          // eager first run, manually
    return new Reactive(fn, true); // effect=true: re-run on stabilize()
  },
  withBatch: (fn) => { fn(); stabilize(); },  // writes then flush effects
  withBuild: (fn) => fn(),
};
```

### Pattern for scheduler-based effect systems (most relevant to us)

If our effects are queued rather than synchronous, follow the Angular/vue/TC39 adapters: keep a module-level queue, enqueue on notify, drain synchronously in `withBatch`.

`src/frameworks/angularSignals.ts:21-46`:

```ts
withBatch: (fn) => { fn(); flushEffects(); },
...
let queue = new Set<Watch>();
function effect(effectFn: () => void): void {
  const w = createWatch(effectFn, queue.add.bind(queue), true);
  w.run();                        // run effect immediately
}
function flushEffects(): void {
  for (const watch of queue) { queue.delete(watch); watch.run(); }
}
```

`src/frameworks/vueReactivity.ts:28-46` does the same with a `scheduled: ReactiveEffect[]` array and a `while (scheduled.length) scheduled.pop()!.run()` loop inside `withBatch`. `src/frameworks/tc39-proposal-signals-stage-0.ts:20-48` wraps `Signal.subtle.Watcher` and calls `processPending()` at the end of `withBatch`.

Other adapters for reference: solid (`createRenderEffect`, `withBuild: createRoot`) `src/frameworks/solid.ts`; svelte v5 internals (`$.render_effect`, `withBatch: $.flush_sync`, `withBuild: $.effect_root`) `src/frameworks/svelte.ts`; mobx (`autorun`, `runInAction`) `src/frameworks/mobx.ts`; s-js `src/frameworks/s.ts`; oby, signia, tansu, uSignal, molWire similar one-file adapters.

---

## 3. Registration, entry points, running, reporting

### Registration — `src/config.ts:21-46`

Import your adapter and append to the array:

```ts
export const frameworkInfo: FrameworkInfo[] = [
  { framework: alienFramework, testPullCounts: true },
  { framework: preactSignalFramework, testPullCounts: true },
  ...
  { framework: mobxFramework, testPullCounts: false },
];
```

That single array drives BOTH the perf run (`src/index.ts:13`) and the vitest conformance suite (`src/frameworks.test.ts:6`).

### Entry point — `src/index.ts:9-31`

```ts
async function main() {
  logPerfResult(perfReportHeaders());
  (globalThis as any).__DEV__ = true;
  for (const frameworkTest of frameworkInfo) {
    const { framework } = frameworkTest;
    await kairoBench(framework);
    await molBench(framework);
    sbench(framework);
    // cellxbench(framework);   // disabled (MobX/Valtio/Svelte fail)
    await dynamicBench(frameworkTest);
    globalThis.gc?.();
  }
}
```

Note `__DEV__ = true` is set globally (some libs read it).

### Scripts — `package.json:6-11`

```json
"test":  "vitest run",
"build": "esbuild src/index.ts --bundle --format=cjs --platform=node --outdir=dist --sourcemap=external",
"run":   "node --expose-gc dist/index.js",
"bench": "esbuild src/index.ts --bundle --format=cjs --platform=node | node --expose-gc"
```

- `pnpm bench` bundles everything (TS included) with esbuild and pipes into `node --expose-gc` — no tsc emit, no config file for esbuild, `tsconfig.json` is `noEmit` typecheck-only (moduleResolution: Bundler).
- `--expose-gc` matters: the harness calls `globalThis.gc?.()` between runs (optional-chained, so it degrades gracefully).
- No vitest config file; vitest defaults pick up `src/frameworks.test.ts`.
- CI (`.github/workflows/main.yml`) runs `pnpm install --frozen-lockfile --strict-peer-dependencies`, `pnpm test`, `pnpm build` on Node LTS.

### Result reporting — `src/util/perfLogging.ts`

Plain CSV-ish lines to stdout via `console.log`, three fixed-width columns joined with `" , "`: `framework` (22 chars), `test` (60), `time` (8, ms with 2 decimals). Header row printed first (`index.ts:10`). Correctness failures appear interleaved as `console.assert` output. Nothing is written to a file; redirect stdout to capture.

---

## 4. Benchmark scenarios and what they stress

### a) kairoBench — `src/kairoBench.ts` + `src/kairo/*.ts`

Per case: graph built once inside `withBuild`, warm-up call, then `fastestTest(10, () => { for 1000: iter() })` — best of 10 samples of 1000 iterations. Every case's `iter` does `withBatch(() => head.write(i))` per iteration (batch enter/exit overhead is measured thousands of times) and then `console.assert` on a `read()` after the batch. Cases (all in `src/kairo/`):

| case | shape | stresses |
|---|---|---|
| `avoidable.ts` | signal → 6-deep computed chain where computed2 always returns `0`, plus heavy `busy()` work below the cutoff, effect at leaf | **equality cutoff**: value stops changing mid-chain; downstream must NOT re-run |
| `broad.ts` | 1 signal → 50 parallel 2-deep chains, 50 effects | wide fanout, many effects per write |
| `deep.ts` | 1 signal → 50-long linear computed chain → 1 effect | deep propagation, recursion depth |
| `diamond.ts` | 1 signal → 5 parallel computeds → 1 summing computed → effect | diamond re-join; must not double-execute the join |
| `mux.ts` | 100 signals → 1 computed building an object of all 100 → 100 splitter computeds → 100 effects | one hub node with 100 deps/100 dependents |
| `repeated.ts` | computed reads the SAME signal 30 times | dedupe of repeated dependency registration |
| `triangle.ts` | 10-deep chain, each layer also feeds a final sum computed | mixed depths converging |
| `unstable.ts` | computed switches between `double`/`inverse` deps based on `head % 2` every write | dependency set churn every single update |

### b) molBench — `src/molBench.ts`

Small fixed graph (2 signals, 5 computeds with real work — `fib(16)` — and 3 effects). `iter` does two consecutive `withBatch` calls each writing both signals. 1e4 iterations × best-of-10. Stresses: multi-write batches, effect dedupe within batch, computeds with non-trivial CPU cost, allocation (computed D maps to fresh objects).

### c) sbench — `src/sBench.ts` (from Solid's bench)

COUNT = 1e5. Two families, each timed once (no repeat, warm-up = 3 runs at n/100 inside the same `withBuild`, plus `gc()` before timing):
- `createDataSignals`, `createComputations{0to1,1to1,2to1,4to1,1000to1,1to2,1to4,1to8,1to1000}`: raw **creation throughput** of signals and computeds with various fan-in/fan-out. Computeds are created and (mostly) never read — a lazy library pays ~nothing here; an eager one pays full evaluation.
- `updateComputations{1to1,2to1,4to1,1000to1,1to2,1to4,1to1000}`: 1 computed (or 2/4/1000 computeds) observing sources, then up to 4e5 **unbatched writes** to one source. Since nothing reads the computeds afterwards and there are no effects, lazy libraries only pay dirty-marking per write. Stresses: write path / invalidation propagation cost.
Note `read`/`write` are destructured to bare functions here.

### d) dynamicBench — `src/dynamicBench.ts` + `src/util/dependencyGraph.ts` + configs in `src/config.ts:48-129`

Builds a rectangular grid: row 0 = `width` signals; each of `totalLayers - 1` computed rows has `width` computeds each summing `nSources` nodes from the previous row (wrapping window). With probability `1 - staticFraction` a node is dynamic: it drops one source when the first source's value is odd (`dependencyGraph.ts:169-187`). Per iteration: write one source (round-robin), read `readFraction` of the leaf row. **All iterations run inside a single `withBatch`** (except s-js/solid, special-cased at `dependencyGraph.ts:61-74`). Sum and exact computed-execution count are verified against hardcoded `expected` values (deterministic via seeded `Random("seed")`).

Configs (`config.ts:48-129`):

| name | width×layers | nSources | static | readFraction | iters |
|---|---|---|---|---|---|
| simple component | 10×5 | 2 | 1 | 0.2 | 600,000 |
| dynamic component | 10×10 | 6 | 0.75 | 0.2 | 15,000 |
| large web app | 1000×12 | 4 | 0.95 | 1 | 7,000 |
| wide dense | 1000×5 | 25 | 1 | 1 | 3,000 |
| deep | 5×500 | 3 | 1 | 1 | 500 |
| very dynamic | (disabled — hangs several frameworks) | | | | |

Stresses: partial reads (lazy evaluation wins on readFraction 0.2), very wide rows, 500-deep chains, dynamic dep churn at scale, and exact-count memoization discipline.

### e) cellxBench — `src/cellxBench.ts` (present but disabled in `index.ts:23`)

1000/2500/5000-layer chains of 4-wide computed rows with 4 effects per layer; single batch of 4 writes; asserts exact before/after values at the far end. Would stress: deep + effect-heavy graphs, structural correctness at extreme depth (stack depth!). MobX/Valtio/Svelte currently fail it — don't be surprised by odd `expected` values (they encode specific glitch-avoidance semantics).

---

## 5. Harness assumptions that could bite react-signals

1. **Effects must be synchronous and flushed by `withBatch` return** (`frameworks.test.ts:109-130`). Our React-integrated effects will presumably schedule through React; for the benchmark we must expose (or adapt to) a standalone synchronous effect + flush. The Angular/vue adapter pattern (manual queue drained in `withBatch`) is the escape hatch — the benchmark measures our core graph, not React scheduling.
2. **Reads mid-batch must be fresh** (`dependencyGraph.ts:76-96`). If our design snapshots/defers visibility of writes for concurrency (e.g., versioned reads tied to a React lane), the adapter must read "latest" not "committed snapshot".
3. **No disposal, GC-based lifecycle**: effects/graphs are abandoned, never disposed (`dynamicBench.ts:21-33`). Global effect registries or atom `effect:` mount hooks that hold strong refs will leak across ~6 configs × runs. Atoms' observed/unobserved lifecycle (our `effect` option on Atom) will thrash: leaves are read, then the graph is dropped.
4. **Warmup is shallow**: dynamicBench warm-up = 1 full run, then `testRepeats = 1` timed run (best-of-1!) — `dynamicBench.ts:36-42`. kairo/mol use best-of-10. JIT variance matters; the "fastest of N with gc() between" (`benchRepeat.ts:5-32`) only mitigates for kairo/mol.
5. **`gc()` is called between runs** (`benchRepeat.ts:24-31`, `index.ts:27`, `sBench.ts:66-75`) — run under `node --expose-gc` or timings include GC noise.
6. **Exact pull-count verification** (`perfTests.ts:32-41`): decide `testPullCounts` honestly. Extra executions (e.g., eager re-evaluation for glitch-freedom, or double-run for concurrent consistency checks) → set `false`, counts then only checked when `readFraction === 1`... actually with `testPullCounts: false` count checks are skipped entirely.
7. **Errors are swallowed in dynamicBench** (`try/catch` → returns -1, logs warning, `dynamicBench.ts:24-32`) but NOT in kairo/mol/sbench — a throw there kills the whole process.
8. **Writes without batch** (sbench) and **write-then-read-inside-computed patterns do not occur** — no benchmark writes signals inside computeds; our write-during-compute tolerance is unexercised.
9. **`read`/`write` used as detached functions** (sbench) — no `this`.
10. **Numbers get huge**: "deep" config sum is `3.02e241` — float math, fine, but don't use ints/BigInt assumptions.
11. **`__DEV__ = true` is set on globalThis** (`index.ts:11`) — if our library keys dev-mode checks off `__DEV__`, the benchmark measures dev mode. Consider keying off `process.env.NODE_ENV` or accepting it.
12. **Single-threaded, no async anywhere** in scenario bodies: promises/Suspense paths of our Computed are never exercised; the sync fast path is what's measured.

---

## 6. Recipe: adding react-signals

Files to touch (all inside the submodule — note this dirties `vendor/js-reactivity-benchmark`; plan to fork the submodule remote or carry a patch):

1. **`src/frameworks/reactSignals.ts`** (new) — the adapter:

```ts
import { ReactiveFramework } from "../util/reactiveFramework";
import { Atom, Computed, effect, batch /* or flush */ } from "react-signals";

export const reactSignalsFramework: ReactiveFramework = {
  name: "react-signals",
  signal: (initialValue) => {
    const a = new Atom({ state: initialValue });
    return { read: () => a.state, write: (v) => (a.state = v) };
  },
  computed: (fn) => {
    const c = new Computed({ fn });
    return { read: () => c.state };
  },
  effect: (fn) => { /* must run fn eagerly, re-run sync on flush */ },
  withBatch: (fn) => { /* batch writes; drain effect queue synchronously before returning */ },
  withBuild: (fn) => fn(),
};
```

2. **`src/config.ts`** — add import + `{ framework: reactSignalsFramework, testPullCounts: true /* if we memoize exactly */ }` to `frameworkInfo` (line ~21).

3. **`package.json`** — add the dependency. **Local file deps work.** Options, in order of preference:
   - `"react-signals": "link:../../packages/react-signals"` (pnpm symlink; esbuild `--bundle` follows the symlink and can even bundle TS sources directly, and vitest resolves it too). `file:` also works (pnpm hard-links/injects).
   - Or skip package.json entirely: a **relative import** in the adapter (`import ... from "../../../packages/react-signals/src/index"`) — esbuild bundles anything reachable, TS included; vitest likewise. Least ceremony, but `tsconfig` rootDir-less typecheck must still resolve it (it will; `moduleResolution: "Bundler"`).
   - Adding the benchmark dir to the ROOT workspace (`pnpm-workspace.yaml`) is possible but touches root config and the submodule's lockfile anyway.
   After editing package.json run `pnpm install` inside `vendor/js-reactivity-benchmark` (it has its own lockfile; CI uses `--frozen-lockfile`, so commit the lockfile change in the fork).

4. **Verify conformance first**: `pnpm test` (vitest runs `src/frameworks.test.ts` for every entry in `frameworkInfo` — 7 tests per framework covering the contract in §1).

5. **Run the bench**: `pnpm bench` (esbuild bundle piped into `node --expose-gc`), or `pnpm build && pnpm run run`. Output is stdout CSV (framework, test, time-ms). To iterate quickly on just our framework, temporarily comment out other entries in `frameworkInfo` — that array is the only registry.

### Adapter design notes specific to our library

- Our benchmark-facing `effect` should bypass React entirely — a plain reactive watcher with synchronous scheduling, or a queued watcher drained in `withBatch` (Angular adapter pattern, §2).
- `withBatch` must leave computeds readable mid-batch (dynamicBench reads inside the batch).
- If Atom's `effect:` mount/unmount option or any tracing hooks add per-node overhead, make sure they're absent/disabled on the fast path — sbench creates 100k nodes per subtest.
- If we can hit exact lazy pull counts (dirty-mark + pull + version check, à la reactively/alien/preact), claim `testPullCounts: true`; it's the club worth being in (only mobx and s-js/solid aren't).
