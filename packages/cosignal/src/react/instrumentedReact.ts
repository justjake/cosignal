/**
 * The instrumented React build's add-on surface, typed.
 *
 * cosignal requires a React built with concurrency instrumentation
 * (vendor/react branch `react-signals-patch`, built by scripts/build-react.sh):
 * lifecycle events and scheduling queries that let external state coordinate
 * with concurrent rendering — render-pass brackets with included batch
 * tokens, batch retirement, the DOM-mutation window, and write classification
 * (DESIGN.md §6). getInstrumentedReact() returns the ambient React module
 * validated to carry that surface; use it to build your own integrations
 * (e.g. a MutationObserver that ignores React's commits, see
 * test/mutation-observer.test.tsx for the recipe).
 */

import * as React from 'react';
import type { BatchToken } from '../core/engine.ts';

export type { BatchToken };

export type InstrumentedReactListener = {
  /** A render pass began on `container`; `includedBatches` are the tokens of
   * every live batch the pass renders. Passes span yields; a pass ends by
   * completing or restarting. */
  onRenderPassStart?: (
    container: unknown,
    includedBatches: readonly BatchToken[],
  ) => void;
  /** The render pass on `container` completed or was discarded. */
  onRenderPassEnd?: (container: unknown) => void;
  /** React is about to mutate the host tree under `container`. Fires only
   * when there are mutations to apply. */
  onBeforeMutation?: (container: unknown) => void;
  /** React finished mutating the host tree under `container`. */
  onAfterMutation?: (container: unknown) => void;
  /** A batch retired — exactly once per token. `committed` is false only for
   * batches that never produced React work. */
  onBatchRetired?: (token: BatchToken, committed: boolean) => void;
};

export type InstrumentedReact = {
  unstable_subscribeToExternalRuntime(listener: InstrumentedReactListener): () => void;
  /** Non-null while React is rendering on the current thread. */
  unstable_getRenderContext(): null | { container: unknown };
  /** Token identifying the batch a write issued right now belongs to
   * (minted lazily; stable for the batch's life). */
  unstable_getCurrentWriteBatch(): BatchToken;
  /** Would a write right now be deferred (transition-like)? Pure, no minting. */
  unstable_isCurrentWriteDeferred(): boolean;
};

let cached: InstrumentedReact | null = null;

/**
 * The React module in scope, validated to be an instrumented build. Throws
 * if the plain upstream React is loaded instead.
 */
export function getInstrumentedReact(): InstrumentedReact {
  if (cached !== null) return cached;
  const r = React as unknown as InstrumentedReact;
  if (typeof r.unstable_getCurrentWriteBatch !== 'function') {
    throw new Error(
      'cosignal requires an instrumented React build (unstable_getCurrentWriteBatch ' +
        'is missing). See scripts/build-react.sh.',
    );
  }
  cached = r;
  return r;
}
