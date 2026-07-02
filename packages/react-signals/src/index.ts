/**
 * react-signals — concurrent-safe signals for React.
 *
 * Core (framework-agnostic) surface re-exported from ./core; React hooks and
 * DOM helpers from ./react. The lazy tracing module lives at
 * `react-signals/tracing`.
 */

export {
  Atom,
  Computed,
  ReducerAtom,
  effect,
  batch,
  configure,
  untracked,
  isAtom,
  isComputed,
  SuspendedRead,
  CycleError,
} from './core/index.ts';

export type {
  AtomOptions,
  AtomCtx,
  ComputedOptions,
  ComputedCtx,
  ReducerAtomOptions,
  Signal,
  ConfigureOptions,
} from './core/index.ts';

export { useSignal } from './react/useSignal.ts';
export { useComputed, type UseComputedOptions } from './react/useComputed.ts';
export { useSignalEffect } from './react/useSignalEffect.ts';
export { useAtom, useReducerAtom, type UseAtomOptions } from './react/useAtom.ts';
export { startSignalTransition } from './react/runtime.ts';
export { observeMutationsExceptReact } from './react/dom.ts';
