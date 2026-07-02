/**
 * Code-review repro tests for src/core/engine.ts (two-plane world model).
 *
 * Every test here asserts the CORRECT behavior per DESIGN.md §2/§3 and the
 * engine's own doc comments. Tests marked `test.fails` currently fail —
 * each one is a confirmed defect. See the review report for explanations.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { Atom, Computed, effect } from '../src/core/index.ts';
import {
  setWriteLaneProvider,
  setAmbientWorld,
  pinRenderPass,
  unpinRenderPass,
  fold,
  isForked,
  currentWriteSeq,
  createWatcher,
  subscribeTo,
  WATCHER_SUBSCRIPTION,
  type RenderWorld,
} from '../src/core/engine.ts';

const LANE_SYNC = 1;
const LANE_T = 2;
const LANE_T2 = 4;

function makeWorld(lanes: number, maxSeq: number): RenderWorld {
  return {
    lanes,
    maxSeq,
    laneIncluded: (worldLanes, lane) => (worldLanes & lane) !== 0,
    seesTransitions: null,
  };
}

function withLane<T>(lane: number, transition: boolean, fn: () => T): T {
  setWriteLaneProvider(() => ({ lane, transition }));
  try {
    return fn();
  } finally {
    setWriteLaneProvider(null);
  }
}

// The engine keeps module-level state (forkCount, loggedAtoms, writeSeq).
// Reconverge the planes after every test so tests don't contaminate each
// other: fold everything and clear providers/worlds.
afterEach(() => {
  setWriteLaneProvider(null);
  setAmbientWorld(null);
  fold(() => true);
  expect(isForked()).toBe(false);
});

function controlled<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('review: fold ordering', () => {
  // DEFECT A — fold() computes the new committed value from the last entry
  // folded *in this call*, ignoring later-seq entries that are already part
  // of BASE (write-through urgent entries, or entries folded by an earlier
  // fold call). Folding the sync lane first (React's normal commit order:
  // sync commit, then transition commit) and the transition lane second
  // rolls the committed value BACK to the older transition write.
  test('A: transition fold must not clobber a later urgent write (fold sync, then fold transition)', () => {
    const a = new Atom({ state: 1 });
    withLane(LANE_T, true, () => {
      a.set(2); // transition write, seq 1
    });
    withLane(LANE_SYNC, false, () => {
      a.set(3); // urgent write, seq 2 — write-through to BASE
    });
    expect(a.state).toBe(3); // head: last write wins

    fold((e) => e.lane === LANE_SYNC); // sync lane commits first (normal order)
    fold((e) => e.lane === LANE_T); // transition commits second
    expect(isForked()).toBe(false);

    // Last write wins: committed value must be 3. Actual: 2.
    expect(a.state).toBe(3);
  });

  // Same root cause, two transition lanes folded newest-first.
  test('A2: folding an older transition lane after a newer one rolls the value back', () => {
    const a = new Atom({ state: 1 });
    withLane(LANE_T, true, () => {
      a.set(2); // lane T, seq 1
    });
    withLane(LANE_T2, true, () => {
      a.set(3); // lane T2, seq 2
    });
    fold((e) => e.lane === LANE_T2);
    expect(a.state).toBe(3); // ok so far (untracked read; still forked with T pending)
    fold((e) => e.lane === LANE_T);
    expect(isForked()).toBe(false);
    expect(a.state).toBe(3); // actual: 2
  });
});

describe('review: head plane seeding', () => {
  // DEFECT B — seedHead() copies the computed's *stale* BASE cache into the
  // head mirror, and head-plane checkDirty cannot discover pre-fork atom
  // changes (steady-state writes set only F.Dirty, never F.HeadDirty; the
  // atom's buffered/committed values aren't consulted in the HEAD branch).
  // A computed that was not re-read between a steady-state write and the next
  // fork returns a stale head value, tearing against direct atom reads.
  test('B: head read of a lazy computed after fork must see pre-fork writes', () => {
    const a = new Atom({ state: 1 });
    const z = new Atom({ state: 0 });
    const c = new Computed({ fn: () => a.state * 10 });
    expect(c.state).toBe(10); // evaluate once; mirrors synced

    a.set(2); // steady-state write; c stays lazily stale (Pending)

    withLane(LANE_T, true, () => {
      z.set(1); // unrelated transition write → fork
    });

    expect(a.state).toBe(2); // head atom read: fine
    expect(c.state).toBe(20); // head computed read: actual 10 (stale seed)
  });
});

describe('review: render-world fast paths', () => {
  // DEFECT C — resolveComputedInWorld's transition-world fast path returns
  // the live HEAD plane, but HEAD contains *unfolded urgent* writes that the
  // world's lane filter excludes. Direct atom reads in the same world use
  // resolveAtomInWorld, which correctly excludes them → the same render pass
  // sees two different values for the same state (tear). The computed must
  // "participate" in the graph for the fast path (evaluated once / subscribed
  // — the normal case for a useSignal'd computed).
  test('C: transition world must not see an unfolded urgent write via the computed fast path', () => {
    const a = new Atom({ state: 1 });
    const b = new Atom({ state: 10 });
    const cb = new Computed({ fn: () => b.state });
    expect(cb.state).toBe(10); // participate: evaluated once, deps exist
    withLane(LANE_T, true, () => {
      a.set(2); // fork; makes the world "see transitions"
    });
    withLane(LANE_SYNC, false, () => {
      b.set(11); // urgent write, unfolded, lane NOT in the world below
    });
    const world = makeWorld(LANE_T, currentWriteSeq());
    const prev = setAmbientWorld(world);
    try {
      const atomView = b.state; // 10: unfolded urgent entry excluded by lane
      const computedView = cb.state; // actual 11: HEAD fast path includes it
      expect(computedView).toBe(atomView);
      expect(computedView).toBe(10);
    } finally {
      setAmbientWorld(prev);
    }
  });

  // DEFECT D — same class, no fork needed: with forkCount === 0 the BASE
  // fast path is taken without checking anyUnfoldedUrgentEntries(), so a
  // world whose lanes exclude a pending urgent/default-priority write reads
  // it anyway through computeds (but not through atoms).
  test('D: non-forked world excluding an unfolded urgent lane must not see it via computeds', () => {
    const b = new Atom({ state: 10 });
    const cb = new Computed({ fn: () => b.state });
    expect(cb.state).toBe(10); // participate: evaluated once, deps exist
    withLane(LANE_SYNC, false, () => {
      b.set(11); // logged urgent entry, unfolded
    });
    const world = makeWorld(LANE_T, currentWriteSeq()); // lanes exclude LANE_SYNC
    const prev = setAmbientWorld(world);
    try {
      expect(b.state).toBe(10); // atom read: excluded (passes)
      expect(cb.state).toBe(10); // actual 11 via BASE fast path
    } finally {
      setAmbientWorld(prev);
    }
  });
});

describe('review: pinned render passes vs fold', () => {
  // DEFECT E — a fold while a pass is pinned changes what the pass reads:
  // (1) resolveAtomInWorld treats *folded* entries as visible regardless of
  // when they folded (`e.folded ||` has no fold-time stamp), and (2)
  // sweepLogs drops the folded entry into preLogValue because its *write*
  // seq is <= the pin, even though the pass had excluded it by lane.
  // The pin was supposed to isolate the pass ("epoch pinning", DESIGN §2).
  test('E: a fold while a pass is pinned must not change the pass’s reads', () => {
    const a = new Atom({ state: 1 });
    withLane(LANE_T, true, () => {
      a.set(2);
    });
    const pin = currentWriteSeq();
    pinRenderPass(pin);
    const world = makeWorld(LANE_SYNC, pin); // urgent pass; excludes the transition
    try {
      let prev = setAmbientWorld(world);
      let first: unknown;
      try {
        first = a.state; // 1
      } finally {
        setAmbientWorld(prev);
      }
      expect(first).toBe(1);

      fold((e) => e.lane === LANE_T); // another root commits mid-pass

      prev = setAmbientWorld(world);
      let second: unknown;
      try {
        second = a.state; // must still be 1; actual 2
      } finally {
        setAmbientWorld(prev);
      }
      expect(second).toBe(first);
    } finally {
      unpinRenderPass(pin);
    }
  });
});

describe('review: subscription notifications', () => {
  // DEFECT H — a single write notifies a computed-mediated subscription
  // twice: checkDirty's updateComputed fires shallowPropagate on the
  // computed's subscribers, which re-enters notifyWatcher for the very
  // watcher whose confirmSubscriptionDirty is in flight (subscriptions never
  // clear F.Watching, so there is no "already queued" dedupe like effects
  // have), then the outer confirm returns true and notifies again.
  test('H: one write → exactly one subscription notification', () => {
    const a = new Atom({ state: 1 });
    const c = new Computed({ fn: () => a.state * 10 });
    expect(c.state).toBe(10);
    let notifies = 0;
    const w = createWatcher(WATCHER_SUBSCRIPTION, null, () => {
      notifies++;
    });
    subscribeTo(w, c.node);
    a.set(2);
    expect(notifies).toBe(1); // actual: 2
  });

  // DEFECT I — mutedSubscriptions paths (settle listener, fold) return from
  // notifyWatcher *without clearing the watcher's Pending/HeadPending bits*.
  // The next real write finds the watcher "alreadyMarked" in propagate and
  // prunes the branch: the subscription is never notified of a genuine
  // change. (confirmSubscriptionDirty's own doc comment: "leftover bits
  // would only suppress future notifications".)
  test('I: a real write after a muted settle-propagation must still notify', async () => {
    const { promise, resolve } = controlled<number>();
    const a = new Atom({ state: 1 });
    const c = new Computed({ fn: (ctx) => a.state + ctx.use(promise) });
    let notifies = 0;
    const w = createWatcher(WATCHER_SUBSCRIPTION, null, () => {
      notifies++;
    });
    subscribeTo(w, c.node); // evaluates c → suspended
    resolve(10);
    await promise; // settle: muted propagate marks w Pending, no notify (by design)
    expect(notifies).toBe(0);

    a.set(2); // genuine change: c's committed result suspended→12
    expect(notifies).toBeGreaterThan(0); // actual: 0 — pruned as alreadyMarked
  });

  // DEFECT F — notifyWatcher confirms dirtiness in only ONE plane (HEAD when
  // forked) but clears the watcher's bits for BOTH planes. When the head
  // plane's equality cutoff says "unchanged" while the BASE plane genuinely
  // changed, the notification is swallowed: the urgent world's subscribers
  // never learn about the urgent write.
  test('F: urgent write with head-equal but base-changed result must notify', () => {
    const a = new Atom({ state: 0 });
    const t = new Atom({ state: 0 });
    const c = new Computed({ fn: () => (a.state > 0 || t.state > 0 ? 1 : 0) });
    expect(c.state).toBe(0);
    let notifies = 0;
    const w = createWatcher(WATCHER_SUBSCRIPTION, null, () => {
      notifies++;
    });
    subscribeTo(w, c.node);

    withLane(LANE_T, true, () => {
      t.set(1); // fork; head c: 0→1 → notify fires
    });
    const before = notifies;
    expect(before).toBeGreaterThan(0);

    withLane(LANE_SYNC, false, () => {
      a.set(1); // BASE c: 0→1 (urgent world changed!); HEAD c: 1→1 (cutoff)
    });
    expect(notifies).toBeGreaterThan(before); // actual: unchanged — swallowed
  });
});

describe('review: sanity checks that pass (kept as regression guards)', () => {
  test('fold of both lanes in one call keeps last-write-wins', () => {
    const a = new Atom({ state: 1 });
    withLane(LANE_T, true, () => {
      a.set(2);
    });
    withLane(LANE_SYNC, false, () => {
      a.set(3);
    });
    fold(() => true); // single fold call folds in log order
    expect(a.state).toBe(3);
  });

  test('effects run exactly once per fold touching multiple atoms', () => {
    const a = new Atom({ state: 1 });
    const b = new Atom({ state: 1 });
    let runs = 0;
    effect(() => {
      void a.state;
      void b.state;
      runs++;
    });
    expect(runs).toBe(1);
    withLane(LANE_T, true, () => {
      a.set(2);
      b.set(2);
    });
    expect(runs).toBe(1); // pending transition: not yet
    fold((e) => e.lane === LANE_T);
    expect(runs).toBe(2); // exactly once for the whole fold
  });
});
