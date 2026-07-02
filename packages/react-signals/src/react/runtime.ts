/**
 * Glue between React's external-runtime channel (our patch, see DESIGN.md §6)
 * and the engine's world model:
 *
 * - render passes → RenderWorld objects (pinned views for consistent reads);
 * - writes → lane attribution via unstable_getCurrentUpdateLane;
 * - commits → fold pending writes into committed state and flush effects.
 *
 * Installed lazily the first time a hook subscribes. Everything is inert for
 * apps that never use the React bindings, and the engine stays plain-signals
 * (no write log, no forking) until a component actually subscribes.
 */

import * as React from 'react';
import {
  type RenderWorld,
  setWriteLaneProvider,
  setAmbientWorld,
  pinRenderPass,
  unpinRenderPass,
  fold,
  startBatch,
  endBatch,
  currentWriteSeq,
} from '../core/engine.ts';

type PatchedReact = {
  unstable_subscribeToExternalRuntime(listener: {
    onRenderPassStart?: (container: unknown, renderLanes: number) => void;
    onRenderPassEnd?: (container: unknown) => void;
    onCommit?: (container: unknown, committedLanes: number, remainingLanes: number) => void;
  }): () => void;
  unstable_getRenderContext(): null | { container: unknown; renderLanes: number };
  unstable_getCurrentUpdateLane(): number;
  unstable_isTransitionLane(lane: number): boolean;
  unstable_lanesInclude(lanes: number, lane: number): boolean;
};

function patchedReact(): PatchedReact {
  const r = React as unknown as PatchedReact;
  if (typeof r.unstable_subscribeToExternalRuntime !== 'function') {
    throw new Error(
      'react-signals requires the patched React build (unstable_subscribeToExternalRuntime ' +
        'is missing). See scripts/build-react.sh.',
    );
  }
  return r;
}

let installed = false;
/** Component subscriptions + signal effects currently live. Gates write logging. */
let consumerCount = 0;
/** Render worlds for in-flight passes, keyed by root container. */
const worldsByContainer = new Map<unknown, RenderWorld>();
/** Last known pending lanes per container; drives abandoned-lane sweeping. */
const pendingLanesByContainer = new Map<unknown, number>();

export function addConsumer(): void {
  ensureInstalled();
  consumerCount++;
}

export function removeConsumer(): void {
  consumerCount--;
  if (consumerCount === 0) {
    // No React consumer is left; nothing will ever commit pending entries.
    // Promote everything so the engine returns to steady state.
    fold(() => true);
  }
}

export function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  const R = patchedReact();

  setWriteLaneProvider(() => {
    if (consumerCount === 0) return null;
    const lane = R.unstable_getCurrentUpdateLane();
    if (lane === 0) return null;
    return { lane, transition: R.unstable_isTransitionLane(lane) };
  });

  R.unstable_subscribeToExternalRuntime({
    onRenderPassStart(container, renderLanes) {
      const previous = worldsByContainer.get(container);
      if (previous !== undefined) unpinRenderPass(previous.maxSeq);
      const world: RenderWorld = {
        lanes: renderLanes,
        maxSeq: currentWriteSeq(),
        laneIncluded: R.unstable_lanesInclude,
        seesTransitions: null,
      };
      worldsByContainer.set(container, world);
      pinRenderPass(world.maxSeq);
    },
    onRenderPassEnd(container) {
      const world = worldsByContainer.get(container);
      if (world !== undefined) {
        worldsByContainer.delete(container);
        unpinRenderPass(world.maxSeq);
      }
    },
    onCommit(container, committedLanes, remainingLanes) {
      pendingLanesByContainer.set(container, remainingLanes);
      // Fold entries whose lane just committed, plus entries whose lane is no
      // longer pending in any root we know of (their subscribers unmounted or
      // the work was superseded — the write still belongs in committed state,
      // last-write-wins). Defer the effect flush out of React's commit.
      startBatch();
      try {
        fold((entry) => {
          if (R.unstable_lanesInclude(committedLanes, entry.lane)) return true;
          for (const pending of pendingLanesByContainer.values()) {
            if (R.unstable_lanesInclude(pending, entry.lane)) return false;
          }
          return true;
        });
      } finally {
        queueMicrotask(endBatch);
      }
    },
  });
}

/**
 * The world for the render pass currently executing, if any. Falls back to
 * creating one on the fly when a pass began before the bindings installed.
 */
export function currentRenderWorld(): RenderWorld | null {
  if (!installed) return null;
  const ctx = patchedReact().unstable_getRenderContext();
  if (ctx === null) return null;
  let world = worldsByContainer.get(ctx.container);
  if (world === undefined) {
    world = {
      lanes: ctx.renderLanes,
      maxSeq: currentWriteSeq(),
      laneIncluded: patchedReact().unstable_lanesInclude,
      seesTransitions: null,
    };
    worldsByContainer.set(ctx.container, world);
    pinRenderPass(world.maxSeq);
  }
  return world;
}

/** Reads `fn`'s result as of the current render pass's world. */
export function readInRenderWorld<T>(fn: () => T): T {
  const world = currentRenderWorld();
  const prev = setAmbientWorld(world);
  try {
    return fn();
  } finally {
    setAmbientWorld(prev);
  }
}

/** startTransition that works from any context (fixups). */
export function startTransitionSafe(fn: () => void): void {
  React.startTransition(fn);
}
