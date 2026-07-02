/**
 * useComputed — like useMemo, but the component re-renders when a referenced
 * signal's output changes.
 *
 * The callback may close over props and state; anything closed-over belongs
 * in `deps` (useMemo semantics — a deps change swaps in a fresh computed).
 * Signal reads inside the callback are tracked automatically and do NOT
 * belong in `deps`. Options (label, isEqual) are captured alongside the
 * callback and refresh when `deps` change.
 */

import { useMemo } from 'react';
import { Computed, type ComputedCtx, type ComputedOptions } from '../core/api.ts';
import { useSignal } from './useSignal.ts';

export type UseComputedOptions<T> = {
  label?: string;
  /** Cuts off re-renders when the recomputed value is equal. Object.is default. */
  isEqual?: (a: T, b: T) => boolean;
};

export function useComputed<T>(
  fn: (ctx: ComputedCtx<T>) => T,
  deps: readonly unknown[],
  options?: UseComputedOptions<T>,
): T {
  // A Computed is inert until read, so creating one during render is pure;
  // computeds from discarded renders are never subscribed and get collected.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const computed = useMemo(() => {
    const init: ComputedOptions<T> = { fn };
    if (options?.label !== undefined) init.label = options.label;
    if (options?.isEqual !== undefined) init.isEqual = options.isEqual;
    return new Computed<T>(init);
  }, deps);
  return useSignal(computed);
}
