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
  Signal,
  ConfigureOptions,
} from './core/index.ts';

export { useSignal } from './react/useSignal.ts';
export { useComputed } from './react/useComputed.ts';
export { useSignalEffect } from './react/useSignalEffect.ts';
export { observeMutationsExceptReact } from './react/dom.ts';
