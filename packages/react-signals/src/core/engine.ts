/**
 * The reactive engine: dependency graph, invalidation, evaluation, and the
 * world model that makes signals safe under concurrent React.
 *
 * ## Shape of the graph
 *
 * Nodes are atoms (source values), computeds (derived values), and watchers
 * (effects and React subscriptions). Dependencies are intrusive doubly-linked
 * `Link` records shared between two lists — the dep's subscriber list and the
 * sub's dependency list — following alien-signals (see
 * notes/research/alien-signals.md). Links are reused across re-evaluations via
 * a cursor (`depsTail`), so a re-run with a stable dependency set allocates
 * nothing.
 *
 * ## State model: the write log is the truth
 *
 * While React bindings are active, every observable write appends a log
 * entry: `{ value | apply, batch, seq, retiredAtSeq }`. `batch` is an opaque
 * token from the React patch identifying the update batch the write belongs
 * to (`deferred` = transition-like); `seq` is a global write ticket;
 * `retiredAtSeq` is stamped when the batch retires. Exactly ONE function
 * derives values from the log:
 *
 *     replayLog(atom, includes) — apply the entries the filter admits, in
 *     write order; plain sets overwrite, functional updates apply to the
 *     value accumulated so far. This is what gives update()/dispatch()
 *     React's useState/useReducer rebasing semantics: an updater runs once
 *     per world that includes it, against THAT world's previous value.
 *
 * Three kinds of world read the log:
 *
 * - COMMITTED: retired entries + pending immediate (non-deferred) entries.
 *   What urgent renders and effects observe.
 * - HEAD: every entry. What transition renders and non-render reads observe.
 * - Render-pass worlds: pinned at pass start; an entry is visible if it
 *   retired before the pin, or its batch is one the pass includes and it was
 *   written before the pin. (DESIGN.md §2: this reproduces React's own
 *   hook-update-queue semantics, including rebasing.)
 *
 * COMMITTED and HEAD are hot, so each atom carries a memoized view of each
 * (`committedLatest` / `headLatest`), advanced incrementally at write time
 * under one contract: the view equals the replay. Retirement recomputes the
 * committed view BY replay — that is what rebases pending immediate updaters
 * on top of a just-retired transition, and what makes rollback structurally
 * impossible. While no deferred entries are pending (`forkCount === 0`,
 * "steady"), the two views are one and the engine behaves exactly like a
 * classic signals library.
 *
 * ## Staleness tracking for the two live views
 *
 * Nodes carry {Pending, Dirty} flag pairs per live view (the COMMITTED and
 * HEAD "planes"), and each Link records which planes the dependency edge
 * exists in — a computed's dependency SET can differ between worlds
 * (`a.state <= 1 ? b.state : 0`); missing that was a confirmed missed-update
 * bug class. Outside forked mode every flag operation treats the two planes
 * as one.
 *
 * ## Notification protocol (the load-bearing ordering rule)
 *
 * A write proceeds in strict phases:
 *   1. propagate() marks every reachable subscriber Pending and *queues*
 *      watchers. It never reads, computes, or runs user code.
 *   2. Subscriptions drain: each queued subscription confirms its change with
 *      a pull (equality cut-off, diamonds converge) and, if real, fires
 *      onChange — still synchronously inside the writer's context, which is
 *      what lets React attribute whatever onChange schedules to the writer's
 *      batch.
 *   3. Effects flush (unless batched or mid-evaluation).
 * Confirming *during* propagation is unsound — the first subscriber's pull
 * consumes the source's dirty bit before later subscribers are marked — so
 * watchers are only ever queued during the wave. Both deliveries wait for
 * batch() to end (N writes → at most one notification per subscription).
 *
 * ## Watchedness
 *
 * A node is "watched" when some watcher transitively depends on it;
 * watched-ness propagates as a refcount along dependency links. An atom's
 * 0↔1 transitions drive its `effect` lifecycle option.
 *
 * ## Other invariants
 *
 * - Evaluation never throws through the graph: a computed's result is a
 *   value, an error, or a suspension, stored as a status; read *sites*
 *   rethrow/suspend (SuspendedRead).
 * - Only one tracked evaluation runs at a time, so a single RecursedCheck bit
 *   serves both planes.
 * - The committed view changes only via immediate writes and retirements;
 *   render passes read via their pinned world, so neither kind of change can
 *   tear a yielded render.
 * - Zero-allocation steady writes (the "observability gate"): with no
 *   deferred batch pending and no render pass in flight, an immediate write
 *   skips the log entirely — nothing could observe the difference.
 */

import { tracer, currentCause, setCurrentCause } from './tracing.ts';

// ---------------------------------------------------------------------------
// Flags, planes, node kinds
// ---------------------------------------------------------------------------

export const PLANE_COMMITTED = 1;
export const PLANE_HEAD = 2;
export const PLANE_BOTH = 3;
export type Plane = 1 | 2;

export const F = {
  None: 0,
  /** Node produces a value (atoms always; computeds once first evaluated). */
  Mutable: 1 << 0,
  /** Watcher wants notification when invalidated. Cleared while queued. */
  Watching: 1 << 1,
  /** Node is currently evaluating (tracking in progress). */
  RecursedCheck: 1 << 2,
  /** Node was re-invalidated during its own run; next propagate re-marks it. */
  Recursed: 1 << 3,
  /** COMMITTED view: definitely stale. */
  Dirty: 1 << 4,
  /** COMMITTED view: possibly stale; resolve via checkDirty. */
  Pending: 1 << 5,
  /** HEAD view (forked mode only): definitely stale. */
  HeadDirty: 1 << 6,
  /** HEAD view (forked mode only): possibly stale. */
  HeadPending: 1 << 7,
} as const;

function dirtyBit(plane: Plane): number {
  return plane === PLANE_COMMITTED ? F.Dirty : F.HeadDirty;
}
function pendingBit(plane: Plane): number {
  return plane === PLANE_COMMITTED ? F.Pending : F.HeadPending;
}
const ALL_PLANE_BITS = F.Dirty | F.Pending | F.HeadDirty | F.HeadPending;

/**
 * The bits to clear when a pull validates/refreshes `plane`. Outside forked
 * mode the planes are one; leaving the other plane's bits set would let a
 * later propagate wrongly prune ("already marked").
 */
function clearBits(plane: Plane): number {
  return forkCount > 0 ? dirtyBit(plane) | pendingBit(plane) : ALL_PLANE_BITS;
}

/**
 * The plane mask an operation in `mask` actually touches: outside forked mode
 * the planes are one, so any mask widens to both (links, marks, and prunes
 * must agree on this or a later fork sees half-tracked state).
 */
function effectivePlanes(mask: number): number {
  return forkCount > 0 ? mask : PLANE_BOTH;
}

export const KIND_ATOM = 0;
export const KIND_COMPUTED = 1;
const KIND_WATCHER = 2;

export type Link = {
  /** Tracking-run stamp: dedupes repeated reads within one evaluation. */
  version: number;
  /** PLANE_* bits: which planes this dependency edge exists in. */
  planes: number;
  dep: Node;
  sub: Node;
  prevSub: Link | undefined;
  nextSub: Link | undefined;
  prevDep: Link | undefined;
  nextDep: Link | undefined;
};

/**
 * Common header shared by AtomNode / ComputedNode / WatcherNode. Keep these
 * fields first and in this order in every node constructor so engine code
 * stays monomorphic on the header.
 */
export type Node = {
  kind: number;
  flags: number;
  /** Count of watchers transitively depending on this node. */
  watched: number;
  deps: Link | undefined;
  depsTail: Link | undefined;
  subs: Link | undefined;
  subsTail: Link | undefined;
};

/**
 * Identity of the update batch a write belongs to. Supplied by the React
 * patch (an opaque token); the engine reads only `deferred`. Batches retire
 * exactly once via retireBatch.
 */
export type BatchRef = { readonly deferred: boolean };

export type WriteEntry = {
  /** For a plain set: the written value. Unused when `apply` is present. */
  value: unknown;
  /** For a functional update: pure; replayed once per world that includes it. */
  apply: ((prev: unknown) => unknown) | null;
  batch: BatchRef;
  /** Global write ticket. */
  seq: number;
  /** 0 while the batch is pending; a fresh ticket once it retired. */
  retiredAtSeq: number;
};

export type AtomNode = Node & {
  /** Debug label (Atom `label` option); used by tracing and visualizers. */
  label: string | null;
  /** COMMITTED view as of the last pull (alien-signals' `currentValue`). */
  committedValue: unknown;
  /** COMMITTED view, latest (alien's `pendingValue`; pulled lazily on read). */
  committedLatest: unknown;
  /** HEAD view, latest. Identical to committedLatest while steady. */
  headLatest: unknown;
  /** Replay base: the value before the oldest retained log entry. */
  preLogValue: unknown;
  log: WriteEntry[] | null;
  isEqual: (a: unknown, b: unknown) => boolean;
  /** Observed-lifecycle state (Atom `effect` option), owned by api.ts; the
   * engine only checks it against null at watched 0↔1 transitions. */
  lifecycle: unknown;
};

const STATUS_VALUE = 0;
export const STATUS_ERROR = 1;
export const STATUS_SUSPENDED = 2;

/**
 * One cached result of a computed in one world. `world` is WORLD_COMMITTED,
 * WORLD_HEAD, or a RenderWorld (identity-keyed). `gen` stamps which fork
 * generation the result belongs to: a HEAD result is only trustworthy in the
 * fork that produced it, and a COMMITTED result computed *during* a fork
 * excludes that fork's deferred writes (so it must not seed HEAD).
 */
export type ComputedResult = {
  world: object;
  status: number;
  value: unknown;
  payload: unknown;
  gen: number;
};

export type ComputedNode = Node & {
  /** Debug label (Computed `label` option); used by tracing and visualizers. */
  label: string | null;
  /** World-keyed results: COMMITTED, HEAD (while forked), render passes. */
  results: ComputedResult[];
  /** Hot-path alias of the WORLD_COMMITTED entry in `results` (steady-mode
   * reads resolve through this without scanning). */
  committed: ComputedResult | null;
  fn: (ctx: unknown) => unknown;
  isEqual: (a: unknown, b: unknown) => boolean;
  /** Positional thenable cache for ctx.use across re-evaluations. */
  thenables: unknown[] | null;
  /** Thenable a settle-listener is attached to (dedupe marker). */
  settleAttached: unknown;
};

export const WATCHER_EFFECT = 0;
export const WATCHER_SUBSCRIPTION = 1;

export type WatcherNode = Node & {
  watcherKind: number;
  /** EFFECT: the tracked function; may return a cleanup. */
  fn: (() => void | (() => void)) | null;
  cleanup: (() => void) | null;
  /** SUBSCRIPTION: fired after a confirmed change, in the writer's context. */
  onChange: ((plane: Plane) => void) | null;
  /** SUBSCRIPTION: plane mask accumulated while queued for confirmation. */
  queuedPlanes: number;
};

// ---------------------------------------------------------------------------
// World keys
// ---------------------------------------------------------------------------

/** Identity keys for the two live views' computed-cache entries. */
export const WORLD_COMMITTED: object = {};
export const WORLD_HEAD: object = {};

/**
 * A render pass's pinned view of the world. Created by the React bindings at
 * pass start; object identity doubles as the computed-cache key. Immutable
 * for the life of the pass by construction (writes after the pin are
 * excluded by seq; retirements after the pin by retiredAtSeq), which is why
 * pass cache entries never need validation.
 */
export type RenderWorld = {
  /** Tokens of every batch this render pass includes. */
  includes: readonly BatchRef[];
  /** Writes/retirements after this ticket are invisible to the pass. */
  maxSeq: number;
  /** Cached "does this world include a pending deferred batch"; lazy. */
  seesDeferred: boolean | null;
};

export function createRenderWorld(includes: readonly BatchRef[], maxSeq: number): RenderWorld {
  return { includes, maxSeq, seesDeferred: null };
}

function worldIncludesBatch(world: RenderWorld, batch: BatchRef): boolean {
  const includes = world.includes;
  for (let i = 0; i < includes.length; i++) {
    if (includes[i] === batch) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Engine globals
// ---------------------------------------------------------------------------

let trackVersion = 0;
let activeSub: Node | undefined;
let activePlane: Plane = PLANE_COMMITTED;
let batchDepth = 0;
let evalDepth = 0;

/** Number of unretired deferred entries; > 0 means the views are forked. */
let forkCount = 0;
/** Bumped each time the engine enters forked mode; stamps cache trust. */
let forkGen = 0;

let writeSeq = 0;
/** writeSeq at the last COMMITTED-view change (immediate write/retirement). */
let committedChangeSeq = 0;
/** writeSeq at the last change in any view. */
let headChangeSeq = 0;

/** Atoms with non-empty logs, for world reads and retirement sweeps. */
const loggedAtoms: Set<AtomNode> = new Set();

// Effect queue (flat array; the Watching bit doubles as "already queued").
const queuedEffects: (WatcherNode | undefined)[] = [];
let effectQueueLength = 0;
let effectQueueIndex = 0;

// Subscription queue: marked during propagate, confirmed+fired by
// drainSubscriptions after the wave completes.
const queuedSubscriptions: (WatcherNode | undefined)[] = [];
let subQueueLength = 0;
let subQueueIndex = 0;

/**
 * True while retirement- or settle-driven propagation runs. Subscriptions are
 * not even marked during it: components already observed those values;
 * marking without confirming would permanently swallow later notifications.
 */
let mutedSubscriptions = false;

/** Should the current wave skip this subscriber? (See mutedSubscriptions.) */
function isMutedSubscription(sub: Node): boolean {
  return (
    mutedSubscriptions &&
    sub.kind === KIND_WATCHER &&
    (sub as WatcherNode).watcherKind === WATCHER_SUBSCRIPTION
  );
}

export type EngineConfig = {
  forbidWritesInComputeds: boolean;
  /** Throw on raw (untracked) signal reads while React renders; see api.ts. */
  throwOnUntrackedReadsInRender: boolean;
};
export const config: EngineConfig = {
  forbidWritesInComputeds: false,
  throwOnUntrackedReadsInRender: false,
};

/** Installed by the React bindings: true while React is rendering. */
let renderGuard: (() => boolean) | null = null;
export function setRenderGuard(guard: (() => boolean) | null): void {
  renderGuard = guard;
}

function checkUntrackedRenderRead(node: AtomNode | ComputedNode): void {
  if (config.throwOnUntrackedReadsInRender && renderGuard !== null && renderGuard()) {
    const label = node.label ?? '(unlabeled)';
    throw new Error(
      `Untracked read of signal ${label} during render. Reads in render bodies ` +
        'must go through useSignal/useComputed so the component re-renders when ' +
        'the signal changes (and reads the correct world during transitions). ' +
        'To allow raw render reads, configure({ throwOnUntrackedReadsInRender: false }).',
    );
  }
}

/**
 * Installed by the React bindings: returns the batch token for a write
 * happening right now, or null when no React bookkeeping is needed.
 */
export type WriteBatchProvider = () => BatchRef | null;
let writeBatchProvider: WriteBatchProvider | null = null;
export function setWriteBatchProvider(p: WriteBatchProvider | null): void {
  writeBatchProvider = p;
}

/** Ambient render world; set by the React bindings around render reads. */
let ambientWorld: RenderWorld | null = null;
export function setAmbientWorld(world: RenderWorld | null): RenderWorld | null {
  const prev = ambientWorld;
  ambientWorld = world;
  return prev;
}

// Active render passes pin log entries (and pass cache results) against GC.
const activePins: number[] = [];
/** Computeds holding a render-pass cache result; swept on last unpin. */
const passCachedNodes: ComputedNode[] = [];

/** A world key that is a render pass (as opposed to a live view). */
function isPassWorld(world: object): boolean {
  return world !== WORLD_COMMITTED && world !== WORLD_HEAD;
}

/** True while any render pass is pinned (provider-side observability gate). */
export function hasActivePins(): boolean {
  return activePins.length > 0;
}

export function pinRenderPass(maxSeq: number): void {
  activePins.push(maxSeq);
}
export function unpinRenderPass(maxSeq: number): void {
  const i = activePins.indexOf(maxSeq);
  if (i !== -1) activePins.splice(i, 1);
  if (activePins.length === 0) {
    for (const node of passCachedNodes) {
      // Drop render-pass entries; keep COMMITTED/HEAD entries.
      const results = node.results;
      for (let j = results.length - 1; j >= 0; j--) {
        if (isPassWorld(results[j]!.world)) results.splice(j, 1);
      }
    }
    passCachedNodes.length = 0;
    sweepLogs();
  }
}

// ---------------------------------------------------------------------------
// Errors and suspension signals
// ---------------------------------------------------------------------------

export class CycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CycleError';
  }
}

/**
 * Thrown when a read encounters a pending thenable: by read sites whose
 * computed's current result is a suspension, and by ctx.use itself inside an
 * evaluation. Evaluation catches it (the computed's result becomes
 * STATUS_SUSPENDED); the React bindings catch it at read sites and suspend
 * via React's `use()`.
 */
export class SuspendedRead {
  thenable: PromiseLike<unknown>;
  constructor(thenable: PromiseLike<unknown>) {
    this.thenable = thenable;
  }
}

type InstrumentedThenable = PromiseLike<unknown> & {
  status?: 'pending' | 'fulfilled' | 'rejected';
  value?: unknown;
  reason?: unknown;
};

function noop(): void {}

// ---------------------------------------------------------------------------
// Watched refcount and the atom observed lifecycle
// ---------------------------------------------------------------------------

let onAtomWatched: ((atom: AtomNode) => void) | null = null;
let onAtomUnwatched: ((atom: AtomNode) => void) | null = null;
export function setAtomLifecycleDelivery(
  watched: (atom: AtomNode) => void,
  unwatched: (atom: AtomNode) => void,
): void {
  onAtomWatched = watched;
  onAtomUnwatched = unwatched;
}

function addWatched(node: Node, delta: number): void {
  const before = node.watched;
  node.watched = before + delta;
  if (before === 0 && delta > 0) {
    if (node.kind === KIND_ATOM) {
      if ((node as AtomNode).lifecycle !== null && onAtomWatched !== null) {
        onAtomWatched(node as AtomNode);
      }
    } else if (node.kind === KIND_COMPUTED) {
      for (let l = node.deps; l !== undefined; l = l.nextDep) addWatched(l.dep, 1);
    }
  } else if (node.watched === 0 && delta < 0) {
    if (node.kind === KIND_ATOM) {
      if ((node as AtomNode).lifecycle !== null && onAtomUnwatched !== null) {
        onAtomUnwatched(node as AtomNode);
      }
    } else if (node.kind === KIND_COMPUTED) {
      for (let l = node.deps; l !== undefined; l = l.nextDep) addWatched(l.dep, -1);
    }
  }
}

function subContributesWatch(sub: Node): boolean {
  return sub.kind === KIND_WATCHER || sub.watched > 0;
}

// ---------------------------------------------------------------------------
// Linking (ported from alien-signals)
// ---------------------------------------------------------------------------

function link(dep: Node, sub: Node, planeBits: number): void {
  const prevDep = sub.depsTail;
  if (prevDep !== undefined && prevDep.dep === dep) {
    prevDep.planes |= planeBits;
    return; // consecutive duplicate read
  }
  const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps;
  if (nextDep !== undefined && nextDep.dep === dep) {
    // Reuse last run's link in place (stable dependency order).
    nextDep.version = trackVersion;
    nextDep.planes |= planeBits;
    sub.depsTail = nextDep;
    return;
  }
  const depLastSub = dep.subsTail;
  if (depLastSub !== undefined && depLastSub.version === trackVersion && depLastSub.sub === sub) {
    depLastSub.planes |= planeBits;
    return; // non-adjacent duplicate read within this run
  }
  const newLink: Link = {
    version: trackVersion,
    planes: planeBits,
    dep,
    sub,
    prevDep,
    nextDep,
    prevSub: dep.subsTail,
    nextSub: undefined,
  };
  sub.depsTail = newLink;
  if (prevDep !== undefined) prevDep.nextDep = newLink;
  else sub.deps = newLink;
  if (nextDep !== undefined) nextDep.prevDep = newLink;
  if (dep.subsTail !== undefined) dep.subsTail.nextSub = newLink;
  else dep.subs = newLink;
  dep.subsTail = newLink;
  if (subContributesWatch(sub)) addWatched(dep, 1);
}

/** Unlinks from both lists; returns the next dep link for iteration. */
function unlink(l: Link, sub: Node): Link | undefined {
  const dep = l.dep;
  const { prevDep, nextDep, prevSub, nextSub } = l;
  if (nextDep !== undefined) nextDep.prevDep = prevDep;
  else sub.depsTail = prevDep;
  if (prevDep !== undefined) prevDep.nextDep = nextDep;
  else sub.deps = nextDep;
  if (nextSub !== undefined) nextSub.prevSub = prevSub;
  else dep.subsTail = prevSub;
  if (prevSub !== undefined) prevSub.nextSub = nextSub;
  else dep.subs = nextSub;
  if (subContributesWatch(sub)) addWatched(dep, -1);
  if (dep.subs === undefined && dep.kind === KIND_COMPUTED) {
    // Last subscriber left: forget results (forces recompute on next read)
    // and release this computed's own dependencies (cascades up the chain).
    dep.flags = F.Mutable | F.Dirty | F.HeadDirty;
    (dep as ComputedNode).results.length = 0;
    (dep as ComputedNode).committed = null;
    let depOfDep = dep.deps;
    while (depOfDep !== undefined) {
      depOfDep = unlink(depOfDep, dep);
    }
  }
  return nextDep;
}

/**
 * alien-signals' isValidLink: is `checkLink` among the dependencies `sub` has
 * tracked *so far in the current run*? Links after the cursor are stale
 * leftovers from the previous run and must not trigger cycle errors.
 */
function isValidLink(checkLink: Link, sub: Node): boolean {
  const tail = sub.depsTail;
  if (tail === undefined) return false;
  let l = sub.deps;
  while (l !== undefined) {
    if (l === checkLink) return true;
    if (l === tail) break;
    l = l.nextDep;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tracking scaffolding
// ---------------------------------------------------------------------------

type TrackFrame = { prevSub: Node | undefined; prevPlane: Plane };

function startTracking(node: Node, plane: Plane): TrackFrame {
  node.depsTail = undefined;
  node.flags = (node.flags & ~(F.Recursed | clearBits(plane))) | F.RecursedCheck;
  const frame: TrackFrame = { prevSub: activeSub, prevPlane: activePlane };
  activeSub = node;
  activePlane = plane;
  ++trackVersion;
  return frame;
}

function endTracking(node: Node, frame: TrackFrame, plane: Plane): void {
  activeSub = frame.prevSub;
  activePlane = frame.prevPlane;
  node.flags &= ~F.RecursedCheck;
  // Prune links not re-read this run: clear this run's plane membership and
  // drop links that belong to no plane. Outside forked mode there is only one
  // plane, so stale links are removed outright.
  const clearMask = effectivePlanes(plane);
  const cursor = node.depsTail;
  let l = cursor !== undefined ? cursor.nextDep : node.deps;
  while (l !== undefined) {
    l.planes &= ~clearMask;
    l = l.planes === 0 ? unlink(l, node) : l.nextDep;
  }
}

/** Runs fn without dependency tracking. */
export function untracked<T>(fn: () => T): T {
  const prev = activeSub;
  activeSub = undefined;
  try {
    return fn();
  } finally {
    activeSub = prev;
  }
}

// ---------------------------------------------------------------------------
// Push phase: propagate / shallowPropagate (mark + queue only)
// ---------------------------------------------------------------------------

type Stack<T> = { value: T; prev: Stack<T> | undefined };

/**
 * Marks subscribers reachable from `subsHead` possibly-stale in the planes of
 * `mask` and queues watchers. Never reads, computes, or runs user code.
 *
 * `cycleGuard` is the node currently evaluating when the triggering write
 * happened inside an evaluation; reaching it through a link it has tracked
 * this run means the write feeds its own evaluation — a dependency cycle.
 */
function propagate(subsHead: Link, mask: number, cycleGuard: Node | undefined): void {
  let l: Link | undefined = subsHead;
  let stack: Stack<Link> | undefined;

  while (l !== undefined) {
    const next: Link | undefined = l.nextSub;
    if ((l.planes & mask) !== 0) {
      const sub: Node = l.sub;
      if (sub === cycleGuard && isValidLink(l, sub)) {
        throw new CycleError(
          'Write inside a computed feeds back into that computed (dependency cycle).',
        );
      }
      if (!isMutedSubscription(sub) && sub !== cycleGuard) {
        const flags = sub.flags;
        const linkMask = l.planes & mask;
        const wantPending =
          ((linkMask & PLANE_COMMITTED) !== 0 ? F.Pending : 0) |
          ((linkMask & PLANE_HEAD) !== 0 ? F.HeadPending : 0);
        // A plane is "already marked" if the sub has Pending or Dirty there.
        const alreadyMarked =
          ((flags & (F.Pending | F.Dirty)) !== 0 || (wantPending & F.Pending) === 0) &&
          ((flags & (F.HeadPending | F.HeadDirty)) !== 0 || (wantPending & F.HeadPending) === 0);

        let shouldQueue = false;
        let shouldDescend = false;
        if ((flags & (F.RecursedCheck | F.Recursed)) === 0) {
          if (!alreadyMarked) {
            sub.flags = flags | wantPending;
            shouldQueue = true;
            shouldDescend = true;
          }
          // else: marked in every relevant plane — prune this branch.
        } else if ((flags & F.RecursedCheck) === 0) {
          // Stale Recursed marker from a previous self-trigger: treat as fresh.
          sub.flags = (flags & ~F.Recursed) | wantPending;
          shouldQueue = true;
          shouldDescend = true;
        } else {
          // Currently evaluating (e.g. an effect writing a dep it already
          // read): mark for a future wave, don't queue, still forward
          // invalidation through mutable nodes.
          sub.flags = flags | F.Recursed | wantPending;
          shouldDescend = (flags & F.Mutable) !== 0;
        }
        if (shouldQueue && (sub.flags & F.Watching) !== 0) {
          queueWatcher(sub as WatcherNode, linkMask);
        }
        if (shouldDescend && (sub.flags & F.Mutable) !== 0 && sub.subs !== undefined) {
          if (next !== undefined) stack = { value: next, prev: stack };
          l = sub.subs;
          continue;
        }
      }
    }
    if (next !== undefined) {
      l = next;
    } else if (stack !== undefined) {
      l = stack.value;
      stack = stack.prev;
    } else {
      l = undefined;
    }
  }
}

/**
 * One-level Pending→Dirty promotion after a pull *proves* a node's value
 * changed: other subscribers that were merely Pending now know they are
 * Dirty, and watchers among them get queued even though no new propagate ran.
 */
function shallowPropagate(subsHead: Link | undefined, plane: Plane): void {
  const pBit = pendingBit(plane);
  const dBit = dirtyBit(plane);
  for (let l = subsHead; l !== undefined; l = l.nextSub) {
    if ((l.planes & plane) === 0) continue;
    const sub = l.sub;
    if (isMutedSubscription(sub)) continue;
    const flags = sub.flags;
    if ((flags & (pBit | dBit)) === pBit) {
      sub.flags = flags | dBit;
      if ((flags & F.Watching) !== 0 && (flags & F.RecursedCheck) === 0) {
        queueWatcher(sub as WatcherNode, plane);
      }
    }
  }
}

/** Queues a watcher; the Watching bit doubles as the "already queued" mark. */
function queueWatcher(w: WatcherNode, planeMask: number): void {
  if (w.watcherKind === WATCHER_SUBSCRIPTION) {
    w.queuedPlanes |= planeMask;
    if ((w.flags & F.Watching) === 0) return; // already queued
    w.flags &= ~F.Watching;
    queuedSubscriptions[subQueueLength++] = w;
    return;
  }
  if ((w.flags & F.Watching) === 0) return; // already queued
  w.flags &= ~F.Watching;
  queuedEffects[effectQueueLength++] = w;
}

// ---------------------------------------------------------------------------
// Notification delivery (after propagation completes)
// ---------------------------------------------------------------------------

/**
 * Confirms and fires queued subscriptions, then flushes queued effects.
 * Called after every propagation wave. Both deliveries wait for `batch()` to
 * end: the queue's dedupe means N writes inside one batch produce at most one
 * confirmation and one onChange per subscription, still synchronously inside
 * whatever context called endBatch (batch attribution needs that).
 */
function deliverNotifications(): void {
  if (batchDepth !== 0) return;
  if (subQueueIndex < subQueueLength) drainSubscriptions();
  if (evalDepth === 0 && effectQueueIndex < effectQueueLength) {
    flushEffects();
  }
}

function drainSubscriptions(): void {
  while (subQueueIndex < subQueueLength) {
    const w = queuedSubscriptions[subQueueIndex]!;
    queuedSubscriptions[subQueueIndex++] = undefined;
    if (w.flags === F.None) continue; // disposed while queued
    w.flags |= F.Watching;
    const planes = w.queuedPlanes;
    w.queuedPlanes = 0;
    // Confirm against every plane the marks came from: a forked write can
    // change COMMITTED while HEAD cuts off (or vice versa) — checking one
    // plane and clearing both would swallow the change.
    let firedPlane: Plane | 0 = 0;
    if (forkCount > 0 && (planes & PLANE_HEAD) !== 0 && confirmPlane(w, PLANE_HEAD)) {
      firedPlane = PLANE_HEAD;
    } else if ((planes & PLANE_COMMITTED) !== 0 && confirmPlane(w, PLANE_COMMITTED)) {
      firedPlane = PLANE_COMMITTED;
    } else if (
      forkCount === 0 &&
      (planes & PLANE_HEAD) !== 0 &&
      confirmPlane(w, PLANE_COMMITTED)
    ) {
      // Steady mode: HEAD marks are COMMITTED marks.
      firedPlane = PLANE_COMMITTED;
    }
    w.flags &= ~ALL_PLANE_BITS;
    if (firedPlane !== 0 && w.onChange !== null) {
      const prevCause =
        tracer !== null ? setCurrentCause(tracer.emit('notify', currentCause, w)) : 0;
      try {
        w.onChange(firedPlane);
      } finally {
        if (tracer !== null) setCurrentCause(prevCause);
      }
    }
  }
  subQueueIndex = 0;
  subQueueLength = 0;
}

function confirmPlane(w: WatcherNode, plane: Plane): boolean {
  const flags = w.flags;
  if ((flags & dirtyBit(plane)) !== 0) return true;
  if ((flags & pendingBit(plane)) !== 0) {
    w.flags &= ~pendingBit(plane);
    return w.deps !== undefined && checkDirty(w.deps, w, plane);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pull phase: checkDirty
// ---------------------------------------------------------------------------

/**
 * Resolves a Pending `sub` in `plane`: walks its dependency graph depth-first,
 * updating upstream dirty computeds as needed. Returns whether any direct
 * dependency of `sub` truly changed (with equality cutoff at every level).
 * Iterative; the stack holds the parent link we descended through.
 */
function checkDirty(startLink: Link, startSub: Node, plane: Plane): boolean {
  const dBit = dirtyBit(plane);
  const pBit = pendingBit(plane);
  let stack: Stack<Link> | undefined;
  let sub = startSub;
  let l: Link | undefined = startLink;
  let dirty = false;

  for (;;) {
    // Walk phase: scan `sub`'s remaining deps for a proven or possible change.
    dirty = false;
    while (l !== undefined) {
      if ((l.planes & plane) !== 0) {
        if ((sub.flags & dBit) !== 0) {
          dirty = true;
          break;
        }
        const dep = l.dep;
        const depFlags = dep.flags;
        if (dep.kind === KIND_ATOM) {
          // In HEAD, an unpulled COMMITTED-view write (F.Dirty from steady
          // mode, before the fork) also means the head value moved — head
          // values are written eagerly, so both bits imply "changed".
          const atomDirtyBits = plane === PLANE_COMMITTED ? F.Dirty : F.HeadDirty | F.Dirty;
          if ((depFlags & atomDirtyBits) !== 0) {
            if (updateAtomForPlane(dep as AtomNode, plane)) {
              if (dep.subs !== undefined && dep.subs.nextSub !== undefined) {
                shallowPropagate(dep.subs, plane);
              }
              dirty = true;
              break;
            }
          }
        } else if ((depFlags & (F.Mutable | dBit)) === (F.Mutable | dBit)) {
          if (updateComputed(dep as ComputedNode, plane)) {
            if (dep.subs !== undefined && dep.subs.nextSub !== undefined) {
              shallowPropagate(dep.subs, plane);
            }
            dirty = true;
            break;
          }
        } else if ((depFlags & (F.Mutable | pBit)) === (F.Mutable | pBit)) {
          // Possibly-stale computed: descend into its deps.
          stack = { value: l, prev: stack };
          sub = dep;
          l = dep.deps;
          continue;
        }
      }
      l = l.nextDep;
    }

    // Resolve phase: `sub`'s walk ended (dirty-break or deps exhausted).
    for (;;) {
      if (!dirty) sub.flags &= ~pBit;
      if (stack === undefined) {
        // Guard against the sub having been disposed by an update's side
        // effects mid-check (alien-signals' `dirty && !!sub.flags`).
        return dirty && startSub.flags !== F.None;
      }
      const parentLink = stack.value;
      const descended = sub; // the computed we had descended into
      const parent = parentLink.sub;
      if (dirty) {
        if (updateComputed(descended as ComputedNode, plane)) {
          shallowPropagate(descended.subs, plane);
          // Its value changed → parent has a changed direct dep. Unwind.
          stack = stack.prev;
          sub = parent;
          continue;
        }
        // Equality cutoff: descended recomputed to an equal value.
        dirty = false;
      }
      // Not dirty: resume the parent's walk after the descended link.
      stack = stack.prev;
      sub = parent;
      l = parentLink.nextDep;
      break;
    }
  }
}

/**
 * Brings an atom's plane view up to date and reports whether it changed.
 * COMMITTED: pulls the latest write (alien-signals' lazy commit). HEAD:
 * values are eager, so a dirty bit means "changed"; an unpulled pre-fork
 * write is pulled here too (it is part of head history by definition).
 */
function updateAtomForPlane(atom: AtomNode, plane: Plane): boolean {
  if (plane === PLANE_HEAD) {
    let changed = (atom.flags & F.HeadDirty) !== 0;
    atom.flags &= ~F.HeadDirty;
    if ((atom.flags & F.Dirty) !== 0) {
      if (updateAtom(atom)) {
        // Cross-plane promotion: this HEAD walk consumed the COMMITTED dirty
        // bit; every COMMITTED-Pending subscriber must be promoted now — no
        // single-subscriber shortcut, that optimization is only valid within
        // one plane.
        shallowPropagate(atom.subs, PLANE_COMMITTED);
        changed = true;
      }
    }
    return changed;
  }
  return updateAtom(atom);
}

/** Pulls an atom's latest committed-view write into its pulled value. */
function updateAtom(atom: AtomNode): boolean {
  atom.flags &= ~F.Dirty;
  const prev = atom.committedValue;
  const next = atom.committedLatest;
  if (atom.isEqual(prev, next)) return false;
  atom.committedValue = next;
  return true;
}

// Positional thenable cache of the in-flight evaluation (ctx.use).
let evalThenableIndex = 0;
let evalThenables: unknown[] | null = null;

// ---------------------------------------------------------------------------
// Computed results (world-keyed cache)
// ---------------------------------------------------------------------------

export function findResult(c: ComputedNode, world: object): ComputedResult | null {
  if (world === WORLD_COMMITTED) return c.committed;
  const results = c.results;
  for (let i = 0; i < results.length; i++) {
    if (results[i]!.world === world) return results[i]!;
  }
  return null;
}

function planeWorld(plane: Plane): object {
  return plane === PLANE_HEAD && forkCount > 0 ? WORLD_HEAD : WORLD_COMMITTED;
}

/**
 * Re-evaluates a computed in `plane`. Returns whether its observable result
 * (value, error, or suspension) changed. Never throws — except CycleError,
 * which is a programming error that must fail loudly at the offending site.
 */
function updateComputed(c: ComputedNode, plane: Plane): boolean {
  const frame = startTracking(c, plane);
  const prevThenables = evalThenables;
  const prevThenableIndex = evalThenableIndex;
  if (c.thenables === null) c.thenables = [];
  evalThenables = c.thenables;
  evalThenableIndex = 0;
  ++evalDepth;
  ++batchDepth; // defer notification delivery for writes inside the getter
  const traceCause =
    tracer !== null
      ? setCurrentCause(tracer.emit('computed-eval', currentCause, c, { plane }))
      : 0;

  let status = STATUS_VALUE;
  let value: unknown = undefined;
  let payload: unknown = undefined;
  let cycleError: CycleError | null = null;
  try {
    value = c.fn(computedCtx);
  } catch (e) {
    if (e instanceof SuspendedRead) {
      // A pending ctx.use, or a suspended dependency: this computed suspends
      // on the same thenable (payload identity stays stable for the cutoff).
      status = STATUS_SUSPENDED;
      payload = e.thenable;
    } else if (e instanceof CycleError) {
      status = STATUS_ERROR;
      payload = e;
      cycleError = e;
    } else {
      status = STATUS_ERROR;
      payload = e;
    }
  } finally {
    if (c.thenables !== null && evalThenableIndex < c.thenables.length) {
      c.thenables.length = evalThenableIndex; // drop unused thenable slots
    }
    evalThenables = prevThenables;
    evalThenableIndex = prevThenableIndex;
    --batchDepth;
    --evalDepth;
    endTracking(c, frame, plane);
    if (tracer !== null) setCurrentCause(traceCause);
  }

  const world = planeWorld(plane);
  let entry = findResult(c, world);
  let changed: boolean;
  try {
    // Note: entry.gen is deliberately NOT part of change detection — gen
    // governs seeding trust (ensureHeadResult), and a stale-generation entry
    // holding an equal value is still a legitimate equality cutoff.
    changed =
      entry === null ||
      entry.status !== status ||
      (status === STATUS_VALUE ? !c.isEqual(entry.value, value) : entry.payload !== payload);
  } catch (compareError) {
    // A throwing user isEqual must not leave the node clean-with-stale-value:
    // surface the error to this read AND stay dirty so the next read retries.
    status = STATUS_ERROR;
    payload = compareError;
    value = undefined;
    c.flags |= dirtyBit(plane);
    changed = true;
  }
  if (entry === null) {
    entry = { world, status, value, payload, gen: forkGen };
    c.results.push(entry);
    if (world === WORLD_COMMITTED) c.committed = entry;
  } else {
    entry.status = status;
    entry.value = value;
    entry.payload = payload;
    entry.gen = forkGen;
  }
  c.flags |= F.Mutable;
  if (status === STATUS_SUSPENDED) attachSettleListener(c, payload as InstrumentedThenable, plane);
  if (cycleError !== null) throw cycleError;
  return changed;
}

/**
 * The trust rule for HEAD results: a HEAD entry is valid only within the fork
 * generation that produced it. When missing or stale (`head` is the caller's
 * already-located entry), seed from the COMMITTED entry iff that entry
 * predates this fork — a COMMITTED result computed DURING the fork excludes
 * the fork's deferred writes and must not stand in for head state. Returns
 * null when there is no trustworthy seed (caller evaluates fresh).
 */
function ensureHeadResult(c: ComputedNode, head: ComputedResult | null): ComputedResult | null {
  const committed = findResult(c, WORLD_COMMITTED);
  if (committed !== null && committed.gen !== forkGen) {
    if (head === null) {
      head = {
        world: WORLD_HEAD,
        status: committed.status,
        value: committed.value,
        payload: committed.payload,
        gen: forkGen,
      };
      c.results.push(head);
    } else {
      head.status = committed.status;
      head.value = committed.value;
      head.payload = committed.payload;
      head.gen = forkGen;
    }
    return head;
  }
  return null;
}

/**
 * When a computed suspends, arrange for the graph to notice the thenable
 * settling: mark the computed dirty and re-propagate so effect watchers
 * re-run. Subscriptions are not marked — for renders, React's own ping (via
 * use()) re-renders the components that suspended.
 */
function attachSettleListener(c: ComputedNode, thenable: InstrumentedThenable, plane: Plane): void {
  if (c.settleAttached === thenable) return;
  c.settleAttached = thenable;
  const onSettle = (): void => {
    if (c.settleAttached !== thenable) return;
    c.settleAttached = null;
    const entry = findResult(c, planeWorld(plane));
    if (entry === null || entry.status !== STATUS_SUSPENDED || entry.payload !== thenable) return;
    if (tracer !== null) tracer.emit('settle', currentCause, c);
    c.flags |= plane === PLANE_HEAD && forkCount > 0 ? F.HeadDirty : F.Dirty;
    if (c.subs !== undefined) {
      const prevMuted = mutedSubscriptions;
      mutedSubscriptions = true;
      try {
        propagate(c.subs, effectivePlanes(plane), undefined);
      } finally {
        mutedSubscriptions = prevMuted;
      }
      deliverNotifications();
    }
  };
  thenable.then(onSettle, onSettle);
}

// ---------------------------------------------------------------------------
// ctx.use — suspense inside computeds
// ---------------------------------------------------------------------------

function useThenable(thenable: InstrumentedThenable): unknown {
  const index = evalThenableIndex++;
  const cache = evalThenables!;
  const prev = cache[index] as InstrumentedThenable | undefined;
  let t = thenable;
  if (prev !== undefined && prev !== thenable && prev.status === 'pending') {
    // Idempotence rule (mirrors React's trackUsedThenable): while the
    // previous thenable at this slot is pending, a new thenable produced by
    // re-evaluation is assumed to be a re-creation of the same work.
    t = prev;
    thenable.then(noop, noop); // silence unhandled rejection of the dropped one
  }
  cache[index] = t;
  switch (t.status) {
    case 'fulfilled':
      return t.value;
    case 'rejected':
      throw t.reason;
    case 'pending':
      throw new SuspendedRead(t);
    default: {
      t.status = 'pending';
      t.then(
        (v: unknown) => {
          if (t.status === 'pending') {
            t.status = 'fulfilled';
            t.value = v;
          }
        },
        (e: unknown) => {
          if (t.status === 'pending') {
            t.status = 'rejected';
            t.reason = e;
          }
        },
      );
      if (tracer !== null) tracer.emit('suspend', currentCause, undefined, { thenable: t });
      throw new SuspendedRead(t);
    }
  }
}

export type ComputedCtx = {
  use<V>(thenable: PromiseLike<V>): V;
};

const computedCtx: ComputedCtx = {
  use<V>(thenable: PromiseLike<V>): V {
    if (evalThenables === null) {
      throw new Error('ctx.use may only be called during a computed evaluation.');
    }
    return useThenable(thenable as InstrumentedThenable) as V;
  },
};

// ---------------------------------------------------------------------------
// The single value-derivation function
// ---------------------------------------------------------------------------

/**
 * THE definition of an atom's value in a world: starting from the value
 * before the retained log, apply — in write order — every entry the filter
 * admits. The memoized views, render reads, retirement, and sweeping are all
 * defined in terms of this function.
 */
function replayLog(atom: AtomNode, includes: (e: WriteEntry) => boolean): unknown {
  let value = atom.preLogValue;
  const log = atom.log;
  if (log !== null) {
    for (let i = 0; i < log.length; i++) {
      const e = log[i]!;
      if (includes(e)) {
        value = e.apply !== null ? e.apply(value) : e.value;
      }
    }
  }
  return value;
}

const includesCommitted = (e: WriteEntry): boolean => e.retiredAtSeq !== 0 || !e.batch.deferred;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function readAtom(atom: AtomNode): unknown {
  const sub = activeSub;
  if (sub !== undefined) {
    if ((sub.flags & F.RecursedCheck) !== 0) {
      link(atom, sub, effectivePlanes(activePlane));
    }
    if (activePlane === PLANE_HEAD && forkCount > 0) return atom.headLatest;
    return committedAtomValue(atom);
  }
  const world = ambientWorld;
  if (world !== null) return resolveAtomInWorld(atom, world);
  // Untracked read outside render: latest-write ("head") semantics.
  checkUntrackedRenderRead(atom);
  const value = forkCount > 0 ? atom.headLatest : committedAtomValue(atom);
  deliverNotifications(); // a lazy pull may have promoted watchers
  return value;
}

function committedAtomValue(atom: AtomNode): unknown {
  if ((atom.flags & F.Dirty) !== 0) {
    if (updateAtom(atom)) shallowPropagate(atom.subs, PLANE_COMMITTED);
  }
  return atom.committedValue;
}

function resolveAtomInWorld(atom: AtomNode, world: RenderWorld): unknown {
  const log = atom.log;
  if (log === null || log.length === 0) return committedAtomValue(atom);
  return replayLog(
    atom,
    (e) =>
      (e.retiredAtSeq !== 0 && e.retiredAtSeq <= world.maxSeq) ||
      (e.seq <= world.maxSeq && worldIncludesBatch(world, e.batch)),
  );
}

/**
 * Reads a computed: validates/evaluates in the appropriate plane, links it to
 * the active evaluation, and unwraps the result (throwing stored errors, or
 * SuspendedRead for suspensions).
 */
export function readComputed(c: ComputedNode): unknown {
  if ((c.flags & F.RecursedCheck) !== 0) {
    throw new CycleError('Computed read during its own evaluation (dependency cycle).');
  }
  const sub = activeSub;
  if (sub === undefined) {
    const world = ambientWorld;
    if (world !== null) return resolveComputedInWorld(c, world);
    checkUntrackedRenderRead(c);
  }
  // Inside a tracked evaluation, stay in that evaluation's plane; untracked
  // non-render reads get latest-write ("head") semantics, matching atoms.
  const plane: Plane =
    forkCount === 0 ? PLANE_COMMITTED : sub !== undefined ? activePlane : PLANE_HEAD;
  // pullComputed always returns the current entry: re-evaluation mutates the
  // cached entry object in place.
  const entry = pullComputed(c, plane);
  if (sub !== undefined && (sub.flags & F.RecursedCheck) !== 0) {
    link(c, sub, effectivePlanes(plane));
  }
  if (sub === undefined) deliverNotifications(); // lazy pulls may promote watchers
  return unwrapEntry(entry);
}

function unwrapEntry(entry: ComputedResult): unknown {
  if (entry.status === STATUS_VALUE) return entry.value;
  if (entry.status === STATUS_ERROR) throw entry.payload;
  throw new SuspendedRead(entry.payload as PromiseLike<unknown>);
}

/** Brings the computed's `plane` result up to date; returns the entry. */
function pullComputed(c: ComputedNode, plane: Plane): ComputedResult {
  const dBit = dirtyBit(plane);
  const pBit = pendingBit(plane);
  const world = planeWorld(plane);
  let entry = findResult(c, world);
  if (world === WORLD_HEAD && (entry === null || entry.gen !== forkGen)) {
    entry = ensureHeadResult(c, entry);
    if (entry === null) {
      updateComputed(c, plane); // no trustworthy seed: evaluate fresh
      return findResult(c, world)!;
    }
  } else if (entry === null) {
    updateComputed(c, plane); // first-ever evaluation
    return findResult(c, world)!;
  }
  const flags = c.flags;
  if ((flags & dBit) !== 0) {
    if (updateComputed(c, plane)) shallowPropagate(c.subs, plane);
  } else if ((flags & pBit) !== 0) {
    if (c.deps !== undefined && checkDirty(c.deps, c, plane)) {
      if (updateComputed(c, plane)) shallowPropagate(c.subs, plane);
    } else {
      c.flags &= ~(forkCount > 0 ? pBit : F.Pending | F.HeadPending);
    }
  } else if (entry.status === STATUS_SUSPENDED) {
    // Clean — but suspended results self-heal once their thenable settles.
    const payload = entry.payload as InstrumentedThenable | undefined;
    if (payload !== undefined && payload.status !== undefined && payload.status !== 'pending') {
      updateComputed(c, plane);
    }
  }
  return entry;
}

/**
 * Resolves a computed inside a render pass. Fast path: when nothing changed
 * since the pass pinned and no pending entry is excluded by the pass's
 * batches, a live view already holds the right answer (and stays valid for
 * the whole pass). Slow path: a pure, per-pass-cached evaluation against the
 * pinned world — never re-validated, because the pinned world is immutable.
 */
function resolveComputedInWorld(c: ComputedNode, world: RenderWorld): unknown {
  // Only computeds already participating in the graph may take the linking
  // fast path: render-only reads of never-watched computeds (e.g. a
  // useComputed node in a render React later discards) must not leave
  // subscriber links behind. They use the pure path; the node links when its
  // component commits and subscribes.
  const participates = c.watched > 0 || c.subs !== undefined || c.deps !== undefined;
  if (participates) {
    if (worldSeesDeferred(world)) {
      if (headChangeSeq <= world.maxSeq && pendingEntriesAllIncluded(world, true)) {
        return readInPlane(c, forkCount > 0 ? PLANE_HEAD : PLANE_COMMITTED);
      }
    } else if (committedChangeSeq <= world.maxSeq && pendingEntriesAllIncluded(world, false)) {
      // COMMITTED (retired + immediate write-throughs) is exactly this world.
      return readInPlane(c, PLANE_COMMITTED);
    }
  }
  const cached = findResult(c, world);
  if (cached !== null) return unwrapEntry(cached);
  if ((c.flags & F.RecursedCheck) !== 0) {
    throw new CycleError('Computed read during its own evaluation (dependency cycle).');
  }
  let status = STATUS_VALUE;
  let value: unknown = undefined;
  let payload: unknown = undefined;
  const prevThenables = evalThenables;
  const prevIndex = evalThenableIndex;
  if (c.thenables === null) c.thenables = [];
  evalThenables = c.thenables;
  evalThenableIndex = 0;
  c.flags |= F.RecursedCheck;
  ++evalDepth;
  try {
    // Reads inside resolve via ambientWorld (still set); nested computeds
    // recurse through resolveComputedInWorld and share the pass cache.
    value = c.fn(computedCtx);
  } catch (e) {
    if (e instanceof SuspendedRead) {
      status = STATUS_SUSPENDED;
      payload = e.thenable;
    } else {
      status = STATUS_ERROR;
      payload = e;
    }
  } finally {
    c.flags &= ~F.RecursedCheck;
    --evalDepth;
    evalThenables = prevThenables;
    evalThenableIndex = prevIndex;
  }
  let hadPassEntry = false;
  const results = c.results;
  for (let i = 0; i < results.length; i++) {
    if (isPassWorld(results[i]!.world)) {
      hadPassEntry = true;
      break;
    }
  }
  if (!hadPassEntry) passCachedNodes.push(c);
  const entry: ComputedResult = { world, status, value, payload, gen: forkGen };
  results.push(entry);
  if (tracer !== null) tracer.emit('render-read', currentCause, c, { pinned: true, status });
  return unwrapEntry(entry);
}

function readInPlane(c: ComputedNode, plane: Plane): unknown {
  const prevWorld = setAmbientWorld(null);
  const prevPlane = activePlane;
  activePlane = plane;
  try {
    return unwrapEntry(pullComputed(c, plane));
  } finally {
    activePlane = prevPlane;
    setAmbientWorld(prevWorld);
  }
}

/**
 * Plane-explicit untracked read, for the React bindings' post-subscribe
 * fixups: "what would an urgent render (COMMITTED) / the pending world
 * (HEAD) show right now?".
 */
export function peekNodeValue(node: Node, plane: Plane): unknown {
  const requested: Plane = forkCount > 0 ? plane : PLANE_COMMITTED;
  try {
    if (node.kind === KIND_ATOM) {
      return requested === PLANE_HEAD
        ? (node as AtomNode).headLatest
        : committedAtomValue(node as AtomNode);
    }
    return readInPlane(node as ComputedNode, requested);
  } finally {
    // Lazy pulls above may have promoted watchers; don't leave them queued.
    deliverNotifications();
  }
}

function worldSeesDeferred(world: RenderWorld): boolean {
  if (forkCount === 0) return false;
  if (world.seesDeferred !== null) return world.seesDeferred;
  let sees = false;
  outer: for (const atom of loggedAtoms) {
    const log = atom.log;
    if (log === null) continue;
    for (let i = 0; i < log.length; i++) {
      const e = log[i]!;
      if (e.retiredAtSeq === 0 && e.batch.deferred && worldIncludesBatch(world, e.batch)) {
        sees = true;
        break outer;
      }
    }
  }
  world.seesDeferred = sees;
  return sees;
}

/**
 * Is every pending write's batch included in the world? When
 * `includeDeferred` is false, pending deferred entries are ignored (they are
 * absent from the COMMITTED view by construction, and the caller already
 * knows the world excludes them).
 */
function pendingEntriesAllIncluded(world: RenderWorld, includeDeferred: boolean): boolean {
  for (const atom of loggedAtoms) {
    const log = atom.log;
    if (log === null) continue;
    for (let i = 0; i < log.length; i++) {
      const e = log[i]!;
      if (e.retiredAtSeq !== 0) continue;
      if (!includeDeferred && e.batch.deferred) continue;
      if (!worldIncludesBatch(world, e.batch)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Replaces the atom's value. */
export function writeAtom(atom: AtomNode, value: unknown): void {
  writeAtomImpl(atom, value, null);
}

/**
 * Functional update (atom.update / ReducerAtom.dispatch): `apply` is stored
 * in the write log and REPLAYED per world, giving React useState/useReducer
 * rebasing semantics. It must be pure.
 */
export function applyAtom(atom: AtomNode, apply: (prev: unknown) => unknown): void {
  writeAtomImpl(atom, undefined, apply);
}

function writeAtomImpl(
  atom: AtomNode,
  value: unknown,
  apply: ((prev: unknown) => unknown) | null,
): void {
  if (
    config.forbidWritesInComputeds &&
    activeSub !== undefined &&
    activeSub.kind === KIND_COMPUTED &&
    (activeSub.flags & F.RecursedCheck) !== 0
  ) {
    throw new Error(
      'Writing to an atom inside a computed is forbidden (forbidWritesInComputeds).',
    );
  }
  const batch = writeBatchProvider !== null ? writeBatchProvider() : null;
  const cause =
    tracer !== null ? setCurrentCause(tracer.emit('atom-write', currentCause, atom)) : 0;
  try {
    const cycleGuard =
      activeSub !== undefined &&
      activeSub.kind === KIND_COMPUTED &&
      (activeSub.flags & F.RecursedCheck) !== 0
        ? activeSub
        : undefined;

    if (batch !== null && batch.deferred) {
      // Deferred write: log it and advance HEAD only. Updaters evaluate here
      // against the head value — their position in head history — and are
      // replayed for other worlds.
      appendLog(atom, value, apply, batch);
      if (forkCount === 0) ++forkGen;
      ++forkCount;
      const headNext = apply !== null ? apply(atom.headLatest) : value;
      if (!atom.isEqual(atom.headLatest, headNext)) {
        atom.headLatest = headNext;
        atom.flags |= F.HeadDirty;
        headChangeSeq = writeSeq;
        if (atom.subs !== undefined) {
          propagate(atom.subs, PLANE_HEAD, cycleGuard);
        }
      }
      deliverNotifications();
      return;
    }

    // The observability gate: an immediate write's log entry only matters if
    // some observer could distinguish worlds — while forked, or while a
    // render pass is pinned. A plain event-handler set() allocates nothing.
    if (batch !== null && (forkCount > 0 || activePins.length > 0)) {
      appendLog(atom, value, apply, batch);
    } else {
      ++writeSeq;
    }

    // Immediate/plain write: write-through on COMMITTED (and HEAD, since
    // immediate writes are chronologically part of the head world too). For
    // updaters the two views evaluate independently against their own
    // previous values — that IS the rebase.
    let mask = 0;
    const committedNext = apply !== null ? apply(atom.committedLatest) : value;
    if (!atom.isEqual(atom.committedLatest, committedNext)) {
      atom.committedLatest = committedNext;
      atom.flags |= F.Dirty;
      mask |= PLANE_COMMITTED;
      committedChangeSeq = writeSeq;
      headChangeSeq = writeSeq;
    }
    if (forkCount > 0) {
      const headNext = apply !== null ? apply(atom.headLatest) : value;
      if (!atom.isEqual(atom.headLatest, headNext)) {
        atom.headLatest = headNext;
        atom.flags |= F.HeadDirty;
        mask |= PLANE_HEAD;
        headChangeSeq = writeSeq;
      }
    } else {
      atom.headLatest = atom.committedLatest;
    }
    if (mask !== 0 && atom.subs !== undefined) {
      propagate(atom.subs, effectivePlanes(mask), cycleGuard);
    }
    deliverNotifications();
  } finally {
    if (tracer !== null) setCurrentCause(cause);
  }
}

function appendLog(
  atom: AtomNode,
  value: unknown,
  apply: ((prev: unknown) => unknown) | null,
  batch: BatchRef,
): void {
  if (atom.log === null || atom.log.length === 0) {
    atom.preLogValue = committedAtomValue(atom);
    if (atom.log === null) atom.log = [];
    loggedAtoms.add(atom);
  }
  atom.log.push({ value, apply, batch, seq: ++writeSeq, retiredAtSeq: 0 });
}

// ---------------------------------------------------------------------------
// Retirement: a batch commits (or dies); its writes join committed state
// ---------------------------------------------------------------------------

/**
 * Retires a batch: stamps its entries and recomputes each affected atom's
 * COMMITTED view by replay — which rebases pending immediate updaters on top
 * of the retired writes and makes rollback structurally impossible. Driven
 * by the patch's onBatchRetired (exactly once per token). Uncommitted
 * retirements (batches that never produced React work) retire the same way:
 * the store is global; head state must converge on what was written.
 *
 * Retirement-propagation re-runs effect watchers (their committed world
 * changed) but mutes subscriptions — components were notified in the
 * writer's context and have either rendered these values or have the render
 * queued. When called from inside React's commit, `deferEffectFlush` lets
 * the caller flush effects in a microtask instead; nothing else is held
 * open, so post-commit synchronous writes keep their own delivery context.
 */
export function retireBatch(batch: BatchRef, deferEffectFlush = false): void {
  if (loggedAtoms.size === 0) return;
  const cause = tracer !== null ? setCurrentCause(tracer.emit('retire', currentCause)) : 0;
  const prevMuted = mutedSubscriptions;
  mutedSubscriptions = true;
  ++batchDepth;
  try {
    const retiredStamp = ++writeSeq;
    for (const atom of loggedAtoms) {
      const log = atom.log;
      if (log === null) continue;
      let any = false;
      for (let i = 0; i < log.length; i++) {
        const e = log[i]!;
        if (e.retiredAtSeq === 0 && e.batch === batch) {
          e.retiredAtSeq = retiredStamp;
          if (e.batch.deferred) --forkCount;
          any = true;
        }
      }
      if (any) {
        const next = replayLog(atom, includesCommitted);
        if (!atom.isEqual(atom.committedLatest, next)) {
          atom.committedLatest = next;
          atom.flags |= F.Dirty;
          committedChangeSeq = ++writeSeq;
          headChangeSeq = writeSeq;
          if (atom.subs !== undefined) propagate(atom.subs, PLANE_COMMITTED, undefined);
        }
      }
    }
    sweepLogs();
  } finally {
    --batchDepth;
    mutedSubscriptions = prevMuted;
    if (tracer !== null) setCurrentCause(cause);
  }
  if (!deferEffectFlush) deliverNotifications();
}

/**
 * Drops retired log entries no active render pass can still need. A pinned
 * pass may still need the value *before* a retired entry, so the sweep bound
 * is the retirement ticket, not the write ticket.
 */
function sweepLogs(): void {
  if (loggedAtoms.size === 0) return;
  let bound = Infinity;
  for (let i = 0; i < activePins.length; i++) {
    if (activePins[i]! < bound) bound = activePins[i]!;
  }
  for (const atom of loggedAtoms) {
    const log = atom.log;
    if (log === null) {
      loggedAtoms.delete(atom);
      continue;
    }
    let keepFrom = 0;
    while (keepFrom < log.length) {
      const e = log[keepFrom]!;
      if (e.retiredAtSeq !== 0 && e.retiredAtSeq <= bound) {
        // Collapse into the replay base, replaying updaters so the collapsed
        // prefix equals what any world would have computed.
        atom.preLogValue = e.apply !== null ? e.apply(atom.preLogValue) : e.value;
        keepFrom++;
      } else {
        break;
      }
    }
    if (keepFrom > 0) log.splice(0, keepFrom);
    if (log.length === 0) {
      atom.log = null;
      loggedAtoms.delete(atom);
    }
  }
}

/** True while any unretired deferred write exists. Exposed for tests. */
export function isForked(): boolean {
  return forkCount > 0;
}

export function currentWriteSeq(): number {
  return writeSeq;
}

// ---------------------------------------------------------------------------
// Effects: queue + flush
// ---------------------------------------------------------------------------

export function startBatch(): void {
  ++batchDepth;
}

export function endBatch(): void {
  if (--batchDepth === 0) deliverNotifications();
}

export function flushEffects(): void {
  while (effectQueueIndex < effectQueueLength) {
    const w = queuedEffects[effectQueueIndex]!;
    queuedEffects[effectQueueIndex++] = undefined;
    try {
      runQueuedWatcher(w);
    } catch (e) {
      // Restore the rest of the queue so one throwing effect doesn't starve
      // the others (they re-queue on the next propagate via Recursed).
      for (let i = effectQueueIndex; i < effectQueueLength; i++) {
        const rest = queuedEffects[i];
        if (rest !== undefined) {
          rest.flags |= F.Watching | F.Recursed;
          queuedEffects[i] = undefined;
        }
      }
      effectQueueIndex = 0;
      effectQueueLength = 0;
      throw e;
    }
  }
  effectQueueIndex = 0;
  effectQueueLength = 0;
  // Effect runs may have queued subscription confirmations via lazy pulls.
  if (subQueueIndex < subQueueLength) drainSubscriptions();
}

function runQueuedWatcher(w: WatcherNode): void {
  const flags = w.flags;
  if (flags === F.None) return; // disposed while queued
  const dirty =
    (flags & F.Dirty) !== 0 ||
    ((flags & F.Pending) !== 0 &&
      w.deps !== undefined &&
      checkDirty(w.deps, w, PLANE_COMMITTED));
  if (!dirty || w.flags === F.None) {
    // (w.flags check: the dirtiness pull's side effects may have disposed us.)
    if (w.flags !== F.None) {
      w.flags = (w.flags & ~(F.Recursed | ALL_PLANE_BITS)) | F.Watching;
    }
    return;
  }
  runEffect(w);
}

/** Runs an effect watcher: cleanup, then a fresh tracked run of fn. */
export function runEffect(w: WatcherNode): void {
  if (w.flags === F.None) return; // disposed
  const cleanup = w.cleanup;
  w.cleanup = null;
  if (cleanup !== null) {
    untracked(cleanup);
    if (w.flags === F.None) return; // cleanup disposed the watcher
  }
  const frame = startTracking(w, PLANE_COMMITTED);
  w.flags |= F.Watching;
  ++evalDepth;
  const cause = tracer !== null ? setCurrentCause(tracer.emit('effect-run', currentCause, w)) : 0;
  try {
    const result = w.fn!();
    if (typeof result === 'function') w.cleanup = result;
  } finally {
    --evalDepth;
    endTracking(w, frame, PLANE_COMMITTED);
    if (tracer !== null) setCurrentCause(cause);
  }
}

// ---------------------------------------------------------------------------
// Watcher lifecycle (used by api.ts and the React bindings)
// ---------------------------------------------------------------------------

export function createWatcher(
  watcherKind: number,
  fn: (() => void | (() => void)) | null,
  onChange: ((plane: Plane) => void) | null,
): WatcherNode {
  return {
    kind: KIND_WATCHER,
    flags: F.Watching,
    watched: 0,
    deps: undefined,
    depsTail: undefined,
    subs: undefined,
    subsTail: undefined,
    watcherKind,
    fn,
    cleanup: null,
    onChange,
    queuedPlanes: 0,
  };
}

/**
 * Subscribes a SUBSCRIPTION watcher to exactly one node. Ensures the target
 * has evaluated (so computed→dep links exist), then links watcher→target in
 * both planes. The read result is intentionally discarded; read sites handle
 * values/errors/suspensions.
 */
export function subscribeTo(w: WatcherNode, target: Node): void {
  if (target.kind === KIND_COMPUTED) {
    try {
      untracked(() => readComputed(target as ComputedNode));
    } catch {
      // Error and suspended results still leave the computed evaluated/linked.
    }
  }
  ++trackVersion;
  link(target, w, PLANE_BOTH);
}

export function disposeWatcher(w: WatcherNode): void {
  let l = w.deps;
  while (l !== undefined) {
    l = unlink(l, w);
  }
  const cleanup = w.cleanup;
  w.cleanup = null;
  w.flags = F.None;
  w.queuedPlanes = 0;
  if (cleanup !== null) untracked(cleanup);
}

// ---------------------------------------------------------------------------
// Node constructors (api.ts wraps these in the public classes)
// ---------------------------------------------------------------------------

export function createAtomNode(
  initial: unknown,
  isEqual: ((a: unknown, b: unknown) => boolean) | undefined,
  lifecycle: unknown,
  label?: string,
): AtomNode {
  return {
    kind: KIND_ATOM,
    flags: F.Mutable,
    watched: 0,
    deps: undefined,
    depsTail: undefined,
    subs: undefined,
    subsTail: undefined,
    label: label ?? null,
    committedValue: initial,
    committedLatest: initial,
    headLatest: initial,
    preLogValue: initial,
    log: null,
    isEqual: isEqual ?? Object.is,
    lifecycle: lifecycle ?? null,
  };
}

export function createComputedNode(
  fn: (ctx: unknown) => unknown,
  isEqual: ((a: unknown, b: unknown) => boolean) | undefined,
  label?: string,
): ComputedNode {
  return {
    kind: KIND_COMPUTED,
    flags: F.None,
    watched: 0,
    deps: undefined,
    depsTail: undefined,
    subs: undefined,
    subsTail: undefined,
    label: label ?? null,
    results: [],
    committed: null,
    fn,
    isEqual: isEqual ?? Object.is,
    thenables: null,
    settleAttached: null,
  };
}
