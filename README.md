# react-signals

A no-compromises signals library for React: fully concurrent (no
`useSyncExternalStore`), transition-native, and Suspense-compatible, backed by
a minimal patch to React that exposes the render/commit lifecycle to external
state libraries.

```tsx
import { Atom, Computed, useSignal, useComputed, useSignalEffect } from 'react-signals';

const count = new Atom({
  state: 0,
  // Runs when the atom becomes observed; cleanup when it no longer is.
  effect: (ctx) => {
    const ws = subscribeRemote((v) => (ctx.state = v));
    return () => ws.close();
  },
});

const promise = fetch('/api/factor').then((r) => r.json());

const scaled = new Computed({
  // ctx.use reads a promise inside a computed: fulfilled → value,
  // pending → the reader suspends (React Suspense handles it).
  fn: (ctx) => count.state * ctx.use(promise).factor,
});

function MyComponent(props: { other: number }) {
  const value = useSignal(scaled);
  const [s, setS] = useState('something');

  // Like useMemo, but re-renders when a referenced signal changes.
  // Closed-over props/state go in deps; signal reads are auto-tracked.
  const other = useComputed(() => count.state + s + value + props.other, [s, value, props.other]);

  // Like useEffect, but also re-runs when a referenced signal's
  // committed value changes.
  useSignalEffect(() => {
    console.log(`count is now ${count.state}`);
  }, []);

  return <div>{other}</div>;
}
```

Writes are plain assignments — `count.state = 1` — and compose with React
exactly like `setState`:

```tsx
startTransition(() => {
  count.state = 5;        // rides the transition
  setTab('details');      // same lane — both commit in the same frame
});
```

The committed DOM keeps showing the old signal values until the transition
commits; urgent updates that interleave render against committed state and
rebase cleanly. See `DESIGN.md` for how (and for why
`useSyncExternalStore` can't do this).

## What's here

| Path | What |
|---|---|
| `packages/react-signals/src/core` | Framework-agnostic reactive graph: alien-signals-derived push-pull propagation, plus a two-plane "world" model that keeps committed and pending-transition state consistent under concurrent rendering. Zero React imports. |
| `packages/react-signals/src/react` | `useSignal` / `useComputed` / `useSignalEffect`, the runtime that binds React's lifecycle events to the engine's worlds, and `observeMutationsExceptReact` (MutationObserver that ignores React's own commits). |
| `packages/react-signals/src/tracing` | Lazy-loadable causality tracing: every write/eval/notify/effect event carries its cause, answering "why did my computed re-run". Zero overhead unless imported. |
| `vendor/react` (branch `react-signals-patch`) | The React patch: an external-runtime introspection channel (render-pass + commit lifecycle, DOM-mutation bracket, update-lane attribution). ~2 new files, 5 hook points, no Fiber shapes exposed. |
| `vendor/js-reactivity-benchmark` (branch `react-signals`) | Benchmark adapter for the core graph (`testPullCounts: true`). |
| `DESIGN.md`, `notes/` | Architecture and the research it rests on (file:line references into React and alien-signals). |

## Setup

```sh
pnpm install
./scripts/build-react.sh   # builds the patched react/react-dom (~15s)
pnpm test                  # core + adversarial regressions + React integration
```

The workspace consumes the patched build via `link:` overrides, so
`build-react.sh` rebuilds are picked up without reinstalling.

## Benchmarks

```sh
cd vendor/js-reactivity-benchmark
pnpm install --ignore-workspace
pnpm test    # framework conformance (112 tests)
pnpm bench   # perf suite
```

Results from this machine are in `notes/bench-results.md`.

## Guarantees (and non-guarantees)

- No tearing: all subscribers of a signal agree in every committed frame,
  including readers that mount mid-transition.
- Transition lockstep: signal writes and React state written in one
  `startTransition` commit together; urgent interleavings rebase.
- Suspense parity: a computed waiting on `ctx.use(promise)` suspends its
  readers through React's `use()` replay machinery; transitions into
  suspending states keep old content without fallbacks.
- Effects (`useSignalEffect`, core `effect`) observe committed state only.
- Writes inside computeds are tolerated unless they form a dependency cycle
  (`CycleError`); `configure({ forbidWritesInComputeds: true })` forbids them
  outright.
- React's infinite-update-loop rejection applies to signal-driven renders
  (broadcasts flow through `setState`).
- Multiple roots share signals; a transition write folds into committed state
  at its first root's commit (documented cross-root relaxation, DESIGN.md §2).
- After an `await` inside `startTransition`, wrap further signal writes in a
  new `startTransition` — the same rule React applies to `setState`.
- SSR: server renders read committed values with no subscriptions; initialize
  atoms with the same state before `hydrateRoot`.
