// @vitest-environment jsdom
// Smoke test for the React patch's external-runtime surface: batch-token
// classification/minting and the lifecycle events. The full protocol contract
// (retirement edges, abandonment, merging) lives in patch-contract.test.tsx.
import { expect, test } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

type BatchToken = { deferred: boolean; id: number };

test('external runtime batch tokens + lifecycle events', async () => {
  const R = React as any;
  const events: string[] = [];
  const retired: BatchToken[] = [];
  const unsub = R.unstable_subscribeToExternalRuntime({
    onRenderPassStart: (c: unknown, includedBatches: readonly unknown[]) =>
      events.push(`start:${includedBatches.length}`),
    onRenderPassEnd: () => events.push('end'),
    onBeforeMutation: () => events.push('beforeMut'),
    onAfterMutation: () => events.push('afterMut'),
    onBatchRetired: (token: BatchToken, committed: boolean) => {
      retired.push(token);
      events.push(`retired:${committed}`);
    },
  });

  // Write classification is pure and context-sensitive: immediate outside a
  // transition, deferred inside one.
  expect(R.unstable_isCurrentWriteDeferred()).toBe(false);
  let deferredInTransition = false;
  let t1: BatchToken | null = null;
  let t2: BatchToken | null = null;
  React.startTransition(() => {
    deferredInTransition = R.unstable_isCurrentWriteDeferred();
    t1 = R.unstable_getCurrentWriteBatch();
    t2 = R.unstable_getCurrentWriteBatch();
  });
  expect(deferredInTransition).toBe(true);
  expect(t1).not.toBeNull();
  expect(t1!.deferred).toBe(true);
  expect(t2).toBe(t1); // token identity is stable within the batch

  // A token minted without any React work still retires via the close edge.
  await act(async () => {});
  expect(retired).toContain(t1);

  const el = document.createElement('div');
  const root = createRoot(el);
  let sawRenderContext = false;
  function App() {
    sawRenderContext = R.unstable_getRenderContext() !== null;
    return React.createElement('span', null, 'hi');
  }
  await act(async () => {
    root.render(React.createElement(App));
  });
  expect(el.textContent).toBe('hi');
  expect(sawRenderContext).toBe(true);
  expect(R.unstable_getRenderContext()).toBeNull(); // only during render
  expect(events.some((e) => e.startsWith('start:'))).toBe(true);
  expect(events).toContain('end');
  expect(events).toContain('beforeMut');
  expect(events).toContain('afterMut');
  // Mutation bracket closes before the commit's batches retire.
  expect(events.indexOf('beforeMut')).toBeLessThan(events.indexOf('afterMut'));
  unsub();
});
