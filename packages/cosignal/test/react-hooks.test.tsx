// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import * as React from 'react';
import { act, startTransition, useState, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Atom, Computed, useSignal, useComputed, useSignalEffect } from '../src/index.ts';

// ---------------------------------------------------------------------------
// Harness (modeled on react-concurrent-store's suite: real React, jsdom,
// transitions held open by controlled promises, committed-DOM assertions)
// ---------------------------------------------------------------------------

const roots: { root: Root; el: HTMLElement }[] = [];

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push({ root, el });
  // Async act: suspended initial mounts need microtask yields to complete
  // React's SuspendedOnImmediate protocol (sync act leaves the boundary
  // without retry listeners; browsers behave like async act).
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
});

function controlled(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Holds a transition open: updates apply inside, commit waits for resolve. */
function heldTransition(update: () => void): { resolve: () => void } {
  const gate = controlled();
  act(() => {
    startTransition(async () => {
      update();
      await gate.promise;
    });
  });
  return {
    resolve: () => {
      act(async () => {
        gate.resolve();
        await gate.promise;
      });
    },
  };
}

// ---------------------------------------------------------------------------

describe('useSignal basics', () => {
  test('renders atom value and re-renders on write', async () => {
    const count = new Atom({ state: 0 });
    const renders: number[] = [];
    function Counter() {
      const v = useSignal(count);
      renders.push(v);
      return <span>{v}</span>;
    }
    const el = await mount(<Counter />);
    expect(el.textContent).toBe('0');
    await act(async () => {
      count.set(1);
    });
    expect(el.textContent).toBe('1');
    expect(renders).toEqual([0, 1]);
  });

  test('computed with equality cutoff does not re-render subscribers', async () => {
    const n = new Atom({ state: 1 });
    const parity = new Computed({ fn: () => n.state % 2 });
    let renders = 0;
    function Parity() {
      renders++;
      return <span>{useSignal(parity)}</span>;
    }
    const el = await mount(<Parity />);
    expect(el.textContent).toBe('1');
    expect(renders).toBe(1);
    await act(async () => {
      n.set(3); // parity unchanged → no broadcast, no render
    });
    expect(el.textContent).toBe('1');
    expect(renders).toBe(1);
    await act(async () => {
      n.set(4);
    });
    expect(el.textContent).toBe('0');
    expect(renders).toBe(2);
  });

  test('two subscribers of one atom never tear in the committed DOM', async () => {
    const a = new Atom({ state: 0 });
    function Reader({ id }: { id: string }) {
      return <span data-id={id}>{useSignal(a)}</span>;
    }
    const el = await mount(
      <>
        <Reader id="one" />
        <Reader id="two" />
      </>,
    );
    expect(el.textContent).toBe('00');
    await act(async () => {
      a.set(7);
    });
    expect(el.textContent).toBe('77');
  });
});

describe('transitions', () => {
  test('signal + React state update in one transition flip together', async () => {
    const item = new Atom({ state: 'apple' });
    function App() {
      const [label, setLabel] = useState('A');
      const value = useSignal(item);
      return (
        <div>
          <output>{`${label}:${value}`}</output>
          <button
            onClick={() =>
              startTransition(() => {
                item.set('banana');
                setLabel('B');
              })
            }
          />
        </div>
      );
    }
    const el = await mount(<App />);
    expect(el.querySelector('output')!.textContent).toBe('A:apple');
    await act(async () => {
      el.querySelector('button')!.click();
    });
    // Same commit carries both changes — never A:banana or B:apple.
    expect(el.querySelector('output')!.textContent).toBe('B:banana');
  });

  test('held-open transition: committed DOM keeps old values until resolve', async () => {
    const count = new Atom({ state: 1 });
    const double = new Computed({ fn: () => count.state * 2 });
    function App() {
      return <output>{useSignal(double)}</output>;
    }
    const el = await mount(<App />);
    expect(el.textContent).toBe('2');

    const gate = controlled();
    await act(async () => {
      startTransition(async () => {
        count.set(5);
        await gate.promise;
      });
    });
    // Transition pending: committed DOM unchanged; head world advanced.
    expect(el.textContent).toBe('2');
    expect(double.state).toBe(10);

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(el.textContent).toBe('10');
  });

  test('urgent update interleaving a pending transition (rebase semantics)', async () => {
    const a = new Atom({ state: 0 }); // written by the transition
    const b = new Atom({ state: 0 }); // written urgently mid-transition
    const sum = new Computed({ fn: () => a.state + b.state * 100 });
    function App() {
      return <output>{useSignal(sum)}</output>;
    }
    const el = await mount(<App />);
    expect(el.textContent).toBe('0');

    const gate = controlled();
    await act(async () => {
      startTransition(async () => {
        a.set(1);
        await gate.promise;
      });
    });
    expect(el.textContent).toBe('0');

    // Urgent write lands and commits alone: transition's change not shown.
    await act(async () => {
      b.set(1);
    });
    expect(el.textContent).toBe('100');

    // Transition resolves rebased on top of the urgent change.
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(el.textContent).toBe('101');
  });

  test('reader mounting mid-transition shows committed state, then flips with the transition', async () => {
    const a = new Atom({ state: 'old' });
    let mountSecond!: (v: boolean) => void;
    function Reader({ id }: { id: string }) {
      return <span data-id={id}>{useSignal(a)}</span>;
    }
    function App() {
      const [second, setSecond] = useState(false);
      mountSecond = setSecond;
      return (
        <>
          <Reader id="one" />
          {second ? <Reader id="two" /> : null}
        </>
      );
    }
    const el = await mount(<App />);
    expect(el.textContent).toBe('old');

    const gate = controlled();
    await act(async () => {
      startTransition(async () => {
        a.set('new');
        await gate.promise;
      });
    });
    expect(el.textContent).toBe('old');

    // Mount a new reader urgently while the transition is pending: it must
    // agree with the committed world (no tearing against its sibling).
    await act(async () => {
      mountSecond(true);
    });
    expect(el.textContent).toBe('oldold');

    // When the transition lands, both flip together (the late subscriber
    // joined the pending transition via the mount catch-up).
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(el.textContent).toBe('newnew');
  });
});

describe('useComputed', () => {
  test('closes over props and state; re-renders on signal change', async () => {
    const base = new Atom({ state: 10 });
    let bumpOffset!: () => void;
    function App({ factor }: { factor: number }) {
      const [offset, setOffset] = useState(0);
      bumpOffset = () => setOffset((o) => o + 1);
      const value = useComputed(() => base.state * factor + offset, [factor, offset]);
      return <output>{value}</output>;
    }
    const el = await mount(<App factor={2} />);
    expect(el.textContent).toBe('20');
    await act(async () => {
      base.set(11); // signal dep: auto-tracked
    });
    expect(el.textContent).toBe('22');
    await act(async () => {
      bumpOffset(); // closed-over state: via deps
    });
    expect(el.textContent).toBe('23');
  });
});

describe('useSignalEffect', () => {
  test('runs after mount and re-runs on committed signal changes', async () => {
    const a = new Atom({ state: 1 });
    const seen: number[] = [];
    function App() {
      useSignalEffect(() => {
        seen.push(a.state);
      }, []);
      return null;
    }
    await mount(<App />);
    expect(seen).toEqual([1]);
    await act(async () => {
      a.set(2);
    });
    expect(seen).toEqual([1, 2]);
  });

  test('does not observe a pending transition until it commits', async () => {
    const a = new Atom({ state: 1 });
    const seen: number[] = [];
    function App() {
      useSignal(a); // effect-only components never get transition renders
      useSignalEffect(() => {
        seen.push(a.state);
      }, []);
      return null;
    }
    await mount(<App />);
    expect(seen).toEqual([1]);

    const gate = controlled();
    await act(async () => {
      startTransition(async () => {
        a.set(2);
        await gate.promise;
      });
    });
    expect(seen).toEqual([1]); // pending: committed world unchanged
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(seen).toEqual([1, 2]);
  });
});

describe('suspense', () => {
  test('computed suspends via ctx.use; resolves through Suspense', async () => {
    const gate = controlled();
    let resolved: string | null = null;
    const data = gate.promise.then(() => resolved ?? 'data');
    resolved = 'data';
    const c = new Computed<string>({ fn: (ctx) => `got:${ctx.use(data)}` });
    function Content() {
      return <output>{useSignal(c)}</output>;
    }
    const el = await mount(
      <Suspense fallback={<i>loading</i>}>
        <Content />
      </Suspense>,
    );
    expect(el.textContent).toBe('loading');
    await act(async () => {
      gate.resolve();
      await data;
    });
    expect(el.textContent).toBe('got:data');
  });

  test('transition into suspending state keeps old content (no fallback)', async () => {
    const which = new Atom({ state: 'ready' });
    const gate = controlled();
    const slow = gate.promise.then(() => 'slow-data');
    const c = new Computed<string>({
      fn: (ctx) => (which.state === 'ready' ? 'fast-data' : ctx.use(slow)),
    });
    function Content() {
      return <output>{useSignal(c)}</output>;
    }
    const el = await mount(
      <Suspense fallback={<i>loading</i>}>
        <Content />
      </Suspense>,
    );
    expect(el.textContent).toBe('fast-data');

    await act(async () => {
      startTransition(() => {
        which.set('slow');
      });
    });
    // Transition render suspended: old content stays, no fallback.
    expect(el.textContent).toBe('fast-data');

    await act(async () => {
      gate.resolve();
      await slow;
    });
    expect(el.textContent).toBe('slow-data');
  });
});

describe('multiple roots', () => {
  test('two roots share an atom and stay consistent', async () => {
    const a = new Atom({ state: 0 });
    function Reader() {
      return <span>{useSignal(a)}</span>;
    }
    const el1 = await mount(<Reader />);
    const el2 = await mount(<Reader />);
    expect(el1.textContent).toBe('0');
    expect(el2.textContent).toBe('0');
    await act(async () => {
      a.set(3);
    });
    expect(el1.textContent).toBe('3');
    expect(el2.textContent).toBe('3');
  });
});

describe('infinite loop protection', () => {
  test('a layout-effect-write-render loop hits React nested update limit', async () => {
    // Signal writes broadcast through setState, so React's own nested-update
    // counting applies. Layout effects run at sync priority, which is the
    // cascade the NESTED_UPDATE_LIMIT counter deterministically catches
    // (passive-effect loops are throttled across tasks rather than counted).
    const a = new Atom({ state: 0 });
    function App() {
      const v = useSignal(a);
      React.useLayoutEffect(() => {
        a.set(v + 1); // every commit synchronously schedules another
      });
      return <span>{v}</span>;
    }
    const el = document.createElement('div');
    const caught: unknown[] = [];
    const root = createRoot(el, {
      onUncaughtError(error) {
        caught.push(error);
      },
    });
    roots.push({ root, el });
    // The "Maximum update depth exceeded" error surfaces either as an act()
    // rejection or through the root's uncaught-error channel depending on
    // which dispatch trips the counter; accept both.
    try {
      await act(async () => {
        root.render(<App />);
      });
    } catch (error) {
      caught.push(error);
    }
    expect(caught.map(String).join('\n')).toMatch(/Maximum update depth exceeded/);
  });
});
