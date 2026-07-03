/**
 * Public core API: the Atom / Computed classes and effect/batch helpers.
 *
 * These are thin wrappers over engine nodes. The engine's functional surface
 * (readAtom/writeAtom/...) stays available to the React bindings and the
 * benchmark adapter, which want zero indirection; application code uses these
 * classes.
 */

import {
  applyAtom,
  type AtomNode,
  type ComputedNode,
  type WatcherNode,
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
  set(value: T): void;
  update(fn: (current: T) => T): void;
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
  label?: string;
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
  label?: string;
};

// ---------------------------------------------------------------------------
// Observed-lifecycle delivery (Atom `effect` option)
// ---------------------------------------------------------------------------

/**
 * Stored directly on the engine node's `lifecycle` field (the engine treats
 * it as opaque and only checks it against null at watched 0↔1 transitions).
 * Only atoms with an `effect` option carry one.
 */
type LifecycleState = {
  effect: (ctx: AtomCtx<unknown>) => void | (() => void);
  ctx: AtomCtx<unknown>;
  cleanup: (() => void) | null;
  /** Desired state as of the last watched-count transition. */
  wantMounted: boolean;
  /** Actual state (effect has run and not been cleaned up). */
  isMounted: boolean;
  scheduled: boolean;
};

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
        const result = state.effect(state.ctx);
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
  const state = node.lifecycle as LifecycleState | null;
  if (state === null) return;
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

  constructor(options: AtomOptions<T>) {
    const node = createAtomNode(
      options.state,
      options.isEqual as ((a: unknown, b: unknown) => boolean) | undefined,
      null,
      options.label,
    );
    this.node = node;
    if (options.effect !== undefined) {
      const state: LifecycleState = {
        effect: options.effect as LifecycleState['effect'],
        ctx: {
          get state(): unknown {
            return untracked(() => readAtom(node));
          },
          set(value: unknown): void {
            writeAtom(node, value);
          },
          update(fn: (current: unknown) => unknown): void {
            applyAtom(node, fn);
          },
        },
        cleanup: null,
        wantMounted: false,
        isMounted: false,
        scheduled: false,
      };
      node.lifecycle = state;
    }
  }

  /** The atom's current value (reactive when read inside a tracked context). */
  get state(): T {
    return readAtom(this.node) as T;
  }

  /** Replaces the atom's value. */
  set(value: T): void {
    writeAtom(this.node, value);
  }

  /**
   * Functional update with React setState semantics: `fn` is stored in the
   * write log and replayed per world, so it rebases exactly like a queued
   * `setState(fn)` — an urgent update interleaving a pending transition
   * applies to committed state now and re-applies on top of the transition
   * when it commits. `fn` must be pure; it may run more than once.
   */
  update(fn: (current: T) => T): void {
    applyAtom(this.node, fn as (prev: unknown) => unknown);
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
      options.label,
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

// ---------------------------------------------------------------------------
// ReducerAtom
// ---------------------------------------------------------------------------

export type ReducerAtomOptions<S, A> = {
  state: S;
  /** Pure: computes the next state from the current state and an action. */
  reduce: (state: S, action: A) => S;
  /** Defaults to Object.is. */
  isEqual?: (a: S, b: S) => boolean;
  /** Debug label shown by tracing and the graphviz visualizers. */
  label?: string;
};

/**
 * An atom whose writes go through a reducer, with React useReducer
 * semantics: each dispatched action is stored in the write log and the
 * reducer is REPLAYED per world, so actions rebase exactly like queued
 * useReducer actions — an urgent dispatch interleaving a pending
 * transition's dispatch reduces committed state now, and re-reduces on top
 * of the transition's result when it commits. The reducer must be pure; it
 * can run once per world that includes an action.
 */
export class ReducerAtom<S, A> extends Atom<S> {
  readonly reduce: (state: S, action: A) => S;

  constructor(options: ReducerAtomOptions<S, A>) {
    const { reduce, ...init } = options;
    super(init);
    this.reduce = reduce;
  }

  dispatch(action: A): void {
    const reduce = this.reduce;
    applyAtom(this.node, (prev) => reduce(prev as S, action));
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

// ---------------------------------------------------------------------------
// Effects and batching
// ---------------------------------------------------------------------------

/**
 * Runs `fn` immediately with dependency tracking and re-runs it whenever a
 * tracked signal's (committed) value changes. `fn` may return a cleanup that
 * runs before each re-run and on dispose. Returns a disposer.
 *
 * Effects observe the committed world: pending transition writes do not
 * re-run effects until their batch retires.
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
  /**
   * When true, reading a signal raw (`atom.state` in a render body, not
   * through useSignal/useComputed) while React is rendering throws. Such
   * reads are not reactive and bypass the render's world. The React bindings
   * turn this on automatically in development builds; set it explicitly to
   * override either way.
   */
  throwOnUntrackedReadsInRender?: boolean;
};

const explicitlyConfigured = new Set<keyof ConfigureOptions>();

export function configure(options: ConfigureOptions): void {
  if (options.forbidWritesInComputeds !== undefined) {
    config.forbidWritesInComputeds = options.forbidWritesInComputeds;
    explicitlyConfigured.add('forbidWritesInComputeds');
  }
  if (options.throwOnUntrackedReadsInRender !== undefined) {
    config.throwOnUntrackedReadsInRender = options.throwOnUntrackedReadsInRender;
    explicitlyConfigured.add('throwOnUntrackedReadsInRender');
  }
}

/** Internal: lets the React bindings apply dev-mode defaults without
 * overriding anything the app configured explicitly. */
export function wasExplicitlyConfigured(key: keyof ConfigureOptions): boolean {
  return explicitlyConfigured.has(key);
}
