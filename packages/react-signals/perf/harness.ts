/**
 * Profiling harness: long-running, allocation-realistic workloads over the
 * core engine, sized so hot paths dominate a CPU/heap profile (the
 * js-reactivity-benchmark cases finish in milliseconds — too quick to
 * profile). Run directly with Node's native type stripping:
 *
 *   node perf/harness.ts <scenario> [seconds]
 *
 * Scenarios:
 *   steady     — classic signals traffic: writes through a computed layer
 *                into effects; the everyday hot path.
 *   deep       — one 400-deep computed chain, write→pull cycles.
 *   forked     — `steady`, but with a never-retiring deferred batch pending,
 *                so every operation takes the two-plane paths.
 *   handler    — the zero-allocation claim: plain set() calls with live
 *                subscriptions and a write-batch provider, no fork, no pins
 *                (mimics an event handler writing signals).
 *   worldreads — render-world reads: pinned pass worlds resolving atoms and
 *                computeds through the log replay path.
 *   retire     — write-in-batch → retire cycles (commit-shaped traffic).
 */

import {
  Atom,
  Computed,
  effect,
  batch,
} from '../src/core/index.ts';
import {
  setWriteBatchProvider,
  setAmbientWorld,
  pinRenderPass,
  unpinRenderPass,
  retireBatch,
  createRenderWorld,
  currentWriteSeq,
  createWatcher,
  subscribeTo,
  disposeWatcher,
  WATCHER_SUBSCRIPTION,
  type BatchToken,
} from '../src/core/engine.ts';

const scenario = process.argv[2] ?? 'steady';
const seconds = Number(process.argv[3] ?? '10');

function run(name: string, iterate: () => void): void {
  // Warmup, then run for the target duration.
  for (let i = 0; i < 5_000; i++) iterate();
  const start = performance.now();
  const deadline = start + seconds * 1000;
  let iterations = 0;
  while (performance.now() < deadline) {
    // Batch iterations between clock checks to keep timer overhead out of
    // the profile.
    for (let i = 0; i < 1_000; i++) iterate();
    iterations += 1_000;
  }
  const elapsed = (performance.now() - start) / 1000;
  const opsPerSec = Math.round(iterations / elapsed);
  console.log(`${name}: ${iterations} iterations in ${elapsed.toFixed(1)}s = ${opsPerSec} ops/s`);
}

/** Two computed layers over `width` atoms, all observed by effects. The
 * effects keep the whole graph live; only the writable sources are needed. */
function buildGraph(width: number): Atom<number>[] {
  const sources = Array.from({ length: width }, (_, i) => new Atom({ state: i }));
  const layer1 = sources.map(
    (s, i) => new Computed({ fn: () => s.state + sources[(i + 1) % width]!.state }),
  );
  const layer2 = layer1.map(
    (c, i) => new Computed({ fn: () => c.state * 2 + layer1[(i + 1) % width]!.state }),
  );
  let sink = 0;
  for (const c of layer2) effect(() => void (sink += c.state as number));
  return sources;
}

/** Runs `write` attributed to `token`, as the React provider would. */
function writeInBatch(token: BatchToken, write: () => void): void {
  setWriteBatchProvider(() => token);
  try {
    write();
  } finally {
    setWriteBatchProvider(null);
  }
}

switch (scenario) {
  case 'steady': {
    const sources = buildGraph(50);
    let n = 0;
    run('steady', () => {
      batch(() => {
        sources[n % 50]!.set(n);
        sources[(n + 7) % 50]!.set(n + 1);
      });
      n++;
    });
    break;
  }

  case 'deep': {
    const head = new Atom({ state: 0 });
    let prev: { state: number } = head;
    for (let i = 0; i < 400; i++) {
      const dep = prev;
      prev = new Computed({ fn: () => (dep.state as number) + 1 });
    }
    const tail = prev as Computed<number>;
    const dispose = effect(() => void tail.state);
    let n = 0;
    run('deep', () => {
      head.set(n++);
    });
    dispose();
    break;
  }

  case 'forked': {
    // Enter forked mode permanently: one deferred write that never retires.
    const pin = new Atom({ state: 0 });
    const deferredBatch: BatchToken = { deferred: true };
    writeInBatch(deferredBatch, () => pin.set(1));
    const sources = buildGraph(50);
    let n = 0;
    run('forked', () => {
      batch(() => {
        sources[n % 50]!.set(n);
        sources[(n + 7) % 50]!.set(n + 1);
      });
      n++;
    });
    break;
  }

  case 'handler': {
    // The event-handler shape: subscriptions live, provider installed,
    // no fork, no pins. This is the path that must not allocate.
    const a = new Atom({ state: 0 });
    const c = new Computed({ fn: () => (a.state as number) * 2 });
    let notifications = 0;
    const w = createWatcher(WATCHER_SUBSCRIPTION, null, () => void notifications++);
    subscribeTo(w, c.node);
    const immediateBatch: BatchToken = { deferred: false };
    setWriteBatchProvider(() => immediateBatch);
    let n = 0;
    run('handler', () => {
      a.set(n++);
    });
    setWriteBatchProvider(null);
    disposeWatcher(w);
    console.log(`  (${notifications} notifications delivered)`);
    break;
  }

  case 'worldreads': {
    const a = new Atom({ state: 0 });
    const b = new Atom({ state: 100 });
    const sum = new Computed({ fn: () => (a.state as number) + (b.state as number) });
    const dispose = effect(() => void sum.state);
    const deferredBatch: BatchToken = { deferred: true };
    writeInBatch(deferredBatch, () => a.set(1)); // fork; a has a pending deferred entry
    const world = createRenderWorld([deferredBatch], currentWriteSeq());
    pinRenderPass(world.maxSeq);
    run('worldreads', () => {
      const prev = setAmbientWorld(world);
      void a.state;
      void sum.state;
      setAmbientWorld(prev);
    });
    unpinRenderPass(world.maxSeq);
    dispose();
    break;
  }

  case 'retire': {
    const sources = buildGraph(20);
    let n = 0;
    run('retire', () => {
      const token: BatchToken = { deferred: true };
      writeInBatch(token, () => sources[n % 20]!.set(n));
      retireBatch(token);
      n++;
    });
    break;
  }

  default:
    console.error(`unknown scenario: ${scenario}`);
    process.exit(1);
}
