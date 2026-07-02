/**
 * Public core API: the Atom / Computed classes and effect/batch helpers.
 *
 * These are thin wrappers over engine nodes. The engine's functional surface
 * (readAtom/writeAtom/...) stays available to the React bindings and the
 * benchmark adapter, which want zero indirection; application code uses these
 * classes.
 */

import {
  type AtomNode,
  type ComputedNode,
  type WatcherNode,
  type ComputedCtx as EngineComputedCtx,
  WATCHER_EFFECT,
  createAtomNode,
  createComputedNode,
  createWatcher,
  readAtom,
  writeAtom,
  readComputed,
  runEffect,
  disposeWatcher,
  startBatch,
  endBatch,
  untracked,
  config,
  setAtomLifecycleDelivery,
  SuspendedRead,
  CycleError,
} from './engine.ts';

export { SuspendedRead, CycleError, untracked, startBatch, endBatch };
export { flushEffects } from './engine.ts';

/** Passed to an Atom's `effect` option when the atom becomes observed. */
export type AtomCtx<T> = {
  get state(): T;
  set state(value: T);
};

export type AtomOptions<T> = {
  state: T;
  /**
   * Runs when the atom becomes observed (first watcher attaches, e.g. a
   * component subscribes); the returned cleanup runs once the atom is no
   * longer observed. Intended for remote subscriptions. Both run in a
   * microtask so observe/unobserve flaps within one tick coalesce.
   */
  effect?: (ctx: AtomCtx<T>) => void | (() => void);
  /** Defaults to Object.is. */
  isEqual?: (a: T, b: T) => boolean;
  /** Debug label shown by tracing and the graphviz visualizers. */
  name?: string;
};

export type ComputedCtx<T> = {
  /**
   * Reads a promise inside a computed. Fulfilled: returns the value.
   * Rejected: throws the reason. Pending: suspends the computed — readers
   * see the suspension (React bindings forward it to Suspense).
   */
  use<V>(thenable: PromiseLike<V>): V;
};

export type ComputedOptions<T> = {
  // NoInfer keeps the ctx parameter from short-circuiting inference of T
  // from the callback's return type.
  fn: (ctx: ComputedCtx<NoInfer<T>>) => T;
  /** Defaults to Object.is. */
  isEqual?: (a: T, b: T) => boolean;
  /** Debug label shown by tracing and the graphviz visualizers. */
  name?: string;
};

// ---------------------------------------------------------------------------
// Observed-lifecycle delivery (Atom `effect` option)
// ---------------------------------------------------------------------------

type LifecycleState = {
  atom: Atom<unknown>;
  cleanup: (() => void) | null;
  /** Desired state as of the last watched-count transition. */
  wantMounted: boolean;
  /** Actual state (effect has run and not been cleaned up). */
  isMounted: boolean;
  scheduled: boolean;
};

const lifecycles = new WeakMap<AtomNode, LifecycleState>();
let lifecycleQueue: LifecycleState[] = [];
let lifecycleFlushScheduled = false;

function scheduleLifecycleFlush(): void {
  if (lifecycleFlushScheduled) return;
  lifecycleFlushScheduled = true;
  queueMicrotask(() => {
    lifecycleFlushScheduled = false;
    const queue = lifecycleQueue;
    lifecycleQueue = [];
    for (const state of queue) {
      state.scheduled = false;
      if (state.wantMounted === state.isMounted) continue; // flap coalesced
      if (state.wantMounted) {
        state.isMounted = true;
        const result = state.atom.options.effect!(state.atom.lifecycleCtx);
        state.cleanup = typeof result === 'function' ? result : null;
      } else {
        state.isMounted = false;
        const cleanup = state.cleanup;
        state.cleanup = null;
        if (cleanup !== null) cleanup();
      }
    }
  });
}

function onTransition(node: AtomNode, wantMounted: boolean): void {
  const state = lifecycles.get(node);
  if (state === undefined) return;
  state.wantMounted = wantMounted;
  if (!state.scheduled) {
    state.scheduled = true;
    lifecycleQueue.push(state);
    scheduleLifecycleFlush();
  }
}

setAtomLifecycleDelivery(
  (node) => onTransition(node, true),
  (node) => onTransition(node, false),
);

// ---------------------------------------------------------------------------
// Atom
// ---------------------------------------------------------------------------

export class Atom<T> {
  /** Engine node; internal, also consumed by the React bindings. */
  readonly node: AtomNode;
  readonly options: AtomOptions<T>;
  readonly lifecycleCtx: AtomCtx<T>;

  constructor(options: AtomOptions<T>) {
    this.options = options;
    this.node = createAtomNode(
      options.state,
      options.isEqual as ((a: unknown, b: unknown) => boolean) | undefined,
      options.effect !== undefined ? options : null,
      options.name,
    );
    const self = this;
    this.lifecycleCtx = {
      get state(): T {
        return untracked(() => readAtom(self.node)) as T;
      },
      set state(value: T) {
        writeAtom(self.node, value);
      },
    };
    if (options.effect !== undefined) {
      lifecycles.set(this.node, {
        atom: this as Atom<unknown>,
        cleanup: null,
        wantMounted: false,
        isMounted: false,
        scheduled: false,
      });
    }
  }

  get state(): T {
    return readAtom(this.node) as T;
  }

  set state(value: T) {
    writeAtom(this.node, value);
  }
}

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

export class Computed<T> {
  /** Engine node; internal, also consumed by the React bindings. */
  readonly node: ComputedNode;

  constructor(options: ComputedOptions<T>) {
    this.node = createComputedNode(
      options.fn as (ctx: unknown) => unknown,
      options.isEqual as ((a: unknown, b: unknown) => boolean) | undefined,
      options.name,
    );
  }

  /**
   * The computed's current value. Throws the computed's error if it failed;
   * throws SuspendedRead if it is waiting on a promise (`ctx.use`).
   */
  get state(): T {
    return readComputed(this.node) as T;
  }
}

/** Either public signal wrapper. */
export type Signal<T> = Atom<T> | Computed<T>;

export function isAtom(value: unknown): value is Atom<unknown> {
  return value instanceof Atom;
}

export function isComputed(value: unknown): value is Computed<unknown> {
  return value instanceof Computed;
}

/** Engine ctx and public ctx are the same object shape. */
export type { EngineComputedCtx };

// ---------------------------------------------------------------------------
// Effects and batching
// ---------------------------------------------------------------------------

/**
 * Runs `fn` immediately with dependency tracking and re-runs it whenever a
 * tracked signal's (committed) value changes. `fn` may return a cleanup that
 * runs before each re-run and on dispose. Returns a disposer.
 *
 * Effects observe the committed (BASE) world: pending transition writes do
 * not re-run effects until they fold.
 */
export function effect(fn: () => void | (() => void)): () => void {
  const w: WatcherNode = createWatcher(WATCHER_EFFECT, fn, null);
  runEffect(w);
  return () => disposeWatcher(w);
}

/** Batches writes: effects triggered inside `fn` flush once, at the end. */
export function batch<T>(fn: () => T): T {
  startBatch();
  try {
    return fn();
  } finally {
    endBatch();
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type ConfigureOptions = {
  /**
   * When true, any atom write during a computed evaluation throws. When false
   * (default), writes inside computeds are allowed as long as they don't form
   * a dependency cycle back into the writing computed (CycleError).
   */
  forbidWritesInComputeds?: boolean;
};

export function configure(options: ConfigureOptions): void {
  if (options.forbidWritesInComputeds !== undefined) {
    config.forbidWritesInComputeds = options.forbidWritesInComputeds;
  }
}
