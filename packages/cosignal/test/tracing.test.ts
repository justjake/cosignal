import { afterEach, describe, expect, test } from 'vitest';
import { Atom, Computed, effect } from '../src/core/index.ts';
import { enableTracing, toChromeTrace, type TracingSession } from '../src/tracing/index.ts';

let session: TracingSession | null = null;
afterEach(() => {
  session?.disable();
  session = null;
});

describe('tracing', () => {
  test('records causality from write to computed eval to effect run', () => {
    session = enableTracing();
    const a = new Atom({ state: 1 });
    const c = new Computed({ fn: () => a.state * 2 });
    const dispose = effect(() => {
      void c.state;
    });

    session.clear();
    a.set(2);

    const events = session.events();
    const types = events.map((e) => e.type);
    expect(types).toContain('atom-write');
    expect(types).toContain('computed-eval');
    expect(types).toContain('effect-run');

    // "Why did my effect re-run?" — its cause chain leads back to the write.
    const effectRun = events.find((e) => e.type === 'effect-run')!;
    const chain = session.causeChain(effectRun);
    expect(chain[0]!.type).toBe('atom-write');
    expect(session.explain(effectRun)).toMatch(/^atom-write → .*effect-run/);

    // Counters answer "how many times".
    expect(session.countsFor(c).evals).toBe(1);
    expect(session.countsFor(a).writes).toBe(1);
    dispose();
  });

  test('zero-overhead when disabled: no events recorded after disable', () => {
    session = enableTracing();
    const a = new Atom({ state: 1 });
    a.set(2);
    expect(session.events().length).toBeGreaterThan(0);
    const s = session;
    s.disable();
    session = null;
    const before = s.events().length;
    a.set(3);
    expect(s.events().length).toBe(before);
  });

  test('live subscription and ring buffer bounds', () => {
    session = enableTracing({ bufferSize: 4 });
    const seen: string[] = [];
    session.subscribe((e) => {
      seen.push(e.type);
    });
    const a = new Atom({ state: 0 });
    for (let i = 1; i <= 10; i++) a.set(i);
    expect(seen.length).toBeGreaterThanOrEqual(10);
    expect(session.events().length).toBeLessThanOrEqual(4);
  });

  test('events carry the node (weakly) and a label snapshot', () => {
    session = enableTracing();
    const a = new Atom({ state: 1, label: 'count' });
    session.clear();
    a.set(2);
    const write = session.events().find((e) => e.type === 'atom-write')!;
    // While the node is alive, both the reference and the snapshot are there.
    // (After collection only nodeLabel survives — not testable without
    // forcing GC, but the materialization path is the same.)
    expect(write.node).toBe(a.node);
    expect(write.nodeLabel).toBe('count');
  });

  test('toChromeTrace produces trace-event JSON', () => {
    session = enableTracing();
    const a = new Atom({ state: 1, label: 'count' });
    const c = new Computed({ fn: () => a.state * 2, label: 'double' });
    const dispose = effect(() => {
      void c.state;
    });
    session.clear();
    a.set(2);
    const trace = toChromeTrace(session.events());
    expect(trace.displayTimeUnit).toBe('ms');
    expect(trace.traceEvents.length).toBe(session.events().length);
    const write = trace.traceEvents.find((e) => e.name === 'atom-write count')!;
    expect(write.ph).toBe('X');
    expect(write.cat).toBe('cosignal');
    expect(typeof write.ts).toBe('number');
    expect(write.args.type).toBe('atom-write');
    // Round-trips through JSON (the file you load into chrome://tracing).
    expect(() => JSON.stringify(trace)).not.toThrow();
    dispose();
  });
});
