/**
 * react-signals/tracing — lazy-loadable causality tracing.
 *
 * Nothing in this module is imported by the core or the React bindings; until
 * an app imports it and calls enableTracing(), every trace site in the engine
 * is a single `tracer !== null` check.
 *
 * Every event records the id of the event that caused it, so a trace is a
 * forest of cause chains:
 *
 *   atom-write ──▶ notify (subscription) ──▶ [component re-render]
 *              └─▶ computed-eval ──▶ effect-run
 *
 * "Why did my computed re-run?" = walk the chain from its computed-eval event
 * back to the originating write. "How many times did my effect run?" = count
 * its effect-run events. The event log is a bounded ring buffer; a live
 * subscription feeds devtools-style consumers (the planned Chrome extension
 * renders these as a filterable timeline).
 */

import { setTracer, type TraceEvent, type TraceEventType } from '../core/tracing.ts';
import { isAtom, isComputed, type Signal } from '../core/api.ts';

export type { TraceEvent, TraceEventType };

export type TracingSession = {
  /** Stop recording and uninstall the tracer. */
  disable(): void;
  /** Events currently retained (oldest first). */
  events(): TraceEvent[];
  /** Remove all retained events. */
  clear(): void;
  /** Live event stream; returns an unsubscribe function. */
  subscribe(listener: (event: TraceEvent) => void): () => void;
  /** The chain of events that caused `event`, outermost cause first. */
  causeChain(event: TraceEvent): TraceEvent[];
  /** Events concerning one signal (its node), oldest first. */
  eventsFor<T>(signal: Signal<T>): TraceEvent[];
  /** Quick counters answering "how many times did X happen to this signal". */
  countsFor<T>(signal: Signal<T>): { evals: number; notifies: number; writes: number };
  /** Human-readable one-line explanation of an event and its cause chain. */
  explain(event: TraceEvent): string;
};

export type TracingOptions = {
  /** Ring buffer capacity. Default 10_000 events. */
  bufferSize?: number;
};

let active = false;

export function enableTracing(options: TracingOptions = {}): TracingSession {
  if (active) {
    throw new Error('Tracing is already enabled; disable the previous session first.');
  }
  active = true;

  const capacity = options.bufferSize ?? 10_000;
  const buffer: TraceEvent[] = [];
  let dropped = 0;
  const byId = new Map<number, TraceEvent>();
  const listeners = new Set<(event: TraceEvent) => void>();
  let nextId = 1;

  setTracer({
    emit(type, cause, node, data): number {
      const event: TraceEvent = {
        id: nextId++,
        cause,
        type,
        time: performance.now(),
        node,
        data,
      };
      buffer.push(event);
      byId.set(event.id, event);
      if (buffer.length > capacity) {
        const evicted = buffer.splice(0, buffer.length - capacity);
        dropped += evicted.length;
        for (const e of evicted) byId.delete(e.id);
      }
      for (const listener of listeners) listener(event);
      return event.id;
    },
  });

  function nodeOf<T>(signal: Signal<T>): unknown {
    if (isAtom(signal) || isComputed(signal)) return signal.node;
    return signal;
  }

  function causeChain(event: TraceEvent): TraceEvent[] {
    const chain: TraceEvent[] = [];
    let current: TraceEvent | undefined = event;
    while (current !== undefined) {
      chain.unshift(current);
      current = current.cause !== 0 ? byId.get(current.cause) : undefined;
    }
    return chain;
  }

  const session: TracingSession = {
    disable() {
      active = false;
      setTracer(null);
      listeners.clear();
    },
    events() {
      return buffer.slice();
    },
    clear() {
      buffer.length = 0;
      byId.clear();
      dropped = 0;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    causeChain,
    eventsFor(signal) {
      const node = nodeOf(signal);
      return buffer.filter((e) => e.node === node);
    },
    countsFor(signal) {
      const node = nodeOf(signal);
      let evals = 0;
      let notifies = 0;
      let writes = 0;
      for (const e of buffer) {
        if (e.node !== node) continue;
        if (e.type === 'computed-eval' || e.type === 'effect-run') evals++;
        else if (e.type === 'notify') notifies++;
        else if (e.type === 'atom-write') writes++;
      }
      return { evals, notifies, writes };
    },
    explain(event) {
      const chain = causeChain(event);
      const parts = chain.map((e) => e.type);
      const truncated = dropped > 0 && chain[0]!.cause !== 0;
      return (
        (truncated ? '[cause evicted from buffer] … ' : '') +
        parts.join(' → ') +
        ` (#${event.id})`
      );
    },
  };
  return session;
}
