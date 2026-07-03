/**
 * react-signals/graphviz — debug visualizers that emit Graphviz DOT source.
 *
 * Both helpers return a DOT string; render it with any Graphviz tool
 * (`dot -Tsvg graph.dot -o graph.svg`, the `viz-js` package, or an online
 * viewer). We emit DOT rather than Mermaid because real dependency graphs get
 * large, and Graphviz layout handles sizes that crash Mermaid renderers.
 *
 * Module layering (deliberate):
 * - This module imports the engine (already loaded — it *is* the library) and
 *   only the *type* of trace events, which compiles away. Loading it does NOT
 *   load the `react-signals/tracing` recorder.
 * - The tracing module knows nothing about this one. Record events with
 *   `enableTracing()`, hand `session.events()` to `traceToDot` whenever you
 *   feel like looking at them — or never.
 */

import type { TraceEvent, TraceEventType } from '../core/tracing.ts';
import { isAtom, isComputed, type Atom, type Computed } from '../core/api.ts';

/** Any atom or computed, regardless of value type (Atom is invariant in its
 * value type, so `Signal<unknown>` would reject e.g. `Atom<number>`). */
export type AnySignal = Atom<any> | Computed<any>;
import {
  type Node,
  type Link,
  type AtomNode,
  type ComputedNode,
  type WatcherNode,
  KIND_ATOM,
  KIND_COMPUTED,
  WATCHER_EFFECT,
  PLANE_COMMITTED,
  PLANE_HEAD,
  WORLD_COMMITTED,
  WORLD_HEAD,
  STATUS_ERROR,
  STATUS_SUSPENDED,
  F,
  isForked,
} from '../core/engine.ts';

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

/** Escapes a string for use inside a double-quoted DOT label. */
function q(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

function summarize(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : String(value);
  } catch {
    text = '<unprintable>';
  }
  if (typeof value === 'object' && value !== null) {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = Object.prototype.toString.call(value);
    }
  }
  return text.length > 28 ? text.slice(0, 25) + '…' : text;
}

function nodeDisplayName(node: Node | undefined): string {
  if (node === undefined) return '';
  if (node.kind === KIND_ATOM) {
    const atom = node as AtomNode;
    return atom.label !== null ? `Atom ${atom.label}` : 'Atom';
  }
  if (node.kind === KIND_COMPUTED) {
    const c = node as ComputedNode;
    return c.label !== null ? `Computed ${c.label}` : 'Computed';
  }
  const w = node as WatcherNode;
  return w.watcherKind === WATCHER_EFFECT ? 'effect' : 'subscription';
}

// ---------------------------------------------------------------------------
// Dependency graph snapshot
// ---------------------------------------------------------------------------

export type DependencyGraphOptions = {
  /** Graph title rendered above the drawing. */
  title?: string;
};

/**
 * Snapshots the live dependency graph reachable from `signals` (following
 * edges both upstream and downstream) as Graphviz DOT.
 *
 * Reading the output:
 * - Boxes are atoms, ellipses are computeds, diamonds are watchers
 *   (effects / component subscriptions).
 * - Labels show current values. While the engine is forked (a transition
 *   write is pending), atoms and computeds show both planes:
 *   `BASE` (what the screen shows) and `HEAD` (including pending
 *   transitions). Stale-flag markers (`Pending`, `Dirty`, …) appear when set.
 * - While forked, edges are colored by which plane they exist in:
 *   gray = both planes, blue = BASE only, orange dashed = HEAD only
 *   (dependency sets can differ between planes; DESIGN.md §9.3).
 *
 * Reading node values does not disturb the graph: this renders raw fields and
 * never evaluates computeds or commits pending atom writes.
 */
export function dependencyGraphToDot(
  signals: Iterable<AnySignal>,
  options: DependencyGraphOptions = {},
): string {
  const forked = isForked();
  const seen = new Map<Node, string>();
  const links = new Set<Link>();
  const queue: Node[] = [];

  for (const signal of signals) {
    if (isAtom(signal) || isComputed(signal)) queue.push(signal.node);
  }

  while (queue.length > 0) {
    const node = queue.pop()!;
    if (seen.has(node)) continue;
    seen.set(node, `n${seen.size}`);
    for (let l = node.deps; l !== undefined; l = l.nextDep) {
      links.add(l);
      queue.push(l.dep);
    }
    for (let l = node.subs; l !== undefined; l = l.nextSub) {
      links.add(l);
      queue.push(l.sub);
    }
  }

  const lines: string[] = [];
  lines.push('digraph signals {');
  lines.push('  rankdir=LR;');
  lines.push('  node [fontname="monospace", fontsize=10];');
  lines.push('  edge [fontname="monospace", fontsize=8];');
  if (options.title !== undefined) {
    lines.push(`  label="${q(options.title)}"; labelloc=t;`);
  } else if (forked) {
    lines.push('  label="forked: a transition write is pending"; labelloc=t;');
  }

  for (const [node, id] of seen) {
    lines.push(`  ${id} ${nodeAttrs(node, forked)};`);
  }
  for (const link of links) {
    const from = seen.get(link.dep);
    const to = seen.get(link.sub);
    if (from === undefined || to === undefined) continue;
    lines.push(`  ${from} -> ${to} ${edgeAttrs(link, forked)};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function flagMarkers(node: Node): string {
  const parts: string[] = [];
  if ((node.flags & F.Dirty) !== 0) parts.push('Dirty');
  if ((node.flags & F.Pending) !== 0) parts.push('Pending');
  if ((node.flags & F.HeadDirty) !== 0) parts.push('HeadDirty');
  if ((node.flags & F.HeadPending) !== 0) parts.push('HeadPending');
  if (node.watched > 0) parts.push(`watched:${node.watched}`);
  return parts.length > 0 ? `\n[${parts.join(' ')}]` : '';
}

function computedResult(status: number, value: unknown, payload: unknown): string {
  if (status === STATUS_ERROR) return `error: ${summarize(payload)}`;
  if (status === STATUS_SUSPENDED) return 'suspended…';
  return summarize(value);
}

function nodeAttrs(node: Node, forked: boolean): string {
  if (node.kind === KIND_ATOM) {
    const atom = node as AtomNode;
    let valueLine: string;
    if (forked) {
      valueLine = `COMMITTED: ${summarize(atom.committedLatest)} | HEAD: ${summarize(atom.headLatest)}`;
    } else {
      valueLine = summarize(atom.committedLatest);
    }
    const pendingLog =
      atom.log !== null && atom.log.length > 0 ? `\nlog: ${atom.log.length} entries` : '';
    const label = `${nodeDisplayName(node)}\n${valueLine}${pendingLog}${flagMarkers(node)}`;
    return `[shape=box, style=filled, fillcolor="#dbeafe", label="${q(label)}"]`;
  }
  if (node.kind === KIND_COMPUTED) {
    const c = node as ComputedNode;
    const committed = c.results.find((r) => r.world === WORLD_COMMITTED);
    let valueLine =
      committed !== undefined
        ? computedResult(committed.status, committed.value, committed.payload)
        : '(not yet evaluated)';
    if (forked) {
      const head = c.results.find((r) => r.world === WORLD_HEAD);
      valueLine = `COMMITTED: ${valueLine} | HEAD: ${
        head !== undefined
          ? computedResult(head.status, head.value, head.payload)
          : '(not seeded)'
      }`;
    }
    const label = `${nodeDisplayName(node)}\n${valueLine}${flagMarkers(node)}`;
    return `[shape=ellipse, style=filled, fillcolor="#dcfce7", label="${q(label)}"]`;
  }
  const label = `${nodeDisplayName(node)}${flagMarkers(node)}`;
  return `[shape=diamond, style=filled, fillcolor="#ffedd5", label="${q(label)}"]`;
}

function edgeAttrs(link: Link, forked: boolean): string {
  if (!forked || link.planes === (PLANE_COMMITTED | PLANE_HEAD)) {
    return '[color="#6b7280"]';
  }
  if ((link.planes & PLANE_COMMITTED) !== 0) {
    return '[color="#2563eb", label="COMMITTED"]';
  }
  if ((link.planes & PLANE_HEAD) !== 0) {
    return '[color="#ea580c", style=dashed, label="HEAD"]';
  }
  return '[color="#d1d5db", style=dotted, label="stale"]';
}

// ---------------------------------------------------------------------------
// Causal trace graph
// ---------------------------------------------------------------------------

export type TraceGraphOptions = {
  /** Only render these event types (others are skipped, with edges routed
   * through them so causality stays connected). Default: all. */
  includeTypes?: readonly TraceEventType[];
  /** Graph title rendered above the drawing. */
  title?: string;
};

const EVENT_COLORS: Record<string, string> = {
  'atom-write': '#dbeafe',
  'computed-eval': '#dcfce7',
  notify: '#ffedd5',
  'effect-run': '#fee2e2',
  fold: '#f3e8ff',
  'render-read': '#e0f2fe',
  suspend: '#fef9c3',
  settle: '#fef9c3',
  invalidate: '#f3f4f6',
  'atom-observed': '#f3f4f6',
  'atom-unobserved': '#f3f4f6',
};

/**
 * Renders tracing events (from `react-signals/tracing`'s
 * `session.events()`) as a causal graph: an edge means "this event caused
 * that one". Filtered-out event types don't break chains — edges route
 * through them to the nearest rendered ancestor.
 */
export function traceToDot(
  events: readonly TraceEvent[],
  options: TraceGraphOptions = {},
): string {
  const include =
    options.includeTypes !== undefined ? new Set<string>(options.includeTypes) : null;
  const byId = new Map<number, TraceEvent>();
  for (const e of events) byId.set(e.id, e);

  const included = (e: TraceEvent): boolean => include === null || include.has(e.type);

  /** Nearest ancestor of `e` that will be rendered, or undefined. */
  const renderedCause = (e: TraceEvent): TraceEvent | undefined => {
    let cause = e.cause !== 0 ? byId.get(e.cause) : undefined;
    while (cause !== undefined && !included(cause)) {
      cause = cause.cause !== 0 ? byId.get(cause.cause) : undefined;
    }
    return cause;
  };

  const lines: string[] = [];
  lines.push('digraph trace {');
  lines.push('  rankdir=TB;');
  lines.push('  node [fontname="monospace", fontsize=10, shape=box, style=filled];');
  if (options.title !== undefined) {
    lines.push(`  label="${q(options.title)}"; labelloc=t;`);
  }

  for (const e of events) {
    if (!included(e)) continue;
    const subject = nodeDisplayName(e.node as Node | undefined);
    const label = subject !== '' ? `#${e.id} ${e.type}\n${subject}` : `#${e.id} ${e.type}`;
    const color = EVENT_COLORS[e.type] ?? '#f3f4f6';
    lines.push(`  e${e.id} [label="${q(label)}", fillcolor="${color}"];`);
  }
  for (const e of events) {
    if (!included(e)) continue;
    const cause = renderedCause(e);
    if (cause !== undefined) {
      lines.push(`  e${cause.id} -> e${e.id};`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}
