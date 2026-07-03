/**
 * cosignal/tracing — lazy-loadable causality tracing.
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

  // Ring buffer: `start` indexes the oldest retained event; eviction is an
  // overwrite + pointer bump, never an array shift. Stored events hold their
  // node through a WeakRef so a long-lived session never pins disposed
  // graphs; the label is snapshotted at emit time so displays survive
  // collection.
  const capacity = options.bufferSize ?? 10_000;
  type StoredEvent = {
    id: number;
    cause: number;
    type: TraceEventType;
    time: number;
    nodeRef: WeakRef<object> | null;
    nodeLabel: string | undefined;
    data: unknown;
  };
  const buffer: (StoredEvent | undefined)[] = [];
  let start = 0;
  let size = 0;
  let dropped = 0;
  const byId = new Map<number, StoredEvent>();
  const listeners = new Set<(event: TraceEvent) => void>();
  let nextId = 1;

  function storedNode(e: StoredEvent): unknown {
    return e.nodeRef !== null ? e.nodeRef.deref() : undefined;
  }

  /** The public view of a stored event (node re-materialized via WeakRef). */
  function toPublic(e: StoredEvent): TraceEvent {
    const out: TraceEvent = { id: e.id, cause: e.cause, type: e.type, time: e.time };
    const node = storedNode(e);
    if (node !== undefined) out.node = node;
    if (e.nodeLabel !== undefined) out.nodeLabel = e.nodeLabel;
    if (e.data !== undefined) out.data = e.data;
    return out;
  }

  /** Retained events, oldest first. */
  function retained(): StoredEvent[] {
    const out: StoredEvent[] = new Array(size);
    for (let i = 0; i < size; i++) out[i] = buffer[(start + i) % capacity]!;
    return out;
  }

  setTracer({
    emit(type, cause, node, data): number {
      const label = (node as { label?: string | null } | undefined)?.label;
      const event: StoredEvent = {
        id: nextId++,
        cause,
        type,
        time: performance.now(),
        nodeRef: typeof node === 'object' && node !== null ? new WeakRef(node) : null,
        nodeLabel: typeof label === 'string' ? label : undefined,
        data,
      };
      if (size < capacity) {
        buffer[(start + size) % capacity] = event;
        size++;
      } else {
        byId.delete(buffer[start]!.id);
        dropped++;
        buffer[start] = event;
        start = (start + 1) % capacity;
      }
      byId.set(event.id, event);
      if (listeners.size > 0) {
        const pub = toPublic(event);
        for (const listener of listeners) listener(pub);
      }
      return event.id;
    },
  });

  function nodeOf<T>(signal: Signal<T>): unknown {
    if (isAtom(signal) || isComputed(signal)) return signal.node;
    return signal;
  }

  function causeChain(event: TraceEvent): TraceEvent[] {
    const chain: TraceEvent[] = [event];
    let cause = event.cause;
    while (cause !== 0) {
      const stored = byId.get(cause);
      if (stored === undefined) break;
      chain.unshift(toPublic(stored));
      cause = stored.cause;
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
      return retained().map(toPublic);
    },
    clear() {
      buffer.length = 0;
      start = 0;
      size = 0;
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
      return retained()
        .filter((e) => storedNode(e) === node)
        .map(toPublic);
    },
    countsFor(signal) {
      const node = nodeOf(signal);
      let evals = 0;
      let notifies = 0;
      let writes = 0;
      for (const e of retained()) {
        if (storedNode(e) !== node) continue;
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

// ---------------------------------------------------------------------------
// Chrome trace export
// ---------------------------------------------------------------------------

/** One event in Chrome's trace-event format (ph "X": complete event). */
export type ChromeTraceEvent = {
  name: string;
  cat: string;
  ph: 'X';
  /** Microseconds. */
  ts: number;
  dur: number;
  pid: number;
  tid: number;
  args: Record<string, unknown>;
};

export type ChromeTraceExport = {
  traceEvents: ChromeTraceEvent[];
  displayTimeUnit: 'ms';
};

/**
 * Converts trace events (from `session.events()`) to Chrome's trace-event
 * JSON format. Write `JSON.stringify(toChromeTrace(session.events()))` to a
 * file and load it in chrome://tracing or https://ui.perfetto.dev to see the
 * session on a zoomable timeline. Our events are instants, so each renders
 * as a zero-duration slice; causality ids ride along in `args`.
 */
export function toChromeTrace(events: readonly TraceEvent[]): ChromeTraceExport {
  const traceEvents: ChromeTraceEvent[] = events.map((e) => ({
    name: e.nodeLabel !== undefined ? `${e.type} ${e.nodeLabel}` : e.type,
    cat: 'cosignal',
    ph: 'X' as const,
    ts: Math.round(e.time * 1000), // ms → µs
    dur: 0,
    pid: 1,
    tid: 1,
    args: { id: e.id, cause: e.cause, type: e.type, node: e.nodeLabel },
  }));
  return { traceEvents, displayTimeUnit: 'ms' };
}
