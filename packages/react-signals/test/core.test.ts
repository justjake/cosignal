import { describe, expect, test, vi } from 'vitest';
import {
  Atom,
  Computed,
  effect,
  batch,
  configure,
  untracked,
  SuspendedRead,
  CycleError,
} from '../src/core/index.ts';
import {
  setWriteLaneProvider,
  setAmbientWorld,
  pinRenderPass,
  unpinRenderPass,
  fold,
  isForked,
  currentWriteSeq,
  type RenderWorld,
} from '../src/core/engine.ts';

function counted<T>(fn: () => T): { fn: () => T; calls: () => number } {
  let calls = 0;
  return {
    fn: () => {
      calls++;
      return fn();
    },
    calls: () => calls,
  };
}

describe('atoms', () => {
  test('read and write', () => {
    const a = new Atom({ state: 1 });
    expect(a.state).toBe(1);
    a.set(2);
    expect(a.state).toBe(2);
  });

  test('custom isEqual suppresses propagation', () => {
    const a = new Atom<{ v: number }>({
      state: { v: 1 },
      isEqual: (x, y) => x.v === y.v,
    });
    const log: number[] = [];
    effect(() => {
      log.push(a.state.v);
    });
    expect(log).toEqual([1]);
    a.set({ v: 1 }); // equal per isEqual
    expect(log).toEqual([1]);
    a.set({ v: 2 });
    expect(log).toEqual([1, 2]);
  });
});

describe('computeds', () => {
  test('lazy evaluation and caching', () => {
    const a = new Atom({ state: 2 });
    const double = counted(() => a.state * 2);
    const c = new Computed({ fn: double.fn });
    expect(double.calls()).toBe(0); // creation does not evaluate
    expect(c.state).toBe(4);
    expect(c.state).toBe(4);
    expect(double.calls()).toBe(1); // cached
    a.set(3);
    expect(double.calls()).toBe(1); // write does not eagerly recompute
    expect(c.state).toBe(6);
    expect(double.calls()).toBe(2);
  });

  test('fresh reads mid-batch (benchmark contract)', () => {
    const a = new Atom({ state: 1 });
    const c = new Computed({ fn: () => a.state * 10 });
    batch(() => {
      a.set(2);
      expect(c.state).toBe(20);
      a.set(3);
      expect(c.state).toBe(30);
    });
  });

  test('equality cutoff stops downstream recomputation', () => {
    const a = new Atom({ state: 1 });
    const parity = new Computed({ fn: () => a.state % 2 });
    const downstream = counted(() => parity.state * 100);
    const c = new Computed({ fn: downstream.fn });
    expect(c.state).toBe(100);
    a.set(3); // parity unchanged (1)
    expect(c.state).toBe(100);
    expect(downstream.calls()).toBe(1);
    a.set(4); // parity changed (0)
    expect(c.state).toBe(0);
    expect(downstream.calls()).toBe(2);
  });

  test('diamond evaluates the join once per change', () => {
    const a = new Atom({ state: 1 });
    const left = new Computed({ fn: () => a.state + 1 });
    const right = new Computed({ fn: () => a.state * 10 });
    const join = counted(() => left.state + right.state);
    const c = new Computed({ fn: join.fn });
    expect(c.state).toBe(12);
    a.set(2);
    expect(c.state).toBe(23);
    expect(join.calls()).toBe(2);
  });

  test('dynamic dependencies attach and detach', () => {
    const which = new Atom({ state: true });
    const a = new Atom({ state: 'a' });
    const b = new Atom({ state: 'b' });
    const pick = counted(() => (which.state ? a.state : b.state));
    const c = new Computed({ fn: pick.fn });
    const seen: string[] = [];
    effect(() => {
      seen.push(c.state);
    });
    expect(seen).toEqual(['a']);
    b.set('b2'); // not a dependency right now
    expect(seen).toEqual(['a']);
    expect(pick.calls()).toBe(1);
    which.set(false);
    expect(seen).toEqual(['a', 'b2']);
    a.set('a2'); // no longer a dependency
    expect(seen).toEqual(['a', 'b2']);
    b.set('b3');
    expect(seen).toEqual(['a', 'b2', 'b3']);
  });

  test('repeated reads of one source register a single dependency', () => {
    const a = new Atom({ state: 1 });
    const body = counted(() => {
      let sum = 0;
      for (let i = 0; i < 30; i++) sum += a.state;
      return sum;
    });
    const c = new Computed({ fn: body.fn });
    expect(c.state).toBe(30);
    a.set(2);
    expect(c.state).toBe(60);
    expect(body.calls()).toBe(2);
  });

  test('errors are cached and rethrown until deps change', () => {
    const a = new Atom({ state: 1 });
    const boom = counted(() => {
      if (a.state === 1) throw new Error('boom');
      return a.state;
    });
    const c = new Computed({ fn: boom.fn });
    expect(() => c.state).toThrow('boom');
    expect(() => c.state).toThrow('boom');
    expect(boom.calls()).toBe(1); // error result is cached
    a.set(5);
    expect(c.state).toBe(5);
  });
});

describe('effects', () => {
  test('runs eagerly, re-runs on change, flushes synchronously', () => {
    const a = new Atom({ state: 1 });
    const seen: number[] = [];
    effect(() => {
      seen.push(a.state);
    });
    expect(seen).toEqual([1]);
    a.set(2);
    expect(seen).toEqual([1, 2]);
  });

  test('batch dedupes effect runs', () => {
    const a = new Atom({ state: 1 });
    const b = new Atom({ state: 10 });
    const runs = counted(() => a.state + b.state);
    effect(() => void runs.fn());
    expect(runs.calls()).toBe(1);
    batch(() => {
      a.set(2);
      b.set(20);
    });
    expect(runs.calls()).toBe(2); // exactly one flush for the batch
  });

  test('cleanup runs before re-run and on dispose', () => {
    const a = new Atom({ state: 1 });
    const log: string[] = [];
    const dispose = effect(() => {
      const v = a.state;
      log.push(`run ${v}`);
      return () => log.push(`clean ${v}`);
    });
    a.set(2);
    dispose();
    expect(log).toEqual(['run 1', 'clean 1', 'run 2', 'clean 2']);
  });

  test('unrelated writes do not re-run effects', () => {
    const a = new Atom({ state: 1 });
    const b = new Atom({ state: 2 });
    const runs = counted(() => a.state);
    effect(() => void runs.fn());
    b.set(99);
    expect(runs.calls()).toBe(1);
  });

  test('A→B→A within a batch does not re-run effects', () => {
    const a = new Atom({ state: 1 });
    const runs = counted(() => a.state);
    effect(() => void runs.fn());
    batch(() => {
      a.set(2);
      a.set(1);
    });
    expect(runs.calls()).toBe(1);
  });

  test('untracked reads do not subscribe', () => {
    const a = new Atom({ state: 1 });
    const runs = counted(() => untracked(() => a.state));
    effect(() => void runs.fn());
    a.set(2);
    expect(runs.calls()).toBe(1);
  });
});

describe('writes inside computeds', () => {
  test('non-cyclic write is tolerated', () => {
    const a = new Atom({ state: 1 });
    const sideChannel = new Atom({ state: 0 });
    const c = new Computed({
      fn: () => {
        const v = a.state * 2;
        sideChannel.set(v); // write to an atom the computed doesn't read
        return v;
      },
    });
    expect(c.state).toBe(2);
    expect(sideChannel.state).toBe(2);
    a.set(5);
    expect(c.state).toBe(10);
    expect(sideChannel.state).toBe(10);
  });

  test('cyclic write throws CycleError', () => {
    const a = new Atom({ state: 1 });
    const c = new Computed({
      fn: () => {
        const v = a.state;
        a.set(v + 1); // writes its own dependency
        return v;
      },
    });
    expect(() => c.state).toThrow(CycleError);
  });

  test('computed reading itself throws CycleError', () => {
    const c: Computed<number> = new Computed({
      fn: () => c.state + 1,
    });
    expect(() => c.state).toThrow(CycleError);
  });

  test('forbidWritesInComputeds forbids all writes', () => {
    configure({ forbidWritesInComputeds: true });
    try {
      const other = new Atom({ state: 0 });
      const c = new Computed({
        fn: () => {
          other.set(1);
          return 1;
        },
      });
      expect(() => c.state).toThrow(/forbidden/);
    } finally {
      configure({ forbidWritesInComputeds: false });
    }
  });
});

describe('suspense (ctx.use)', () => {
  function controlled<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  test('pending promise suspends the read; settle self-heals', async () => {
    const { promise, resolve } = controlled<number>();
    const a = new Atom({ state: 1 });
    const c = new Computed({ fn: (ctx) => a.state + ctx.use(promise) });
    let thrown: unknown;
    try {
      c.state;
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SuspendedRead);
    resolve(10);
    await promise;
    expect(c.state).toBe(11);
  });

  test('rejected promise surfaces as an error result', async () => {
    const { promise, reject } = controlled<number>();
    const c = new Computed({ fn: (ctx) => ctx.use(promise) });
    expect(() => c.state).toThrow(SuspendedRead as unknown as Error);
    reject(new Error('nope'));
    await promise.catch(() => {});
    expect(() => c.state).toThrow('nope');
  });

  test('effects re-run when a suspended computed settles', async () => {
    const { promise, resolve } = controlled<number>();
    const c = new Computed({ fn: (ctx) => ctx.use(promise) * 2 });
    const seen: unknown[] = [];
    effect(() => {
      try {
        seen.push(c.state);
      } catch (e) {
        seen.push(e instanceof SuspendedRead ? 'suspended' : e);
      }
    });
    expect(seen).toEqual(['suspended']);
    resolve(21);
    await promise;
    await Promise.resolve();
    expect(seen).toEqual(['suspended', 42]);
  });
});

describe('atom observed lifecycle', () => {
  test('effect mounts on first watcher, cleans up after last, flaps coalesce', async () => {
    const log: string[] = [];
    const a = new Atom({
      state: 1,
      effect: () => {
        log.push('mount');
        return () => log.push('unmount');
      },
    });
    expect(log).toEqual([]);
    const dispose = effect(() => void a.state);
    expect(log).toEqual([]); // deferred to microtask
    await Promise.resolve();
    expect(log).toEqual(['mount']);

    // flap: unwatch + rewatch within one tick coalesces to nothing
    dispose();
    const dispose2 = effect(() => void a.state);
    await Promise.resolve();
    expect(log).toEqual(['mount']);

    dispose2();
    await Promise.resolve();
    expect(log).toEqual(['mount', 'unmount']);
  });

  test('observed through a computed chain', async () => {
    const log: string[] = [];
    const a = new Atom({
      state: 1,
      effect: () => {
        log.push('mount');
        return () => log.push('unmount');
      },
    });
    const c = new Computed({ fn: () => a.state * 2 });
    const outer = new Computed({ fn: () => c.state + 1 });
    const dispose = effect(() => void outer.state);
    await Promise.resolve();
    expect(log).toEqual(['mount']);
    dispose();
    await Promise.resolve();
    expect(log).toEqual(['mount', 'unmount']);
  });
});

describe('worlds (transition writes, folds, render passes)', () => {
  const LANE_SYNC = 1;
  const LANE_T = 2;

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

  test('transition write: head sees it, base does not, fold converges', () => {
    const a = new Atom({ state: 1 });
    const c = new Computed({ fn: () => a.state * 10 });
    expect(c.state).toBe(10);

    withLane(LANE_T, true, () => {
      a.set(2);
    });
    expect(isForked()).toBe(true);

    // Non-render reads see head (latest).
    expect(a.state).toBe(2);
    expect(c.state).toBe(20);

    // A render world that excludes the transition lane sees committed state.
    const urgentWorld = makeWorld(LANE_SYNC, currentWriteSeq());
    const prev = setAmbientWorld(urgentWorld);
    try {
      expect(a.state).toBe(1);
      expect(c.state).toBe(10);
    } finally {
      setAmbientWorld(prev);
    }

    // A render world that includes the transition lane sees the new value.
    const transitionWorld = makeWorld(LANE_T, currentWriteSeq());
    const prev2 = setAmbientWorld(transitionWorld);
    try {
      expect(a.state).toBe(2);
      expect(c.state).toBe(20);
    } finally {
      setAmbientWorld(prev2);
    }

    // Commit: fold the transition lane.
    fold((entry) => entry.lane === LANE_T);
    expect(isForked()).toBe(false);
    expect(a.state).toBe(2);
    expect(c.state).toBe(20);
  });

  test('effects observe committed state only (run at fold, not at write)', () => {
    const a = new Atom({ state: 1 });
    const seen: number[] = [];
    effect(() => {
      seen.push(a.state);
    });
    expect(seen).toEqual([1]);

    withLane(LANE_T, true, () => {
      a.set(2);
    });
    expect(seen).toEqual([1]); // pending transition: effect not yet re-run

    fold((entry) => entry.lane === LANE_T);
    expect(seen).toEqual([1, 2]); // committed now
  });

  test('urgent write interleaved with pending transition (rebase)', () => {
    const a = new Atom({ state: 0 }); // touched by transition
    const b = new Atom({ state: 0 }); // touched by urgent write
    const sum = new Computed({ fn: () => a.state + b.state * 100 });
    expect(sum.state).toBe(0);

    withLane(LANE_T, true, () => {
      a.set(1);
    });
    withLane(LANE_SYNC, false, () => {
      b.set(1);
    });

    // Urgent render: sees b=1, not a=1.
    const urgentWorld = makeWorld(LANE_SYNC, currentWriteSeq());
    let prev = setAmbientWorld(urgentWorld);
    try {
      expect(sum.state).toBe(100);
    } finally {
      setAmbientWorld(prev);
    }

    // Transition render after the urgent commit: sees both (rebased).
    fold((entry) => entry.lane === LANE_SYNC);
    const transitionWorld = makeWorld(LANE_T, currentWriteSeq());
    prev = setAmbientWorld(transitionWorld);
    try {
      expect(sum.state).toBe(101);
    } finally {
      setAmbientWorld(prev);
    }

    fold((entry) => entry.lane === LANE_T);
    expect(sum.state).toBe(101);
  });

  test('dependency sets can differ between planes without missing updates', () => {
    // c reads b only in the committed world; a transition changed the branch.
    const a = new Atom({ state: 1 });
    const b = new Atom({ state: 5 });
    const c = new Computed({ fn: () => (a.state <= 1 ? b.state : 0) });
    const changes: number[] = [];
    effect(() => {
      changes.push(c.state);
    });
    expect(changes).toEqual([5]);

    withLane(LANE_T, true, () => {
      a.set(2); // head world: c no longer depends on b
    });
    withLane(LANE_SYNC, false, () => {
      b.set(6); // committed world: c must update to 6
    });
    fold((entry) => entry.lane === LANE_SYNC);
    // Committed world: a=1, b=6 → c=6.
    expect(changes[changes.length - 1]).toBe(6);

    fold((entry) => entry.lane === LANE_T);
    // Now a=2 committed → c=0.
    expect(changes[changes.length - 1]).toBe(0);
  });

  test('a pinned render pass is isolated from later writes', () => {
    const a = new Atom({ state: 1 });
    setWriteLaneProvider(() => ({ lane: LANE_SYNC, transition: false }));
    try {
      a.set(2);
      const pin = currentWriteSeq();
      pinRenderPass(pin);
      const world = makeWorld(LANE_SYNC, pin);

      a.set(3); // lands after the pass pinned
      const prev = setAmbientWorld(world);
      try {
        expect(a.state).toBe(2); // pass still sees its own snapshot
      } finally {
        setAmbientWorld(prev);
      }
      expect(a.state).toBe(3); // head read outside the pass
      unpinRenderPass(pin);
    } finally {
      setWriteLaneProvider(null);
    }
  });
});
