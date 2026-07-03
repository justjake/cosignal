/**
 * Code-review repro tests for src/core/engine.ts (reviewer: claude).
 *
 * Each `test.fails` case asserts the CORRECT behavior and currently fails,
 * demonstrating a confirmed defect. Plain `test` cases are sanity checks that
 * pass (documenting behaviors probed and found sound).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Atom, Computed, effect, untracked, SuspendedRead } from '../src/core/index.ts';
import {
  setWriteBatchProvider,
  setAmbientWorld,
  pinRenderPass,
  unpinRenderPass,
  retireBatch,
  isForked,
  currentWriteSeq,
  createWatcher,
  subscribeTo,
  disposeWatcher,
  WATCHER_SUBSCRIPTION,
  STATUS_SUSPENDED,
  WORLD_COMMITTED,
  type BatchRef,
  type RenderWorld,
  type Plane,
} from '../src/core/engine.ts';

// Fake batch tokens standing in for the patch's (opaque BatchRef objects).
// Fresh per test so retirement state doesn't leak between tests.
let SYNC_BATCH: BatchRef;
let T_BATCH: BatchRef;
const createdTokens: BatchRef[] = [];
beforeEach(() => {
  SYNC_BATCH = { deferred: false };
  T_BATCH = { deferred: true };
  createdTokens.push(SYNC_BATCH, T_BATCH);
});

function makeWorld(includes: readonly BatchRef[], maxSeq: number): RenderWorld {
  return {
    includes,
    maxSeq,
    seesDeferred: null,
  };
}

function withBatch<T>(token: BatchRef, fn: () => T): T {
  setWriteBatchProvider(() => token);
  try {
    return fn();
  } finally {
    setWriteBatchProvider(null);
  }
}

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

const tick = () => Promise.resolve();

afterEach(() => {
  // Reset module-global engine state so one test's fork doesn't leak into the
  // next: drop batch provider / ambient world, retire every batch the test
  // created (retiring an unused token is a no-op).
  setWriteBatchProvider(null);
  setAmbientWorld(null);
  for (const t of createdTokens.splice(0)) retireBatch(t);
});

// ---------------------------------------------------------------------------
// Finding 1: muted settle propagation permanently silences subscriptions
// ---------------------------------------------------------------------------

describe('finding 1: subscription watcher dies after suspense settle', () => {
  test('subscription is notified of a real change after a settle', async () => {
    const a = new Atom({ state: 1 });
    const { promise, resolve } = controlled<number>();
    const c = new Computed({ fn: (ctx) => a.state + ctx.use(promise) });
    const calls: Plane[] = [];
    const w = createWatcher(WATCHER_SUBSCRIPTION, null, (p) => void calls.push(p));
    subscribeTo(w, c.node); // evaluates c: suspended
    try {
      resolve(10);
      await promise;
      await tick();
      await tick();
      // settle propagation is muted by design; no notification expected here.
      expect(calls.length).toBe(0);
      // But the muted propagate left F.Pending|F.HeadPending set on w
      // (notifyWatcher returns before confirmSubscriptionDirty when muted),
      // so every future propagate sees `alreadyMarked` and prunes at w.
      a.set(5); // genuine change: c is now 15 — subscriber must hear it
      expect(calls.length).toBe(1); // FAILS: 0 — notification lost forever
      a.set(6);
      expect(calls.length).toBe(2);
    } finally {
      disposeWatcher(w);
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 2: fold() regresses base when an older transition entry folds after
// a newer urgent entry on the same atom (rebase broken for same-atom writes)
// ---------------------------------------------------------------------------

describe('finding 2: same-atom transition+urgent fold order', () => {
  test('urgent write is not clobbered by a later transition fold', () => {
    const a = new Atom({ state: 1 });
    withBatch(T_BATCH, () => {
      a.set(2); // transition write (older)
    });
    withBatch(SYNC_BATCH, () => {
      a.set(3); // urgent write (newer) — head world is 3
    });
    expect(a.state).toBe(3); // head read
    retireBatch(SYNC_BATCH); // sync commit
    expect(a.state).toBe(3);
    retireBatch(T_BATCH); // transition commit (rebase)
    expect(isForked()).toBe(false);
    // React's rebase semantics (DESIGN.md §2): last write wins → 3. The head
    // world showed 3 all along; retirement must not regress committed state
    // to the older transition entry.
    expect(a.state).toBe(3); // FAILS: 2
  });
});

// ---------------------------------------------------------------------------
// Finding 3: first evaluation while forked commits only one plane
// ---------------------------------------------------------------------------

describe('finding 3: computed first-evaluated while forked', () => {
  test('head-first eval: BASE read must not return undefined', () => {
    const a = new Atom({ state: 1 });
    withBatch(T_BATCH, () => {
      a.set(2); // fork
    });
    const c = new Computed({ fn: () => a.state * 10 });
    expect(c.state).toBe(20); // untracked read while forked → HEAD plane; ok
    // commitComputedResult(plane=HEAD, forked) never writes c.value/c.status,
    // and pullComputed(BASE) sees Mutable + no dirty flags → "clean" →
    // returns the never-initialized base value.
    const seen: unknown[] = [];
    const dispose = effect(() => {
      seen.push(c.state); // effects evaluate in BASE
    });
    dispose();
    expect(seen).toEqual([10]); // FAILS: [undefined]
  });

  test('base-first eval: HEAD read must see the transition value', () => {
    const a = new Atom({ state: 1 });
    withBatch(T_BATCH, () => {
      a.set(2); // fork; head a=2, base a=1
    });
    const c = new Computed({ fn: () => a.state * 10 });
    const seen: unknown[] = [];
    const dispose = effect(() => {
      seen.push(c.state); // BASE first eval → 10; head mirror never computed
    });
    try {
      expect(seen).toEqual([10]);
      // Untracked read while forked → HEAD plane. seedHead copies the BASE
      // result (10) and the clean flags make pullComputed trust it, even
      // though the head world has a=2. (Disposing the effect first would mask
      // the bug: the unwatched-computed reset re-marks HeadDirty.)
      expect(c.state).toBe(20); // FAILS: 10
    } finally {
      dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 4: checkDirty's HEAD-plane atom branch skips shallowPropagate
// ---------------------------------------------------------------------------

describe('finding 4: second head subscriber misses an atom head change', () => {
  test('both computeds see the transition value in HEAD', () => {
    const a = new Atom({ state: 1 });
    const c1 = new Computed({ fn: () => a.state * 10 });
    const c2 = new Computed({ fn: () => a.state * 100 });
    expect(c1.state).toBe(10);
    expect(c2.state).toBe(100);
    withBatch(T_BATCH, () => {
      a.set(2);
    });
    // Pulling c1 in HEAD clears the atom's HeadDirty bit; the BASE branch of
    // checkDirty shallowPropagates to the atom's other subscribers, the HEAD
    // branch does not — so c2's HeadPending validates "clean".
    expect(c1.state).toBe(20);
    expect(c2.state).toBe(200); // FAILS: 100 (stale seeded base value)
  });
});

// ---------------------------------------------------------------------------
// Finding 5: CycleError false positive from a stale link
// ---------------------------------------------------------------------------

describe('finding 5: stale-link cycle false positive', () => {
  test('write to a dropped dep of the running computed is legal', () => {
    const gate = new Atom({ state: true });
    const b = new Atom({ state: 0 });
    const c = new Computed({
      fn: () => {
        if (gate.state) return b.state; // run 1 reads b
        b.set(99); // run 2 writes b WITHOUT reading it (dep set shrank)
        return 1;
      },
    });
    expect(c.state).toBe(0);
    gate.set(false);
    // The stale link b→c from run 1 is still in b's subscriber list mid-run-2
    // (pruned only at endTracking); propagate's `sub === cycleGuard` check has
    // no isValidLink-style "read so far this run" validation → throws.
    expect(c.state).toBe(1); // FAILS: CycleError
    expect(b.state).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Finding 6: fold mid-pass tears a pinned render pass
// ---------------------------------------------------------------------------

describe('finding 6: pinned render pass vs mid-pass fold', () => {
  test('a pinned pass excluding batch T never sees T, even after retirement', () => {
    const a = new Atom({ state: 1 });
    withBatch(T_BATCH, () => {
      a.set(2);
    });
    const pin = currentWriteSeq();
    pinRenderPass(pin);
    const world = makeWorld([SYNC_BATCH], pin); // urgent pass, excludes batch T
    const prev = setAmbientWorld(world);
    try {
      expect(a.state).toBe(1); // correct: entry unretired, batch not included
      setAmbientWorld(prev);
      retireBatch(T_BATCH); // another root commits mid-pass
      setAmbientWorld(world);
      // If resolveAtomInWorld treated retired entries as visible regardless
      // of WHEN they retired (no epoch pin), or the sweep dropped the entry
      // into preLogValue despite the active pin, the same pass would read 2.
      expect(a.state).toBe(1); // FAILS: 2 — tear within one pinned pass
    } finally {
      setAmbientWorld(prev);
      unpinRenderPass(pin);
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 7: disposeWatcher runs cleanup with tracking still active
// ---------------------------------------------------------------------------

describe('finding 7: dispose-cleanup reads leak into the disposing effect', () => {
  test('cleanup reads are not tracked as deps of the outer effect', () => {
    const x = new Atom({ state: 0 });
    const flag = new Atom({ state: false });
    const disposeB = effect(() => {
      return () => {
        void x.state; // cleanup reads x
      };
    });
    let runsA = 0;
    const disposeA = effect(() => {
      runsA++;
      if (flag.state) disposeB();
    });
    try {
      expect(runsA).toBe(1);
      flag.set(true); // A re-runs, disposes B; B's cleanup runs while A is
      // the activeSub with RecursedCheck set → x gets linked as a dep of A.
      expect(runsA).toBe(2);
      x.set(99); // must not re-run A (runEffect nulls activeSub around
      // cleanups; disposeWatcher forgets to)
      expect(runsA).toBe(2); // FAILS: 3
    } finally {
      disposeA();
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 8: suspension of an inner computed is recorded as ERROR on outer
// ---------------------------------------------------------------------------

describe('finding 8: suspended dep read by another computed', () => {
  test('outer computed status is SUSPENDED, cutoff on same thenable', async () => {
    const { promise, resolve } = controlled<number>();
    const a = new Atom({ state: 0 });
    const inner = new Computed<number>({ fn: (ctx) => ctx.use(promise) });
    const outer = new Computed({
      fn: () => {
        const av = a.state;
        return inner.state + av;
      },
    });
    const calls: Plane[] = [];
    const w = createWatcher(WATCHER_SUBSCRIPTION, null, (p) => void calls.push(p));
    subscribeTo(w, outer.node);
    try {
      // Read sites do see a SuspendedRead (thrown as an *error* payload)…
      expect(() => outer.state).toThrow(SuspendedRead as unknown as Error);
      // …but the outer's result state is STATUS_ERROR carrying a fresh
      // SuspendedRead instance instead of STATUS_SUSPENDED carrying the
      // thenable. Every re-evaluation makes a new SuspendedRead, so the
      // "unchanged" cutoff can never apply while suspended:
      a.set(1); // outer still suspends on the SAME promise → no real change
      expect(calls.length).toBe(0); // FAILS: 2 (spurious notifies; payload is a
      // fresh SuspendedRead instance each eval so equality cutoff never holds)
      const committedResult = outer.node.results.find((r) => r.world === WORLD_COMMITTED);
      expect(committedResult?.status).toBe(STATUS_SUSPENDED); // also fails: STATUS_ERROR
      // (verified separately: status === STATUS_ERROR, payload constructor
      // === SuspendedRead)
      resolve(41);
      await promise;
      await tick();
      await tick();
      expect(outer.state).toBe(42); // recovery does work (via inner's settle)
    } finally {
      disposeWatcher(w);
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 9: isEqual throwing in commitComputedResult leaves a clean+stale node
// ---------------------------------------------------------------------------

describe('finding 9: throwing isEqual corrupts computed state', () => {
  test('a throwing isEqual does not leave the computed clean with a stale value', () => {
    let boom = false;
    const a = new Atom({ state: 1 });
    const c = new Computed<number>({
      fn: () => a.state,
      isEqual: (x, y) => {
        if (boom) throw new Error('eq boom');
        return x === y;
      },
    });
    expect(c.state).toBe(1);
    a.set(2);
    boom = true;
    // commitComputedResult runs OUTSIDE updateComputed's try/finally; the
    // throw escapes after flags were already cleared, so the node looks clean.
    expect(() => c.state).toThrow('eq boom');
    boom = false;
    expect(c.state).toBe(2); // FAILS: 1 (stale value served as clean)
  });
});

// ---------------------------------------------------------------------------
// Sanity checks that PASS (behaviors probed and found sound)
// ---------------------------------------------------------------------------

describe('sanity (no defect found)', () => {
  test('effect self-write does not throw and defers (alien semantics)', () => {
    const a = new Atom({ state: 0 });
    let runs = 0;
    const dispose = effect(() => {
      runs++;
      if (a.state < 1) a.set(a.state + 1);
    });
    expect(runs).toBe(1); // no synchronous re-entrant loop
    expect(a.state).toBe(1);
    dispose();
  });

  test('atom effect writing its own atom at mount notifies watchers', async () => {
    const a = new Atom({
      state: 0,
      effect: (ctx) => {
        ctx.set(42);
      },
    });
    const seen: number[] = [];
    const dispose = effect(() => void seen.push(a.state));
    await tick();
    expect(seen).toEqual([0, 42]);
    dispose();
  });

  test('dynamic dep drop unmounts a lifecycle atom', async () => {
    const log: string[] = [];
    const a = new Atom({
      state: 1,
      effect: () => {
        log.push('mount');
        return () => log.push('unmount');
      },
    });
    const flag = new Atom({ state: true });
    const c = new Computed({ fn: () => (flag.state ? a.state : 0) });
    const dispose = effect(() => void c.state);
    await tick();
    expect(log).toEqual(['mount']);
    flag.set(false); // c drops a → a unwatched mid-flight
    await tick();
    expect(log).toEqual(['mount', 'unmount']);
    dispose();
  });

  test('untracked reads inside a computed do not subscribe', () => {
    const a = new Atom({ state: 1 });
    const b = new Atom({ state: 10 });
    let evals = 0;
    const c = new Computed({
      fn: () => {
        evals++;
        return a.state + untracked(() => b.state);
      },
    });
    expect(c.state).toBe(11);
    b.set(20); // untracked → no invalidation
    expect(c.state).toBe(11);
    expect(evals).toBe(1);
    a.set(2);
    expect(c.state).toBe(22);
  });

  test('multi-promise positional ctx.use resolves stepwise', async () => {
    const p1 = controlled<number>();
    const p2 = controlled<number>();
    const c = new Computed({ fn: (ctx) => ctx.use(p1.promise) + ctx.use(p2.promise) });
    expect(() => c.state).toThrow(SuspendedRead as unknown as Error);
    p1.resolve(1);
    await p1.promise;
    expect(() => c.state).toThrow(SuspendedRead as unknown as Error); // now on p2
    p2.resolve(2);
    await p2.promise;
    expect(c.state).toBe(3);
  });
});
