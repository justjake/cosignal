/**
 * Tracing hook slot.
 *
 * The core emits events through `tracer` when (and only when) a tracer is
 * installed by the lazy `react-signals/tracing` module. Every emit site is
 * guarded by a null check, so the cost of tracing when disabled is one
 * comparison. Do not import the tracing module from core code.
 *
 * Causality: every event carries the id of the event that caused it.
 * The core maintains `currentCause` (the innermost in-flight event id) so
 * emit sites don't thread ids by hand; the tracing module assigns ids.
 */

export type TraceEventType =
  | 'atom-write'
  | 'atom-observed'
  | 'atom-unobserved'
  | 'computed-eval'
  | 'invalidate'
  | 'notify'
  | 'effect-run'
  | 'fold'
  | 'render-read'
  | 'suspend'
  | 'settle';

export type TraceEvent = {
  id: number;
  cause: number;
  type: TraceEventType;
  /** Millisecond timestamp assigned by the tracer. */
  time: number;
  /** The node the event concerns, when applicable. */
  node?: unknown;
  /** Free-form details; shape depends on `type`. Documented in src/tracing. */
  data?: unknown;
};

export type Tracer = {
  /** Returns the id assigned to the event so callers can scope children. */
  emit(type: TraceEventType, cause: number, node?: unknown, data?: unknown): number;
};

export let tracer: Tracer | null = null;

/** Id of the in-flight event that new events should name as their cause. */
export let currentCause = 0;

export function setTracer(next: Tracer | null): void {
  tracer = next;
}

/**
 * Runs `fn` with `currentCause` set to `cause`, restoring the previous cause
 * after. Used around evaluation/notification boundaries.
 */
export function setCurrentCause(cause: number): number {
  const prev = currentCause;
  currentCause = cause;
  return prev;
}
