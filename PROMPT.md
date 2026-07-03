# react-signals

We are implementing a no-compomises signals library for React.js.It will be fully concurrent (no useSyncExternalStore) with parity support for suspense.

## Siganls API

```ts
const atom = new Atom<T>({
  state: T,
  /**
    If set, run this effect when the atom becomes observed,
    and once the atom is no longer observed, run the returned cleanup. We plan to use this for remote subscriptions.
  */
  effect?: (ctx: AtomCtx<T>) => (() => void)
  /** Otherwise, Object.is used to compare */
  isEqual?: (a: T, b: T) => boolean
  /** Used in debug tools */
  label?: string
})

// Changing atom state
atom.set(nextValue) // like useState setState(non fn)
atom.update(currentValue => currentValue + 1) // like useState setState(fn)

const promise = fetch(...).then(r => r.json())

const computed = new Computed<T>({
  // We may add support for various things like our own
  // suspense via the context parameter.
  fn: (ctx: ComputedCtx<T>) => atom.state * 2 + ctx.use(promise).number,
  isEqual?: (a: T, b: T) => boolean
  label?: string
})

const reducerAtom = new ReducerAtom({
  state: T,
  reducer: (state, action) => newState,
  isEqual?: (a: T, b: T) => boolean
  label?: string
})

reducerAtom.dispatch(action)

function MyComponent(props) {
  const val = useSignal(computed)
  const [s, setS] = useState('something')
  const ownAtom = useAtom({ state: T, isEqual, label })
  // like useReducer, but returns a ReducerAtom
  const ownReducerAtom = useReducerAtom(...)

  // like useMemo, but causes the component to re-render if a referenced signal's output changes.
  // We must support useComputed closing over props, own state, and directly referencing atoms
  const other = useComputed(() => atom.state + s + val + props.other, [val, props.other])

  // like useEffect, but also re-runs the effect if a referenced signal's output changes
  useSignalEffect(() => {
    console.log(`new atom value: ${atom.state}`)
  }, [])

  return <div>{val}</div>
}

```

It is okay to require a top-level component owned by our library, if strictly necessary.

We will probably need to patch React (submodule in ./vendor/react) to add a minimal API to expose concurrent rendering state & lifecycle to our userspace library.

Unrelated to our Signals library, but another thing we need from our react fork/patch should also add a way for userspace to learn when React is about to start mutating the DOM, and when it is done mutating the DOM. We need this so we can disconnect a MutationObserver to ignore changes made by React to the DOM, but otherwise observe DOM mutations. (Our library should not reference MutationObserver - just that since we exposing some React lifecycle stuff, we should make sure to expose what's needed for this use-case too.)

## Goals

- Fully integrated with `useTransition` / `startTransition`. A transition can work over both React state and our signal state in lockstep.
- We should integrate with React's infinite-render-loop rejection if possible.
- We should have a lazy-loadable tracing module that allows us full visibility into causality within our signals library: we want to be able to answer questions like "why did my computed re-run" or "why did my component re-render" or "how many times did my effect re-run?"
  - Once implementation is validated, we will build a Chrome devtools extension on top of the tracing system that displays a (filterable) timeline of events.
- We should be able to tolerate a write to a signal atom from inside a computed as long as there is no dependency cycle between them; although we should also be able to forbid this at library initialization time.
- Multiple react roots ok.
- RSC/Flight is not important in v1, but we'd like to be able to hydrate from vanilla server-rendering if possible.
- Ideal performance + ideal code elegance
  - Our react patch needs to be minimal and maintainable, but we should be thoughtful about exposing internal React concerns verbatim vs adding thin abstractions. For example, I think having our userspace library directly mutate Fiber objects would not be okay, nor should we be explicitly referencing lanes. Those kinds of react-internals-implementation-specific shapes should still be encapsulated by the APIs we add in React. We need to minimize complexity on both sides of the API boundary here.
  - Humans will need to read, understand, and update our framework code. It should be plain-spoken, not invent new terms of art, and document its invariants.
  - Performance should be competitive with `useState` / `useReducer`, and on par or ahead of alien-signals on the happy path.

## References

```bash
git submodule add https://github.com/react/react vendor/react
git submodule add https://github.com/stackblitz/alien-signals vendor/alien-signals
git submodule add https://github.com/thejustinwalsh/react-concurrent-store vendor/react-concurrent-store
git submodule add https://github.com/transitive-bullshit/js-reactivity-benchmark vendor/js-reactivity-benchmark
```

I've also added these submodules for your reference:

- alien-signals: this is a well-respected signals algorithm we can study (vendor/alien-signals)
- react-concurrent-store: this is an early effort by some React maintainers to design a concurrent-safe store in userspace. unlike our signals library, it doesn't support automatic dependencies or a computed abstraction.
- js-reactivity-benchmark: benchmark of various signals-like libraries. Once our implementation is complete, we should add ourselves to this to benchmark our implementation against others.
  - we should benchmark with no react integration, as well as though we're inside react startTransition, and in other modes that may affect the overall performance of our implementation.

## Other guidelines

- pnpm.
- TypeScript.
- prefer `type X = ...` over `interface ...` unless there's a specific type variance reason to use an `interface`.
- Assume stripping only (avoid const enum, namespace, etc).
- prefer `undefined` to `null` unless it worstens performance.
