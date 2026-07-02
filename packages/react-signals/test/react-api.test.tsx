// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import * as React from 'react';
import { act, startTransition, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { batch } from '../src/core/index.ts';
import {
  Atom,
  ReducerAtom,
  Computed,
  configure,
  useSignal,
  useAtom,
  useReducerAtom,
  startSignalTransition,
} from '../src/index.ts';
import {
  setWriteLaneProvider,
  fold,
  setAmbientWorld,
  createWatcher,
  subscribeTo,
  disposeWatcher,
  WATCHER_SUBSCRIPTION,
  currentWriteSeq,
  type RenderWorld,
} from '../src/core/engine.ts';

const roots: { root: Root; el: HTMLElement }[] = [];
async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push({ root, el });
  await act(async () => {
    root.render(node);
  });
  return el;
}
afterEach(async () => {
  for (const { root, el } of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    el.remove();
  }
  setWriteLaneProvider(null);
  fold(() => true);
});

function controlled(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const LANE_SYNC = 1;
const LANE_T = 2;
function makeWorld(lanes: number): RenderWorld {
  return {
    lanes,
    maxSeq: currentWriteSeq(),
    laneIncluded: (l, lane) => (l & lane) !== 0,
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
function readInWorld<T>(world: RenderWorld, fn: () => T): T {
  const prev = setAmbientWorld(world);
  try {
    return fn();
  } finally {
    setAmbientWorld(prev);
  }
}

describe('functional updates rebase like React setState (engine level)', () => {
  test('urgent updater interleaving a transition updater replays on both timelines', () => {
    const a = new Atom({ state: 1 });
    // Subscribe so writes are logged (consumer gating is in the bindings;
    // at engine level the lane provider is enough).
    withLane(LANE_T, true, () => {
      a.update((x) => x + 1); // transition: +1
    });
    withLane(LANE_SYNC, false, () => {
      a.update((x) => x * 2); // urgent: *2, must apply to base 1 NOW
    });

    // Urgent world: transition excluded → 1 * 2 = 2.
    expect(readInWorld(makeWorld(LANE_SYNC), () => a.state)).toBe(2);
    // Head (both applied in write order): (1 + 1) * 2 = 4.
    expect(a.state).toBe(4);

    // Urgent commit folds first: committed = 2.
    fold((e) => (e.lane & LANE_SYNC) !== 0);
    expect(readInWorld(makeWorld(LANE_SYNC), () => a.state)).toBe(2);

    // Transition commits: its +1 lands FIRST in write order, and the urgent
    // *2 REPLAYS on top — committed becomes (1+1)*2 = 4, not 2 and not 3.
    fold(() => true);
    expect(readInWorld(makeWorld(LANE_SYNC), () => a.state)).toBe(4);
    expect(a.state).toBe(4);
  });

  test('an older transition fold cannot roll back or clobber newer updates', () => {
    const a = new Atom({ state: 1 });
    withLane(LANE_T, true, () => {
      a.set(10);
    });
    withLane(LANE_SYNC, false, () => {
      a.update((x) => x + 1); // applies to 1 → committed 2
    });
    expect(readInWorld(makeWorld(LANE_SYNC), () => a.state)).toBe(2);
    fold((e) => (e.lane & LANE_SYNC) !== 0);
    // Transition folds after: set 10, then the +1 replays on top → 11.
    fold(() => true);
    expect(a.state).toBe(11);
  });

  test('ReducerAtom dispatch rebases actions', () => {
    const counter = new ReducerAtom<number, 'inc' | 'double'>({
      state: 1,
      reduce: (s, action) => (action === 'inc' ? s + 1 : s * 2),
    });
    withLane(LANE_T, true, () => {
      counter.dispatch('inc');
    });
    withLane(LANE_SYNC, false, () => {
      counter.dispatch('double');
    });
    expect(readInWorld(makeWorld(LANE_SYNC), () => counter.state)).toBe(2);
    expect(counter.state).toBe(4); // head
    fold((e) => (e.lane & LANE_SYNC) !== 0);
    fold(() => true);
    expect(counter.state).toBe(4); // (1+1)*2, matching useReducer
  });
});

describe('ReducerAtom matches useReducer through a real interleaving', () => {
  test('side by side: same reducer, same dispatches, same committed values', async () => {
    type Action = 'inc' | 'double';
    const reduce = (s: number, action: Action) => (action === 'inc' ? s + 1 : s * 2);
    const atom = new ReducerAtom<number, Action>({ state: 1, reduce });

    let reactDispatch!: (a: Action) => void;
    function App() {
      const [reactState, dispatch] = useReducer(reduce, 1);
      reactDispatch = dispatch;
      const atomState = useSignal(atom);
      return <output>{`${reactState}:${atomState}`}</output>;
    }
    const el = await mount(<App />);
    expect(el.textContent).toBe('1:1');

    const gate = controlled();
    await act(async () => {
      startTransition(async () => {
        reactDispatch('inc');
        atom.dispatch('inc');
        await gate.promise;
      });
    });
    // Transition pending: both committed values unchanged.
    expect(el.textContent).toBe('1:1');

    // Urgent dispatches interleave.
    await act(async () => {
      reactDispatch('double');
      atom.dispatch('double');
    });
    // Both rebase the same way: urgent render shows 1*2 = 2 for each.
    expect(el.textContent).toBe('2:2');

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    // Transition lands: both replay 'double' on top of 'inc' → (1+1)*2 = 4.
    expect(el.textContent).toBe('4:4');
  });
});

describe('useAtom / useReducerAtom', () => {
  test('useAtom creates once, supports lazy init, reads via useSignal', async () => {
    let inits = 0;
    let bump!: () => void;
    function App() {
      const count = useAtom(() => {
        inits++;
        return 5;
      });
      const v = useSignal(count);
      bump = () => count.update((x) => x + 1);
      return <output>{v}</output>;
    }
    const el = await mount(<App />);
    expect(el.textContent).toBe('5');
    await act(async () => {
      bump();
    });
    expect(el.textContent).toBe('6');
    expect(inits).toBe(1); // lazy init ran exactly once across re-renders
  });

  test('useReducerAtom dispatches through the reducer', async () => {
    let send!: (a: 'inc') => void;
    function App() {
      const counter = useReducerAtom((s: number, _a: 'inc') => s + 1, 0);
      send = (a) => counter.dispatch(a);
      return <output>{useSignal(counter)}</output>;
    }
    const el = await mount(<App />);
    expect(el.textContent).toBe('0');
    await act(async () => {
      send('inc');
      send('inc');
    });
    expect(el.textContent).toBe('2');
  });
});

describe('batching and startSignalTransition', () => {
  test('batch coalesces notifications: N writes, one broadcast', () => {
    const a = new Atom({ state: 1 });
    const b = new Atom({ state: 1 });
    const sum = new Computed({ fn: () => a.state + b.state });
    let notifies = 0;
    const w = createWatcher(WATCHER_SUBSCRIPTION, null, () => {
      notifies++;
    });
    subscribeTo(w, sum.node);
    withLane(LANE_SYNC, false, () => {
      a.set(2);
      b.set(2);
    });
    expect(notifies).toBe(2); // unbatched: one per write

    withLane(LANE_SYNC, false, () => {
      batch(() => {
        a.set(3);
        b.set(3);
      });
    });
    expect(notifies).toBe(3); // batched: exactly one more
    disposeWatcher(w);
  });

  test('startSignalTransition: writes flip together with one commit', async () => {
    const first = new Atom({ state: 'a1' });
    const second = new Atom({ state: 'b1' });
    const renders: string[] = [];
    function App() {
      const f = useSignal(first);
      const s = useSignal(second);
      renders.push(`${f}:${s}`);
      return <output>{`${f}:${s}`}</output>;
    }
    const el = await mount(<App />);
    expect(el.textContent).toBe('a1:b1');
    await act(async () => {
      startSignalTransition(() => {
        first.set('a2');
        second.set('b2');
      });
    });
    expect(el.textContent).toBe('a2:b2');
    // Never rendered a torn combination.
    expect(renders).not.toContain('a2:b1');
    expect(renders).not.toContain('a1:b2');
  });
});

describe('untracked reads during render', () => {
  test('raw atom.state in a render body throws when configured', async () => {
    configure({ throwOnUntrackedReadsInRender: true });
    try {
      const a = new Atom({ state: 1, label: 'raw' });
      const caught: unknown[] = [];
      function Bad() {
        return <span>{a.state}</span>; // raw read, not useSignal
      }
      const el = document.createElement('div');
      const root = createRoot(el, {
        onUncaughtError(error) {
          caught.push(error);
        },
      });
      roots.push({ root, el });
      try {
        await act(async () => {
          root.render(<Bad />);
        });
      } catch (e) {
        caught.push(e);
      }
      expect(caught.map(String).join('\n')).toMatch(/Untracked read of signal raw/);
    } finally {
      configure({ throwOnUntrackedReadsInRender: false });
    }
  });

  test('useSignal reads and event-handler reads are unaffected', async () => {
    configure({ throwOnUntrackedReadsInRender: true });
    try {
      const a = new Atom({ state: 7 });
      let readFromHandler: number | null = null;
      function Good() {
        const v = useSignal(a);
        return (
          <button
            onClick={() => {
              readFromHandler = a.state; // outside render: fine
            }}
          >
            {v}
          </button>
        );
      }
      const el = await mount(<Good />);
      expect(el.textContent).toBe('7');
      await act(async () => {
        el.querySelector('button')!.click();
      });
      expect(readFromHandler).toBe(7);
    } finally {
      configure({ throwOnUntrackedReadsInRender: false });
    }
  });
});
