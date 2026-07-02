/**
 * useSignalEffect — like useEffect, but the effect also re-runs when a
 * referenced signal's (committed) value changes.
 *
 * The effect observes committed state only: writes made inside a transition
 * re-run it when the transition commits, not when the write happens —
 * matching useEffect's after-commit semantics. Re-runs triggered by signal
 * changes flush right after the commit that folded them (microtask); re-runs
 * from `deps` changes follow normal useEffect timing.
 */

import { useEffect } from 'react';
import {
  WATCHER_EFFECT,
  createWatcher,
  disposeWatcher,
  runEffect,
} from '../core/engine.ts';
import { addConsumer, removeConsumer } from './runtime.ts';

export function useSignalEffect(
  effect: () => void | (() => void),
  deps: readonly unknown[],
): void {
  useEffect(() => {
    addConsumer();
    const watcher = createWatcher(WATCHER_EFFECT, effect, null);
    runEffect(watcher);
    return () => {
      disposeWatcher(watcher);
      removeConsumer();
    };
    // `effect` is intentionally captured per deps-change, like useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
