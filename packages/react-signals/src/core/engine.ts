/**
 * The reactive engine: dependency graph, invalidation, evaluation, and the
 * two-plane world model that makes signals safe under concurrent React.
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
 * ## Planes (worlds)
 *
 * In steady state there is one plane: every node has one value, one set of
 * dirty flags, and reads/writes behave exactly like a classic signals library.
 *
 * While *uncommitted transition writes* exist, the engine is "forked" into two
 * planes:
 *
 * - BASE: committed state plus pending urgent (sync-priority) writes. This is
 *   what urgent React renders and effects observe.
 * - HEAD: all writes, including pending transitions. This is what transition
 *   renders and non-render reads observe.
 *
 * Each `Link` carries plane-membership bits because a computed's *dependency
 * set* can differ between planes (`a.state > 1 ? 0 : b.state`). Each node
 * carries per-plane dirty flags; outside forked mode every flag operation
 * treats the two planes as one. When the pending transition writes fold into
 * committed state (a React commit), the planes reconverge. Pure-core users
 * (and benchmarks) never fork.
 *
 * A render pass must not observe writes that landed — or folds that happened —
 * after it started. Atoms keep a small ordered write log while React bindings
 * are active; each entry records its write order (`seq`) and, once committed,
 * its fold order (`foldedAtSeq`). A pass pinned at `maxSeq` resolves an atom
 * to the newest entry that either folded before the pass started
 * (`foldedAtSeq <= maxSeq`) or is carried by a lane the pass includes
 * (`lane ∈ pass.lanes && seq <= maxSeq`). DESIGN.md §2 argues this reproduces
 * React's own hook-update-queue semantics.
 *
 * ## Notification protocol (the load-bearing ordering rule)
 *
 * A write proceeds in strict phases:
 *   1. propagate() marks every reachable subscriber Pending and *queues*
 *      watchers. It never reads, computes, or runs user code.
 *   2. Subscriptions drain: each queued subscription confirms its change with
 *      a pull (equality cut-off, diamonds converge) and, if real, fires
 *      onChange — still synchronously inside the writer's context, which is
 *      what lets React assign the writer's lane to whatever onChange schedules.
 *   3. Effects flush (unless batched): each queued effect re-validates and
 *      re-runs.
 * Confirming *during* propagation is unsound — the first subscriber's pull
 * consumes the source's dirty bit before later subscribers are marked — so
 * notifyWatcher only ever queues.
 *
 * ## Watchedness
 *
 * A node is "watched" when some watcher transitively depends on it;
 * watched-ness propagates as a refcount along dependency links. An atom's
 * 0↔1 transitions drive its `effect` lifecycle option. Unwatched computeds
 * still keep links — push-based invalidation is what makes lazy pulls cheap.
 *
 * ## Other invariants
 *
 * - Evaluation never throws through the graph: a computed's result is a
 *   value, an error, or a suspension, stored as a status; read *sites*
 *   rethrow/suspend (SuspendedRead). A dependency's suspension read during
 *   evaluation re-suspends the reader (same thenable).
 * - Only one tracked evaluation runs at a time (single thread, no yielding
 *   inside an evaluation), so a single RecursedCheck bit serves both planes.
 * - BASE values change only via urgent writes and folds; HEAD values change
 *   on every write. Render passes read via their pinned world, so neither
 *   kind of change can tear a yielded render.
 */

import { tracer, currentCause, setCurrentCause } from './tracing.ts';

// ---------------------------------------------------------------------------
// Flags, planes, node kinds
// ---------------------------------------------------------------------------

export const PLANE_BASE = 1;
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
  /** BASE plane: definitely stale. */
  Dirty: 1 << 4,
  /** BASE plane: possibly stale; resolve via checkDirty. */
  Pending: 1 << 5,
  /** HEAD plane (forked mode only): definitely stale. */
  HeadDirty: 1 << 6,
  /** HEAD plane (forked mode only): possibly stale. */
  HeadPending: 1 << 7,
} as const;

function dirtyBit(plane: Plane): number {
  return plane === PLANE_BASE ? F.Dirty : F.HeadDirty;
}
function pendingBit(plane: Plane): number {
  return plane === PLANE_BASE ? F.Pending : F.HeadPending;
}
const ALL_PLANE_BITS = F.Dirty | F.Pending | F.HeadDirty | F.HeadPending;

/**
 * The bits to clear when a pull validates/refreshes `plane`. Outside forked
 * mode the planes are one; leaving the other plane's bits set would let a
 * later propagate wrongly prune ("already marked") — stale HeadPending from
 * steady mode was a confirmed missed-update bug.
 */
function clearBits(plane: Plane): number {
  return forkCount > 0 ? dirtyBit(plane) | pendingBit(plane) : ALL_PLANE_BITS;
}

export const KIND_ATOM = 0;
export const KIND_COMPUTED = 1;
export const KIND_WATCHER = 2;

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

export type WriteEntry = {
  value: unknown;
  /** Opaque React lane the write's broadcasts were scheduled at. */
  lane: number;
  /** Global write sequence number. */
  seq: number;
  /** 0 while pending; the fold-time sequence once committed. */
  foldedAtSeq: number;
  /** True for transition-priority writes (they fork the planes). */
  transition: boolean;
};

export type AtomNode = Node & {
  /** BASE-plane value as of the last pull (alien-signals `currentValue`). */
  value: unknown;
  /** BASE-plane latest write, committed to `value` lazily on pull. */
  buffered: unknown;
  /** seq of the write currently reflected in `buffered`. Folds must never
   * roll BASE back past this. */
  baseSeq: number;
  /** HEAD-plane value (kept in sync with the latest write, eagerly). */
  headValue: unknown;
  /** Value before the oldest retained log entry (for pinned render passes). */
  preLogValue: unknown;
  log: WriteEntry[] | null;
  isEqual: (a: unknown, b: unknown) => boolean;
  /** Observed-lifecycle callback (Atom `effect` option), if configured. */
  lifecycle: unknown;
};

export const STATUS_VALUE = 0;
export const STATUS_ERROR = 1;
export const STATUS_SUSPENDED = 2;

export type ComputedNode = Node & {
  value: unknown;
  /** STATUS_* for the BASE-plane result. */
  status: number;
  /** Error (STATUS_ERROR) or thenable (STATUS_SUSPENDED) for BASE plane. */
  payload: unknown;
  headValue: unknown;
  headStatus: number;
  headPayload: unknown;
  /** Fork generation the head mirror was last synced in; see seedHead. */
  headGen: number;
  /** Fork generation of the last BASE evaluation made *while forked*. A BASE
   * result computed during the current fork excludes its transition writes
   * and must not seed the head mirror. */
  baseGen: number;
  /** PLANE_* bits: which planes hold a real result for the current fork. */
  evaluated: number;
  fn: (ctx: unknown) => unknown;
  isEqual: (a: unknown, b: unknown) => boolean;
  /** Positional thenable cache for ctx.use across re-evaluations. */
  thenables: unknown[] | null;
  /** Thenable a settle-listener is attached to (dedupe marker). */
  settleAttached: unknown;
  /** Per-render-pass pure-evaluation cache: [world, value, status, payload]. */
  renderCache: [object, unknown, number, unknown] | null;
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
// Engine globals
// ---------------------------------------------------------------------------

let trackVersion = 0;
let activeSub: Node | undefined;
let activePlane: Plane = PLANE_BASE;
let batchDepth = 0;
let evalDepth = 0;

/** Number of unfolded transition writes; > 0 means the planes are forked. */
let forkCount = 0;
/** Bumped each time the engine enters forked mode; guards head-mirror reuse. */
let forkGen = 0;

let writeSeq = 0;
/** writeSeq at the last BASE-plane value change (urgent write or fold). */
let baseChangeSeq = 0;
/** writeSeq at the last value change in any plane. */
let headChangeSeq = 0;

/** Atoms with non-empty logs, for world reads and fold/GC sweeps. */
const loggedAtoms: Set<AtomNode> = new Set();

// Effect queue (flat array; the Watching bit doubles as "already queued").
const queuedEffects: (WatcherNode | undefined)[] = [];
let effectQueueLength = 0;
let effectQueueIndex = 0;

// Subscription queue: marked during propagate, confirmed+fired by
// drainSubscriptions after the wave completes (see the protocol note above).
const queuedSubscriptions: (WatcherNode | undefined)[] = [];
let subQueueLength = 0;
let subQueueIndex = 0;

/**
 * True while fold- or settle-driven propagation runs. Subscriptions are not
 * even marked during it: components already observed those values (they
 * rendered the pending world, or React's suspense ping re-renders them);
 * marking without confirming would permanently swallow later notifications.
 */
let mutedSubscriptions = false;

export type EngineConfig = {
  forbidWritesInComputeds: boolean;
};
export const config: EngineConfig = { forbidWritesInComputeds: false };

export type WriteLaneProvider = () => { lane: number; transition: boolean } | null;
let writeLaneProvider: WriteLaneProvider | null = null;
export function setWriteLaneProvider(p: WriteLaneProvider | null): void {
  writeLaneProvider = p;
}

/**
 * A render pass's pinned view of the world. Created by the React bindings at
 * pass start; object identity doubles as the render-cache key.
 */
export type RenderWorld = {
  /** Opaque render lanes. */
  lanes: number;
  /** Writes/folds after this sequence number are invisible to the pass. */
  maxSeq: number;
  laneIncluded: (lanes: number, lane: number) => boolean;
  /** Cached "does this world include pending transition writes"; lazy. */
  seesTransitions: boolean | null;
};

/** Ambient render world; set by the React bindings around render reads. */
let ambientWorld: RenderWorld | null = null;
export function setAmbientWorld(world: RenderWorld | null): RenderWorld | null {
  const prev = ambientWorld;
  ambientWorld = world;
  return prev;
}

// Active render passes pin log entries (and render caches) against GC.
const activePins: number[] = [];
let minActivePin = Infinity;
/** Computeds holding a renderCache; swept when the last pass unpins. */
const renderCachedNodes: ComputedNode[] = [];

export function pinRenderPass(maxSeq: number): void {
  activePins.push(maxSeq);
  if (maxSeq < minActivePin) minActivePin = maxSeq;
}
export function unpinRenderPass(maxSeq: number): void {
  const i = activePins.indexOf(maxSeq);
  if (i !== -1) activePins.splice(i, 1);
  minActivePin = activePins.length === 0 ? Infinity : Math.min(...activePins);
  if (activePins.length === 0) {
    for (const node of renderCachedNodes.splice(0)) node.renderCache = null;
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
 * Thrown by read sites when a computed's current result is a pending
 * thenable. React bindings catch it and suspend via React's `use()`; other
 * readers may await `thenable` and retry.
 */
export class SuspendedRead {
  thenable: PromiseLike<unknown>;
  constructor(thenable: PromiseLike<unknown>) {
    this.thenable = thenable;
  }
}

/** Internal control-flow signal thrown by ctx.use inside an evaluation. */
class SuspendSignal {
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
/** api.ts installs delivery for the Atom `effect` lifecycle option. */
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

/** Whether `sub`'s dependencies should count as watched. */
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
    // Last subscriber left: force a full recompute on next read and release
    // this computed's own dependencies (cascades up the chain).
    dep.flags = F.Mutable | F.Dirty | F.HeadDirty;
    (dep as ComputedNode).evaluated = 0;
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
  const clearMask = forkCount > 0 ? plane : PLANE_BOTH;
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
      const isMutedSubscription =
        mutedSubscriptions &&
        sub.kind === KIND_WATCHER &&
        (sub as WatcherNode).watcherKind === WATCHER_SUBSCRIPTION;
      if (!isMutedSubscription && sub !== cycleGuard) {
        const flags = sub.flags;
        const linkMask = l.planes & mask;
        const wantPending =
          ((linkMask & PLANE_BASE) !== 0 ? F.Pending : 0) |
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
    if (
      mutedSubscriptions &&
      sub.kind === KIND_WATCHER &&
      (sub as WatcherNode).watcherKind === WATCHER_SUBSCRIPTION
    ) {
      continue;
    }
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
 * Confirms and fires queued subscriptions, then flushes queued effects
 * (unless batched or mid-evaluation). Called after every propagation wave —
 * write sites, fold, settle, batch end, and after reads whose lazy pulls
 * promoted watchers.
 */
function deliverNotifications(): void {
  if (subQueueIndex < subQueueLength) drainSubscriptions();
  if (batchDepth === 0 && evalDepth === 0 && effectQueueIndex < effectQueueLength) {
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
    // change BASE while HEAD cuts off (or vice versa) — checking one plane
    // and clearing both would swallow the change.
    let firedPlane: Plane | 0 = 0;
    if (forkCount > 0 && (planes & PLANE_HEAD) !== 0 && confirmPlane(w, PLANE_HEAD)) {
      firedPlane = PLANE_HEAD;
    } else if ((planes & PLANE_BASE) !== 0 && confirmPlane(w, PLANE_BASE)) {
      firedPlane = PLANE_BASE;
    } else if (forkCount === 0 && (planes & PLANE_HEAD) !== 0 && confirmPlane(w, PLANE_BASE)) {
      // Steady mode: HEAD marks are BASE marks.
      firedPlane = PLANE_BASE;
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
// Pull phase: checkDirty + evaluation
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
          // Something already proved us dirty (e.g. a shallowPropagate fired
          // by an update we triggered earlier in this walk).
          dirty = true;
          break;
        }
        const dep = l.dep;
        const depFlags = dep.flags;
        if (dep.kind === KIND_ATOM) {
          // In HEAD, an uncommitted BASE write (F.Dirty from steady mode,
          // before the fork) also means the head value moved — head values
          // are written eagerly, so both bits imply "changed".
          const atomDirtyBits = plane === PLANE_BASE ? F.Dirty : F.HeadDirty | F.Dirty;
          if ((depFlags & atomDirtyBits) !== 0) {
            const changed = updateAtomForPlane(dep as AtomNode, plane);
            if (changed) {
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
 * Brings an atom's plane value up to date and reports whether it changed.
 * BASE: commits the buffered write (alien-signals' lazy commit). HEAD: values
 * are eager, so a dirty bit means "changed"; a pre-fork uncommitted BASE
 * write is committed here too (it is part of head history by definition).
 */
function updateAtomForPlane(atom: AtomNode, plane: Plane): boolean {
  if (plane === PLANE_HEAD) {
    let changed = (atom.flags & F.HeadDirty) !== 0;
    atom.flags &= ~F.HeadDirty;
    if ((atom.flags & F.Dirty) !== 0) {
      if (updateAtom(atom)) {
        // Cross-plane promotion: this HEAD walk consumed the BASE dirty bit,
        // so every BASE-Pending subscriber (including the very node pulling
        // us in HEAD) must be promoted now — no single-subscriber shortcut,
        // that optimization is only valid within one plane.
        shallowPropagate(atom.subs, PLANE_BASE);
        changed = true;
      }
    }
    return changed;
  }
  return updateAtom(atom);
}

/** Commits an atom's buffered write in BASE; returns "value changed". */
function updateAtom(atom: AtomNode): boolean {
  atom.flags &= ~F.Dirty;
  const prev = atom.value;
  const next = atom.buffered;
  if (atom.isEqual(prev, next)) return false;
  atom.value = next;
  return true;
}

// Positional thenable cache of the in-flight evaluation (ctx.use).
let evalThenableIndex = 0;
let evalThenables: unknown[] | null = null;

/**
 * Re-evaluates a computed in `plane`. Returns whether its observable result
 * (value, error, or suspension) changed. Never throws — except CycleError,
 * which is a programming error that must fail loudly at the offending site.
 */
function updateComputed(c: ComputedNode, plane: Plane): boolean {
  if (plane === PLANE_HEAD) seedHead(c);
  const frame = startTracking(c, plane);
  const prevThenables = evalThenables;
  const prevThenableIndex = evalThenableIndex;
  if (c.thenables === null) c.thenables = [];
  evalThenables = c.thenables;
  evalThenableIndex = 0;
  ++evalDepth;
  ++batchDepth; // defer effect flushes triggered by writes inside the getter
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
    if (e instanceof SuspendSignal) {
      status = STATUS_SUSPENDED;
      payload = e.thenable;
    } else if (e instanceof SuspendedRead) {
      // A dependency is suspended: this computed is suspended on the same
      // thenable (keeps payload identity stable for the equality cutoff).
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
  let changed: boolean;
  try {
    changed = commitComputedResult(c, plane, status, value, payload);
  } catch (compareError) {
    // A throwing user isEqual must not leave the node clean-with-stale-value:
    // surface the error to this read AND stay dirty so the next read retries.
    commitComputedResult(c, plane, STATUS_ERROR, undefined, compareError);
    c.flags |= dirtyBit(plane);
    changed = true;
  }
  if (status === STATUS_SUSPENDED) attachSettleListener(c, payload as InstrumentedThenable, plane);
  if (cycleError !== null) throw cycleError;
  return changed;
}

/**
 * Entering forked mode lazily: a computed's head mirror is only trustworthy
 * if it was synced during the current fork generation; otherwise seed it from
 * BASE (the state both planes shared before the fork). Dirtiness flags decide
 * whether the seed is then revalidated.
 */
function seedHead(c: ComputedNode): void {
  if (c.headGen !== forkGen) {
    c.headGen = forkGen;
    if ((c.evaluated & PLANE_BASE) !== 0 && c.baseGen !== forkGen) {
      // The BASE result predates this fork: it is exactly the state both
      // planes shared, and dirty flags cover anything written since.
      c.headValue = c.value;
      c.headStatus = c.status;
      c.headPayload = c.payload;
      c.evaluated |= PLANE_HEAD;
    } else {
      // BASE was (re)computed during this fork — it excludes the fork's
      // transition writes — or was never computed: evaluate HEAD fresh.
      c.evaluated &= ~PLANE_HEAD;
    }
  }
}

function commitComputedResult(
  c: ComputedNode,
  plane: Plane,
  status: number,
  value: unknown,
  payload: unknown,
): boolean {
  c.flags |= F.Mutable;
  if (plane === PLANE_HEAD && forkCount > 0) {
    const firstEval = (c.evaluated & PLANE_HEAD) === 0;
    const changed =
      firstEval ||
      c.headStatus !== status ||
      (status === STATUS_VALUE ? !c.isEqual(c.headValue, value) : c.headPayload !== payload);
    c.headStatus = status;
    c.headValue = value;
    c.headPayload = payload;
    c.headGen = forkGen;
    c.evaluated |= PLANE_HEAD;
    return changed;
  }
  const firstEval = (c.evaluated & PLANE_BASE) === 0;
  const changed =
    firstEval ||
    c.status !== status ||
    (status === STATUS_VALUE ? !c.isEqual(c.value, value) : c.payload !== payload);
  c.status = status;
  c.value = value;
  c.payload = payload;
  c.evaluated |= PLANE_BASE;
  if (forkCount > 0) c.baseGen = forkGen;
  if (forkCount === 0) {
    // Steady state: the planes are one; keep head mirrors in sync so the next
    // fork can seed cheaply.
    c.headStatus = status;
    c.headValue = value;
    c.headPayload = payload;
    c.headGen = forkGen;
    c.evaluated |= PLANE_HEAD;
  }
  return changed;
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
    const head = plane === PLANE_HEAD && forkCount > 0;
    const isCurrent =
      (head ? c.headStatus : c.status) === STATUS_SUSPENDED &&
      (head ? c.headPayload : c.payload) === thenable;
    if (!isCurrent) return;
    if (tracer !== null) tracer.emit('settle', currentCause, c);
    c.flags |= head ? F.HeadDirty : F.Dirty;
    if (c.subs !== undefined) {
      const prevMuted = mutedSubscriptions;
      mutedSubscriptions = true;
      try {
        propagate(c.subs, forkCount > 0 ? plane : PLANE_BOTH, undefined);
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
      throw new SuspendSignal(t);
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
      throw new SuspendSignal(t);
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
// Reads
// ---------------------------------------------------------------------------

export function readAtom(atom: AtomNode): unknown {
  const sub = activeSub;
  if (sub !== undefined) {
    if ((sub.flags & F.RecursedCheck) !== 0) {
      link(atom, sub, forkCount > 0 ? activePlane : PLANE_BOTH);
    }
    if (activePlane === PLANE_HEAD && forkCount > 0) return atom.headValue;
    return baseAtomValue(atom);
  }
  const world = ambientWorld;
  if (world !== null) return resolveAtomInWorld(atom, world);
  // Untracked read outside render: latest-write ("head") semantics.
  const value = forkCount > 0 ? atom.headValue : baseAtomValue(atom);
  deliverNotifications(); // a lazy commit may have promoted watchers
  return value;
}

function baseAtomValue(atom: AtomNode): unknown {
  if ((atom.flags & F.Dirty) !== 0) {
    if (updateAtom(atom)) shallowPropagate(atom.subs, PLANE_BASE);
  }
  return atom.value;
}

function resolveAtomInWorld(atom: AtomNode, world: RenderWorld): unknown {
  const log = atom.log;
  if (log === null || log.length === 0) return baseAtomValue(atom);
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    // An entry is visible if it folded before the pass pinned (fold-time
    // stamp!) or if the pass's lanes carry it and it existed at pin time.
    if (e.foldedAtSeq !== 0 && e.foldedAtSeq <= world.maxSeq) return e.value;
    if (e.seq <= world.maxSeq && world.laneIncluded(world.lanes, e.lane)) return e.value;
  }
  return atom.preLogValue;
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
  }
  // Inside a tracked evaluation, stay in that evaluation's plane; untracked
  // non-render reads get latest-write ("head") semantics, matching atoms.
  const plane: Plane =
    forkCount === 0 ? PLANE_BASE : sub !== undefined ? activePlane : PLANE_HEAD;
  pullComputed(c, plane);
  if (sub !== undefined && (sub.flags & F.RecursedCheck) !== 0) {
    link(c, sub, forkCount > 0 ? plane : PLANE_BOTH);
  }
  const result = unwrapResultOrThrow(c, plane, sub === undefined);
  return result;
}

function unwrapResultOrThrow(c: ComputedNode, plane: Plane, deliver: boolean): unknown {
  const head = plane === PLANE_HEAD && forkCount > 0;
  const status = head ? c.headStatus : c.status;
  if (deliver) deliverNotifications(); // lazy pulls may have promoted watchers
  if (status === STATUS_VALUE) return head ? c.headValue : c.value;
  if (status === STATUS_ERROR) throw head ? c.headPayload : c.payload;
  throw new SuspendedRead((head ? c.headPayload : c.payload) as PromiseLike<unknown>);
}

/** Brings the computed's `plane` result up to date (lazy pull). */
function pullComputed(c: ComputedNode, plane: Plane): void {
  const dBit = dirtyBit(plane);
  const pBit = pendingBit(plane);
  if (plane === PLANE_HEAD) seedHead(c);
  const flags = c.flags;
  const planeEvaluated =
    (c.evaluated & (plane === PLANE_HEAD && forkCount > 0 ? PLANE_HEAD : PLANE_BASE)) !== 0;
  if (!planeEvaluated) {
    updateComputed(c, plane); // first evaluation in this plane
    return;
  }
  if ((flags & dBit) !== 0) {
    if (updateComputed(c, plane)) shallowPropagate(c.subs, plane);
  } else if ((flags & pBit) !== 0) {
    if (c.deps !== undefined && checkDirty(c.deps, c, plane)) {
      if (updateComputed(c, plane)) shallowPropagate(c.subs, plane);
    } else {
      c.flags &= ~(forkCount > 0 ? pBit : F.Pending | F.HeadPending);
    }
  } else {
    // Clean — but suspended results self-heal once their thenable settles.
    const status = plane === PLANE_HEAD && forkCount > 0 ? c.headStatus : c.status;
    if (status === STATUS_SUSPENDED) {
      const payload = (plane === PLANE_HEAD && forkCount > 0 ? c.headPayload : c.payload) as
        | InstrumentedThenable
        | undefined;
      if (payload !== undefined && payload.status !== undefined && payload.status !== 'pending') {
        updateComputed(c, plane);
      }
    }
  }
}

/**
 * Resolves a computed inside a render pass. Fast path: when nothing changed
 * since the pass pinned, the live plane the pass corresponds to already holds
 * the right answer (and stays valid for the whole pass). Slow path: a pure,
 * per-pass-cached evaluation against the pinned world.
 */
function resolveComputedInWorld(c: ComputedNode, world: RenderWorld): unknown {
  // Only computeds already participating in the graph may take the linking
  // fast path: render-only reads of never-watched computeds (e.g. a
  // useComputed node in a render React later discards) must not leave
  // subscriber links behind. They use the pure path; the node links when its
  // component commits and subscribes.
  const participates = c.watched > 0 || c.subs !== undefined || c.deps !== undefined;
  if (participates) {
    // A live plane can stand in for the pass's world only if the plane holds
    // no unfolded write the pass's lanes exclude (a transition render must
    // not see a pending urgent write through HEAD, and vice versa).
    if (worldSeesTransitionWrites(world)) {
      if (headChangeSeq <= world.maxSeq && unfoldedEntriesAllIncluded(world, true)) {
        return readInPlane(c, forkCount > 0 ? PLANE_HEAD : PLANE_BASE);
      }
    } else if (baseChangeSeq <= world.maxSeq && unfoldedEntriesAllIncluded(world, false)) {
      // BASE (committed + urgent write-throughs) is exactly this world.
      return readInPlane(c, PLANE_BASE);
    }
  }
  const cached = c.renderCache;
  if (cached !== null && cached[0] === world) return unwrapCached(cached);
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
    if (e instanceof SuspendSignal || e instanceof SuspendedRead) {
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
  if (c.renderCache === null) renderCachedNodes.push(c);
  c.renderCache = [world, value, status, payload];
  if (tracer !== null) tracer.emit('render-read', currentCause, c, { pinned: true, status });
  return unwrapCached(c.renderCache);
}

function readInPlane(c: ComputedNode, plane: Plane): unknown {
  const prevWorld = setAmbientWorld(null);
  const prevPlane = activePlane;
  activePlane = plane;
  try {
    pullComputed(c, plane);
    return unwrapResultOrThrow(c, plane, false);
  } finally {
    activePlane = prevPlane;
    setAmbientWorld(prevWorld);
  }
}

function unwrapCached(cached: [object, unknown, number, unknown]): unknown {
  if (cached[2] === STATUS_VALUE) return cached[1];
  if (cached[2] === STATUS_ERROR) throw cached[3];
  throw new SuspendedRead(cached[3] as PromiseLike<unknown>);
}

/**
 * Plane-explicit untracked read, for the React bindings' post-subscribe
 * fixups: "what would an urgent render (BASE) / the pending world (HEAD)
 * show right now?". Throws errors/SuspendedRead like a normal read.
 */
export function peekNodeValue(node: Node, plane: Plane): unknown {
  const requested: Plane = forkCount > 0 ? plane : PLANE_BASE;
  if (node.kind === KIND_ATOM) {
    return requested === PLANE_HEAD
      ? (node as AtomNode).headValue
      : baseAtomValue(node as AtomNode);
  }
  return readInPlane(node as ComputedNode, requested);
}

function worldSeesTransitionWrites(world: RenderWorld): boolean {
  if (forkCount === 0) return false;
  if (world.seesTransitions !== null) return world.seesTransitions;
  let sees = false;
  outer: for (const atom of loggedAtoms) {
    const log = atom.log;
    if (log === null) continue;
    for (let i = 0; i < log.length; i++) {
      const e = log[i]!;
      if (e.foldedAtSeq === 0 && e.transition && world.laneIncluded(world.lanes, e.lane)) {
        sees = true;
        break outer;
      }
    }
  }
  world.seesTransitions = sees;
  return sees;
}

/**
 * Is every unfolded write's lane included in the world? When
 * `includeTransitions` is false, unfolded transition entries are ignored
 * (they are absent from BASE by construction, and the caller already knows
 * the world excludes them).
 */
function unfoldedEntriesAllIncluded(world: RenderWorld, includeTransitions: boolean): boolean {
  for (const atom of loggedAtoms) {
    const log = atom.log;
    if (log === null) continue;
    for (let i = 0; i < log.length; i++) {
      const e = log[i]!;
      if (e.foldedAtSeq !== 0) continue;
      if (!includeTransitions && e.transition) continue;
      if (!world.laneIncluded(world.lanes, e.lane)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function writeAtom(atom: AtomNode, value: unknown): void {
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
  const laneInfo = writeLaneProvider !== null ? writeLaneProvider() : null;
  const cause =
    tracer !== null ? setCurrentCause(tracer.emit('atom-write', currentCause, atom)) : 0;
  try {
    const cycleGuard =
      activeSub !== undefined &&
      activeSub.kind === KIND_COMPUTED &&
      (activeSub.flags & F.RecursedCheck) !== 0
        ? activeSub
        : undefined;

    if (laneInfo !== null && laneInfo.transition) {
      writeTransitionEntry(atom, value, laneInfo.lane, cycleGuard);
      return;
    }
    let entrySeq = 0;
    if (laneInfo !== null) entrySeq = appendLog(atom, value, laneInfo.lane, false);

    // Urgent/plain write: write-through on BASE (and HEAD, since urgent
    // writes are chronologically part of the head world too).
    let mask = 0;
    if (!atom.isEqual(atom.buffered, value)) {
      atom.buffered = value;
      atom.flags |= F.Dirty;
      mask |= PLANE_BASE;
      baseChangeSeq = entrySeq !== 0 ? entrySeq : ++writeSeq;
      headChangeSeq = baseChangeSeq;
    }
    atom.baseSeq = entrySeq !== 0 ? entrySeq : writeSeq;
    if (forkCount > 0) {
      if (!atom.isEqual(atom.headValue, value)) {
        atom.headValue = value;
        atom.flags |= F.HeadDirty;
        mask |= PLANE_HEAD;
        headChangeSeq = atom.baseSeq;
      }
    } else {
      atom.headValue = value;
    }
    if (mask !== 0 && atom.subs !== undefined) {
      propagate(atom.subs, forkCount > 0 ? mask : PLANE_BOTH, cycleGuard);
    }
    deliverNotifications();
  } finally {
    if (tracer !== null) setCurrentCause(cause);
  }
}

function writeTransitionEntry(
  atom: AtomNode,
  value: unknown,
  lane: number,
  cycleGuard: Node | undefined,
): void {
  const seq = appendLog(atom, value, lane, true);
  if (forkCount === 0) ++forkGen;
  ++forkCount;
  if (!atom.isEqual(atom.headValue, value)) {
    atom.headValue = value;
    atom.flags |= F.HeadDirty;
    headChangeSeq = seq;
    if (atom.subs !== undefined) {
      propagate(atom.subs, PLANE_HEAD, cycleGuard);
    }
  }
  deliverNotifications();
}

function appendLog(atom: AtomNode, value: unknown, lane: number, transition: boolean): number {
  if (atom.log === null || atom.log.length === 0) {
    atom.preLogValue = baseAtomValue(atom);
    if (atom.log === null) atom.log = [];
    loggedAtoms.add(atom);
  }
  const seq = ++writeSeq;
  atom.log.push({ value, lane, seq, foldedAtSeq: 0, transition });
  return seq;
}

// ---------------------------------------------------------------------------
// Fold: a React commit lands; pending writes join committed state
// ---------------------------------------------------------------------------

export type FoldDecision = (entry: WriteEntry) => boolean;

/**
 * Folds every pending log entry matching `shouldFold` into committed (BASE)
 * state. Called by the React bindings from the commit callback with "was this
 * entry's lane part of the committed lanes (or abandoned everywhere)?".
 *
 * BASE is last-write-wins in *write* order: a fold never rolls the base value
 * back past a newer write that is already part of BASE (write-through urgent
 * writes, or entries folded earlier) — `atom.baseSeq` guards this.
 *
 * Fold-propagation runs on BASE and re-runs effect watchers (their committed
 * world changed); subscriptions are not marked — components were notified in
 * the writer's context and have either rendered these values or have the
 * update queued.
 */
export function fold(shouldFold: FoldDecision): void {
  if (loggedAtoms.size === 0) return;
  const cause = tracer !== null ? setCurrentCause(tracer.emit('fold', currentCause)) : 0;
  const prevMuted = mutedSubscriptions;
  mutedSubscriptions = true;
  ++batchDepth;
  try {
    for (const atom of loggedAtoms) {
      const log = atom.log;
      if (log === null) continue;
      let newest: WriteEntry | null = null;
      for (let i = 0; i < log.length; i++) {
        const e = log[i]!;
        if (e.foldedAtSeq === 0 && shouldFold(e)) {
          e.foldedAtSeq = ++writeSeq;
          if (e.transition) --forkCount;
          if (newest === null || e.seq > newest.seq) newest = e;
        }
      }
      if (newest !== null && newest.seq > atom.baseSeq) {
        atom.baseSeq = newest.seq;
        if (!atom.isEqual(atom.buffered, newest.value)) {
          atom.buffered = newest.value;
          atom.flags |= F.Dirty;
          baseChangeSeq = ++writeSeq;
          headChangeSeq = writeSeq;
          if (atom.subs !== undefined) propagate(atom.subs, PLANE_BASE, undefined);
        }
      }
    }
    sweepLogs();
  } finally {
    --batchDepth;
    mutedSubscriptions = prevMuted;
    if (tracer !== null) setCurrentCause(cause);
  }
  deliverNotifications();
}

/**
 * Drops folded log entries no active render pass can still need. A pinned
 * pass may still need the value *before* a folded entry, so the sweep bound
 * is the entry's fold time, not its write time.
 */
function sweepLogs(): void {
  if (loggedAtoms.size === 0) return;
  const bound = minActivePin;
  for (const atom of loggedAtoms) {
    const log = atom.log;
    if (log === null) {
      loggedAtoms.delete(atom);
      continue;
    }
    let keepFrom = 0;
    while (keepFrom < log.length) {
      const e = log[keepFrom]!;
      if (e.foldedAtSeq !== 0 && e.foldedAtSeq <= bound) {
        atom.preLogValue = e.value;
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

/** True while any uncommitted transition write exists. Exposed for tests. */
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
  if (--batchDepth === 0 && evalDepth === 0) deliverNotifications();
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
    ((flags & F.Pending) !== 0 && w.deps !== undefined && checkDirty(w.deps, w, PLANE_BASE));
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
    const prev = activeSub;
    activeSub = undefined;
    try {
      cleanup();
    } finally {
      activeSub = prev;
    }
    if (w.flags === F.None) return; // cleanup disposed the watcher
  }
  const frame = startTracking(w, PLANE_BASE);
  w.flags |= F.Watching;
  ++evalDepth;
  const cause = tracer !== null ? setCurrentCause(tracer.emit('effect-run', currentCause, w)) : 0;
  try {
    const result = w.fn!();
    if (typeof result === 'function') w.cleanup = result;
  } finally {
    --evalDepth;
    endTracking(w, frame, PLANE_BASE);
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
  if (cleanup !== null) {
    const prev = activeSub;
    activeSub = undefined;
    try {
      cleanup();
    } finally {
      activeSub = prev;
    }
  }
}

// ---------------------------------------------------------------------------
// Node constructors (api.ts wraps these in the public classes)
// ---------------------------------------------------------------------------

export function createAtomNode(
  initial: unknown,
  isEqual: ((a: unknown, b: unknown) => boolean) | undefined,
  lifecycle: unknown,
): AtomNode {
  return {
    kind: KIND_ATOM,
    flags: F.Mutable,
    watched: 0,
    deps: undefined,
    depsTail: undefined,
    subs: undefined,
    subsTail: undefined,
    value: initial,
    buffered: initial,
    baseSeq: 0,
    headValue: initial,
    preLogValue: initial,
    log: null,
    isEqual: isEqual ?? Object.is,
    lifecycle: lifecycle ?? null,
  };
}

export function createComputedNode(
  fn: (ctx: unknown) => unknown,
  isEqual: ((a: unknown, b: unknown) => boolean) | undefined,
): ComputedNode {
  return {
    kind: KIND_COMPUTED,
    flags: F.None,
    watched: 0,
    deps: undefined,
    depsTail: undefined,
    subs: undefined,
    subsTail: undefined,
    value: undefined,
    status: STATUS_VALUE,
    payload: undefined,
    headValue: undefined,
    headStatus: STATUS_VALUE,
    headPayload: undefined,
    headGen: 0,
    baseGen: 0,
    evaluated: 0,
    fn,
    isEqual: isEqual ?? Object.is,
    thenables: null,
    settleAttached: null,
    renderCache: null,
  };
}
