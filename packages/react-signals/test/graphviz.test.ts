import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Atom, Computed, effect } from '../src/core/index.ts';
import {
  setWriteBatchProvider,
  retireBatch,
  isForked,
  type BatchRef,
} from '../src/core/engine.ts';
import { enableTracing, type TracingSession } from '../src/tracing/index.ts';
import { dependencyGraphToDot, traceToDot } from '../src/graphviz/index.ts';

// Fake batch token standing in for the patch's (an opaque BatchRef object).
// Fresh per test so retirement state doesn't leak between tests.
let T_BATCH: BatchRef;
const createdTokens: BatchRef[] = [];
beforeEach(() => {
  T_BATCH = { deferred: true };
  createdTokens.push(T_BATCH);
});

let session: TracingSession | null = null;
afterEach(() => {
  session?.disable();
  session = null;
  setWriteBatchProvider(null);
  // Reconverge if a test left a fork open.
  for (const t of createdTokens.splice(0)) retireBatch(t);
});

describe('dependencyGraphToDot', () => {
  test('renders atoms, computeds, watchers, and edges with names', () => {
    const count = new Atom({ state: 1, label: 'count' });
    const double = new Computed({ fn: () => count.state * 2, label: 'double' });
    const dispose = effect(() => {
      void double.state;
    });

    const dot = dependencyGraphToDot([count]);
    expect(dot).toContain('digraph signals {');
    expect(dot).toContain('Atom count');
    expect(dot).toContain('Computed double');
    expect(dot).toContain('effect');
    // Two edges: count -> double, double -> effect.
    expect(dot.match(/->/g)!.length).toBe(2);
    expect(dot).toContain('shape=box'); // atom
    expect(dot).toContain('shape=ellipse'); // computed
    expect(dot).toContain('shape=diamond'); // watcher
    dispose();
  });

  test('walking from any signal reaches the same graph', () => {
    const a = new Atom({ state: 1, label: 'a' });
    const c = new Computed({ fn: () => a.state + 1, label: 'c' });
    void c.state; // evaluate to establish the link
    const fromAtom = dependencyGraphToDot([a]);
    const fromComputed = dependencyGraphToDot([c]);
    for (const dot of [fromAtom, fromComputed]) {
      expect(dot).toContain('Atom a');
      expect(dot).toContain('Computed c');
    }
  });

  test('while forked, shows both planes and per-plane edges', () => {
    const a = new Atom({ state: 1, label: 'a' });
    const b = new Atom({ state: 5, label: 'b' });
    // Depends on b only while a is 1 or less — dep sets differ per plane.
    const c = new Computed({ fn: () => (a.state <= 1 ? b.state : 0), label: 'c' });
    const dispose = effect(() => {
      void c.state;
    });

    setWriteBatchProvider(() => T_BATCH);
    a.set(2); // fork; HEAD drops the b -> c edge on next head eval
    setWriteBatchProvider(null);
    expect(isForked()).toBe(true);
    void a.state; // head read; re-evaluates c in HEAD without b

    const dot = dependencyGraphToDot([a, b]);
    expect(dot).toContain('forked');
    expect(dot).toContain('COMMITTED: 1 | HEAD: 2'); // atom a shows both planes
    expect(dot).toContain('log: 1 entries');
    dispose();
  });
});

describe('traceToDot', () => {
  test('renders cause chains as edges', () => {
    session = enableTracing();
    const a = new Atom({ state: 1, label: 'a' });
    const c = new Computed({ fn: () => a.state * 2, label: 'c' });
    const dispose = effect(() => {
      void c.state;
    });
    session.clear();
    a.set(2);

    const dot = traceToDot(session.events());
    expect(dot).toContain('digraph trace {');
    expect(dot).toContain('atom-write');
    expect(dot).toContain('Atom a');
    expect(dot).toContain('effect-run');
    // The write is the root cause of the effect run: an edge path exists.
    expect(dot).toMatch(/e\d+ -> e\d+/);
    dispose();
  });

  test('filtering keeps chains connected by routing through hidden events', () => {
    session = enableTracing();
    const a = new Atom({ state: 1, label: 'a' });
    const c = new Computed({ fn: () => a.state * 2, label: 'c' });
    const dispose = effect(() => {
      void c.state;
    });
    session.clear();
    a.set(2);

    const events = session.events();
    const dot = traceToDot(events, { includeTypes: ['atom-write', 'effect-run'] });
    expect(dot).not.toContain('computed-eval');
    const writeEvent = events.find((e) => e.type === 'atom-write')!;
    const runEvent = events.find((e) => e.type === 'effect-run')!;
    // Direct edge from write to effect-run even though intermediates hidden.
    expect(dot).toContain(`e${writeEvent.id} -> e${runEvent.id}`);
    dispose();
  });
});
