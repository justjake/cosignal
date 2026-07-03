/**
 * Glue between React's external-runtime channel (our patch, see DESIGN.md §6)
 * and the engine's world model:
 *
 * - render passes → RenderWorld objects (pinned views for consistent reads);
 * - writes → batch tokens via unstable_getCurrentWriteBatch;
 * - batch retirement → engine retirement (fold into committed state).
 *
 * The protocol is entirely in terms of opaque batch tokens — no lane bits
 * cross into userspace (see test/patch-contract.test.tsx for the contract).
 * Installed lazily the first time a hook subscribes; the engine stays
 * plain-signals until a component actually subscribes.
 */

import { startTransition } from 'react';
import {
  type RenderWorld,
  type BatchRef,
  createRenderWorld,
  isForked,
  hasActivePins,
  setWriteBatchProvider,
  setAmbientWorld,
  setRenderGuard,
  pinRenderPass,
  unpinRenderPass,
  retireBatch,
  flushEffects,
  currentWriteSeq,
  config,
} from '../core/engine.ts';
import { batch, wasExplicitlyConfigured } from '../core/api.ts';
import { getInstrumentedReact } from './instrumentedReact.ts';

let installed = false;
/** Component subscriptions + signal effects currently live. Gates write logging. */
let consumerCount = 0;
/** Render worlds for in-flight passes, keyed by root container. */
const worldsByContainer = new Map<unknown, RenderWorld>();

const EMPTY_BATCHES: readonly BatchRef[] = [];

export function addConsumer(): void {
  ensureInstalled();
  consumerCount++;
}

export function removeConsumer(): void {
  consumerCount--;
}

export function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  const R = getInstrumentedReact();

  // Raw `atom.state` reads in render bodies are not reactive and bypass the
  // render's world; catch them in development unless the app opted out.
  setRenderGuard(() => R.unstable_getRenderContext() !== null);
  if (
    !wasExplicitlyConfigured('throwOnUntrackedReadsInRender') &&
    typeof process !== 'undefined' &&
    process.env.NODE_ENV !== 'production'
  ) {
    config.throwOnUntrackedReadsInRender = true;
  }

  setWriteBatchProvider(() => {
    if (consumerCount === 0) return null;
    // Observability gate, applied BEFORE minting (design-note invariant #2):
    // an immediate write with no fork pending and no render pass pinned
    // needs no bookkeeping — classify (side-effect-free) and skip the token
    // entirely, so plain event-handler writes allocate nothing anywhere.
    if (!R.unstable_isCurrentWriteDeferred() && !isForked() && !hasActivePins()) {
      return null;
    }
    return R.unstable_getCurrentWriteBatch();
  });

  R.unstable_subscribeToExternalRuntime({
    onRenderPassStart(container, includedBatches) {
      const previous = worldsByContainer.get(container);
      if (previous !== undefined) unpinRenderPass(previous.maxSeq);
      const world = createRenderWorld(includedBatches, currentWriteSeq());
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
    onBatchRetired(token) {
      // Exactly once per batch, at the moment React's own books change —
      // commits and unmount-discarded work alike (see patch-contract tests).
      // The effect flush is deferred to a microtask so user effect code never
      // runs inside React's commit phase; nothing else is held open, so
      // post-commit synchronous writes keep their own delivery context.
      retireBatch(token, true);
      queueMicrotask(flushEffects);
    },
  });
}

/**
 * The world for the render pass currently executing, if any. Falls back to
 * creating one on the fly when a pass began before the bindings installed
 * (first-ever render); such a world can't know its included batches, which
 * is harmless — no signal writes can predate the first subscription.
 */
export function currentRenderWorld(): RenderWorld | null {
  if (!installed) return null;
  const ctx = getInstrumentedReact().unstable_getRenderContext();
  if (ctx === null) return null;
  let world = worldsByContainer.get(ctx.container);
  if (world === undefined) {
    world = createRenderWorld(EMPTY_BATCHES, currentWriteSeq());
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

/**
 * startTransition + batch: signal writes inside `scope` ride the transition
 * batch AND coalesce into (at most) one notification per subscription instead
 * of one per write. Async scopes work like React's startTransition — the
 * batch covers the synchronous part; writes after an `await` need their own
 * startSignalTransition, the same rule React applies to setState.
 */
export function startSignalTransition(scope: () => void | Promise<void>): void {
  startTransition(() => batch(scope) as void | Promise<void>);
}
