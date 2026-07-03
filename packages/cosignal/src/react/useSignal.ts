/**
 * useSignal — subscribe a component to an Atom or Computed, fully
 * concurrent-safely and without useSyncExternalStore.
 *
 * How it stays concurrent-correct (DESIGN.md §2/§4):
 *
 * - The hook's own state is just a version counter. The rendered value is
 *   always read from the graph, resolved against *this render pass's* world
 *   (committed base + the writes this render's lanes include, pinned at pass
 *   start). Mounts inside a transition render therefore read the pending
 *   world directly — no double render, no mount-mid-transition suspense bug.
 * - Writes notify subscribers synchronously in the writer's context, so the
 *   version bump is lane-attributed by React exactly like a setState made
 *   next to the signal write (transition writes ride the transition).
 * - The subscription attaches in a layout effect. Writes racing into the
 *   render→subscribe gap (mount commits only) are patched up there: an
 *   urgent divergence re-renders synchronously before paint; a pending
 *   transition this component wasn't part of is joined via startTransition.
 * - A computed waiting on a promise (ctx.use) surfaces here as SuspendedRead;
 *   we forward the thenable to React's use(), which suspends and replays the
 *   component when it settles (conditional use is legal).
 */

import * as React from 'react';
import { startTransition, useLayoutEffect, useReducer } from 'react';
import type { Atom, Computed } from '../core/api.ts';
import {
  type AtomNode,
  type ComputedNode,
  KIND_ATOM,
  WATCHER_SUBSCRIPTION,
  PLANE_COMMITTED,
  PLANE_HEAD,
  createWatcher,
  subscribeTo,
  disposeWatcher,
  readAtom,
  readComputed,
  peekNodeValue,
  isForked,
  SuspendedRead,
} from '../core/engine.ts';
import { addConsumer, removeConsumer, ensureInstalled, readInRenderWorld } from './runtime.ts';

function bump(count: number): number {
  return count + 1;
}

export function useSignal<T>(signal: Atom<T> | Computed<T>): T {
  ensureInstalled();
  const node = signal.node;
  const [, forceUpdate] = useReducer(bump, 0);

  let value: T;
  let suspended: SuspendedRead | null = null;
  try {
    value = readInRenderWorld(() =>
      node.kind === KIND_ATOM
        ? (readAtom(node as AtomNode) as T)
        : (readComputed(node as ComputedNode) as T),
    );
  } catch (e) {
    if (e instanceof SuspendedRead) {
      suspended = e;
    } else {
      throw e; // computed error → nearest error boundary
    }
  }

  useLayoutEffect(() => {
    addConsumer();
    const watcher = createWatcher(WATCHER_SUBSCRIPTION, null, () => forceUpdate());
    subscribeTo(watcher, node);

    // Mount fixup: a write may have landed between this render and now
    // (before the subscription existed). Compare against what was rendered.
    const equal = node.isEqual;
    if (suspended === null) {
      try {
        const base = peekNodeValue(node, PLANE_COMMITTED);
        if (!equal(base, value)) {
          // Urgent divergence: correct before paint (sync lane here).
          forceUpdate();
        } else if (isForked()) {
          const head = peekNodeValue(node, PLANE_HEAD);
          if (!equal(head, base)) {
            // A transition is pending and this component wasn't part of its
            // broadcast; join it so we flip together when it commits.
            startTransition(() => forceUpdate());
          }
        }
      } catch {
        // The node now errors or suspends where it didn't at render time:
        // re-render to surface it through the normal read path.
        forceUpdate();
      }
    }

    return () => {
      disposeWatcher(watcher);
      removeConsumer();
    };
    // The subscription is per-node; value/suspended are intentionally only
    // read on the mount commit for the fixup (later commits have a live
    // subscription covering the gap).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node]);

  if (suspended !== null) {
    // Forward to React's suspense machinery; replays re-read the computed.
    React.use(suspended.thenable as PromiseLike<unknown>);
    // use() always throws for a pending thenable; this is unreachable.
    throw suspended;
  }
  return value!;
}
