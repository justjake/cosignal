/**
 * useComputed — like useMemo, but the component re-renders when a referenced
 * signal's output changes.
 *
 * The callback may close over props and state; anything closed-over belongs
 * in `deps` (useMemo semantics — a deps change swaps in a fresh computed).
 * Signal reads inside the callback are tracked automatically and do NOT
 * belong in `deps`.
 */

import { useMemo } from 'react';
import { Computed, type ComputedCtx } from '../core/api.ts';
import { useSignal } from './useSignal.ts';

export function useComputed<T>(
  fn: (ctx: ComputedCtx<T>) => T,
  deps: readonly unknown[],
): T {
  // A Computed is inert until read, so creating one during render is pure;
  // computeds from discarded renders are never subscribed and get collected.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const computed = useMemo(() => new Computed<T>({ fn }), deps);
  return useSignal(computed);
}
