/**
 * DOM helpers built on the patch's mutation-window events.
 */

import * as React from 'react';

type PatchedReact = {
  unstable_subscribeToExternalRuntime(listener: {
    onBeforeMutation?: (container: unknown) => void;
    onAfterMutation?: (container: unknown) => void;
  }): () => void;
};

/**
 * Observes DOM mutations under `target` while ignoring the mutations React
 * itself applies during commits: the observer disconnects just before React's
 * commit mutation phase and reconnects right after, delivering any records
 * gathered up to the pause first.
 *
 * Scope: this covers React's reconciliation mutations. DOM changes made by
 * user code in effects, by imperative ReactDOM APIs (preload/preinit), or by
 * the View Transition name bookkeeping still deliver normally — those are not
 * part of the bracketed window (see DESIGN.md §6.2).
 *
 * Returns a dispose function.
 */
export function observeMutationsExceptReact(
  target: globalThis.Node,
  options: MutationObserverInit,
  callback: MutationCallback,
): () => void {
  const R = React as unknown as PatchedReact;
  if (typeof R.unstable_subscribeToExternalRuntime !== 'function') {
    throw new Error(
      'observeMutationsExceptReact requires the patched React build ' +
        '(unstable_subscribeToExternalRuntime is missing).',
    );
  }
  const observer = new MutationObserver(callback);
  observer.observe(target, options);
  let paused = false;

  const unsubscribe = R.unstable_subscribeToExternalRuntime({
    onBeforeMutation() {
      // Pause for every root's commit: cheap, and correct even with portals
      // rendering into subtrees owned by other roots.
      if (paused) return;
      paused = true;
      const pending = observer.takeRecords();
      if (pending.length > 0) callback(pending, observer);
      observer.disconnect();
    },
    onAfterMutation() {
      if (!paused) return;
      paused = false;
      observer.observe(target, options);
    },
  });

  return () => {
    unsubscribe();
    observer.disconnect();
  };
}
