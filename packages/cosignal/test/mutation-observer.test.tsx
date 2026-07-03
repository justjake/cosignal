// @vitest-environment jsdom
// The MutationObserver-that-ignores-React recipe, built on the instrumented
// build's mutation window (onBeforeMutation/onAfterMutation) via the public
// getInstrumentedReact() accessor: disconnect just before React's commit
// mutation phase (delivering records gathered so far first) and reconnect
// right after.
import { afterEach, expect, test } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getInstrumentedReact } from '../src/index.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function observeMutationsExceptReact(
  target: Node,
  options: MutationObserverInit,
  callback: MutationCallback,
): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(target, options);
  let paused = false;
  const unsubscribe = getInstrumentedReact().unstable_subscribeToExternalRuntime({
    onBeforeMutation() {
      if (paused) return;
      paused = true;
      const pending = observer.takeRecords();
      if (pending.length > 0) callback(pending, observer);
      observer.disconnect();
    },
    onAfterMutation() {
      if (!paused) return;
      paused = false;
      observer.observe(target, options);
    },
  });
  return () => {
    unsubscribe();
    observer.disconnect();
  };
}

test('MutationObserver sees external mutations but not React commits', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  cleanups.push(() => host.remove());

  let setLabel!: (v: string) => void;
  function App() {
    const [label, set] = useState('one');
    setLabel = set;
    return <span>{label}</span>;
  }
  const root: Root = createRoot(host);
  cleanups.push(() => act(() => root.unmount()));
  await act(async () => {
    root.render(<App />);
  });
  expect(host.textContent).toBe('one');

  const records: MutationRecord[] = [];
  const dispose = observeMutationsExceptReact(
    host,
    { childList: true, subtree: true, characterData: true },
    (rs) => {
      records.push(...rs);
    },
  );
  cleanups.push(dispose);

  // React-driven mutation: invisible to the observer.
  await act(async () => {
    setLabel('two');
  });
  await new Promise((r) => setTimeout(r, 0)); // let observer callbacks drain
  expect(host.textContent).toBe('two');
  expect(records).toHaveLength(0);

  // External mutation: observed normally.
  const external = document.createElement('i');
  host.appendChild(external);
  await new Promise((r) => setTimeout(r, 0));
  expect(records.length).toBeGreaterThan(0);
  expect(records.some((r) => Array.from(r.addedNodes).includes(external))).toBe(true);
});
