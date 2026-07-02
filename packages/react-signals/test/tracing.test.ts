import { afterEach, describe, expect, test } from 'vitest';
import { Atom, Computed, effect } from '../src/core/index.ts';
import { enableTracing, type TracingSession } from '../src/tracing/index.ts';

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
    a.state = 2;

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
    a.state = 2;
    expect(session.events().length).toBeGreaterThan(0);
    const s = session;
    s.disable();
    session = null;
    const before = s.events().length;
    a.state = 3;
    expect(s.events().length).toBe(before);
  });

  test('live subscription and ring buffer bounds', () => {
    session = enableTracing({ bufferSize: 4 });
    const seen: string[] = [];
    session.subscribe((e) => {
      seen.push(e.type);
    });
    const a = new Atom({ state: 0 });
    for (let i = 1; i <= 10; i++) a.state = i;
    expect(seen.length).toBeGreaterThanOrEqual(10);
    expect(session.events().length).toBeLessThanOrEqual(4);
  });
});
