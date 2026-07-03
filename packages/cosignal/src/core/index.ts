/**
 * cosignal/core — the framework-agnostic reactive graph.
 *
 * No React imports anywhere under src/core. The React bindings (src/react)
 * and the benchmark adapter build on this module.
 */

export {
  Atom,
  Computed,
  ReducerAtom,
  effect,
  batch,
  configure,
  untracked,
  startBatch,
  endBatch,
  flushEffects,
  isAtom,
  isComputed,
  SuspendedRead,
  CycleError,
} from './api.ts';

export type {
  AtomOptions,
  AtomCtx,
  ComputedOptions,
  ComputedCtx,
  ReducerAtomOptions,
  Signal,
  ConfigureOptions,
} from './api.ts';

export { setTracer } from './tracing.ts';
export type { Tracer, TraceEvent, TraceEventType } from './tracing.ts';
