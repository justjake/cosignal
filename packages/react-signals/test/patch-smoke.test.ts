// @vitest-environment jsdom
import { expect, test } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

test('external runtime lanes + lifecycle events', async () => {
  const R = React as any;
  const events: string[] = [];
  const unsub = R.unstable_subscribeToExternalRuntime({
    onRenderPassStart: (c: unknown, lanes: number) => events.push(`start:${lanes}`),
    onRenderPassEnd: () => events.push('end'),
    onCommit: (c: unknown, lanes: number, remaining: number) => events.push(`commit:${lanes}:${remaining}`),
    onBeforeMutation: () => events.push('beforeMut'),
    onAfterMutation: () => events.push('afterMut'),
  });

  const urgent = R.unstable_getCurrentUpdateLane();
  expect(R.unstable_isTransitionLane(urgent)).toBe(false);
  let tLane = 0;
  React.startTransition(() => { tLane = R.unstable_getCurrentUpdateLane(); });
  expect(R.unstable_isTransitionLane(tLane)).toBe(true);
  expect(R.unstable_lanesInclude(tLane, tLane)).toBe(true);
  expect(R.unstable_lanesInclude(urgent, tLane)).toBe(false);

  const el = document.createElement('div');
  const root = createRoot(el);
  let renderLanes = -1;
  function App() {
    const ctx = R.unstable_getRenderContext();
    renderLanes = ctx === null ? -1 : ctx.renderLanes;
    return React.createElement('span', null, 'hi');
  }
  await act(async () => { root.render(React.createElement(App)); });
  expect(el.textContent).toBe('hi');
  expect(renderLanes).toBeGreaterThan(0);
  expect(events.some(e => e.startsWith('start:'))).toBe(true);
  expect(events).toContain('end');
  expect(events).toContain('beforeMut');
  expect(events).toContain('afterMut');
  expect(events.some(e => e.startsWith('commit:'))).toBe(true);
  // Bracket ordering: beforeMut before afterMut before commit
  expect(events.indexOf('beforeMut')).toBeLessThan(events.indexOf('afterMut'));
  expect(events.indexOf('afterMut')).toBeLessThanOrEqual(events.indexOf(events.find(e => e.startsWith('commit:'))!));
  unsub();
  console.log('EVENTS:', events.join(' | '));
});
