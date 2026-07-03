/**
 * Code-review repro tests for src/core/engine.ts (reviewer: fable5).
 *
 * Focus: fidelity of the alien-signals port in steady (non-forked) mode —
 * propagate/checkDirty/effect-queue interplay. Each `test.fails` case asserts
 * the CORRECT behavior (matching alien-signals 3.2.1 semantics) and currently
 * fails, demonstrating a confirmed defect. Findings here are disjoint from
 * review-fable.test.ts and review-claude.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Atom, Computed, effect } from '../src/core/index.ts';
import {
  setWriteBatchProvider,
  setAmbientWorld,
  retireBatch,
  isForked,
  createWatcher,
  subscribeTo,
  disposeWatcher,
  writeAtom,
  WATCHER_SUBSCRIPTION,
  type BatchRef,
} from '../src/core/engine.ts';

// Fake batch token standing in for the patch's (an opaque BatchRef object).
// Fresh per test so retirement state doesn't leak between tests.
let T_BATCH: BatchRef;
const createdTokens: BatchRef[] = [];
beforeEach(() => {
  T_BATCH = { deferred: true };
  createdTokens.push(T_BATCH);
});

function withBatch<T>(token: BatchRef, fn: () => T): T {
  setWriteBatchProvider(() => token);
  try {
    return fn();
  } finally {
    setWriteBatchProvider(null);
  }
}

afterEach(() => {
  setWriteBatchProvider(null);
  setAmbientWorld(null);
  // Unfork / drain logs so tests stay independent.
  for (const t of createdTokens.splice(0)) retireBatch(t);
});

// ---------------------------------------------------------------------------
// Finding 1 (CRITICAL): notifyWatcher flushes the effect queue mid-propagate.
//
// alien-signals: notify() only queues; flush() runs after propagate() returns
// (signalOper). Engine: notifyWatcher's effect path calls flushEffects()
// immediately (engine.ts:625), so the first-notified effect runs its pull
// while propagate has not yet marked sibling subscribers. The pull commits
// the atom (clears F.Dirty) and shallowPropagate cannot promote subscribers
// that are not yet Pending — when propagate finally marks them, their
// checkDirty finds a clean graph and the update is lost.
// ---------------------------------------------------------------------------

describe('finding 1: mid-propagate effect flush loses sibling updates', () => {
  test('1a: two effects on one atom — both must re-run on a single write', () => {
    const a = new Atom({ state: 1 });
    const seen1: number[] = [];
    const seen2: number[] = [];
    const d1 = effect(() => void seen1.push(a.state));
    const d2 = effect(() => void seen2.push(a.state));
    a.set(2);
    d1();
    d2();
    expect(seen1).toEqual([1, 2]);
    expect(seen2).toEqual([1, 2]); // FAILS: [1] — second effect never re-runs
  });

  test('1b: diamond with equality cutoff — join left permanently stale', () => {
    const a = new Atom({ state: -1 });
    const abs = new Computed({ fn: () => Math.abs(a.state) }); // cutoff arm
    const id = new Computed({ fn: () => a.state }); // changing arm
    const join = new Computed({ fn: () => abs.state * 100 + id.state });
    const seen: number[] = [];
    const dispose = effect(() => void seen.push(join.state));
    expect(seen).toEqual([99]); // 1*100 + (-1)

    // abs unchanged (|-1| == |1|), id changes -1→1 → join must become 101.
    // The effect's checkDirty runs mid-propagate (before `id` is marked
    // Pending): it consumes the atom's Dirty bit, cuts off at abs, and
    // validates join "clean". When propagate then marks id and re-queues the
    // effect, id's pull finds the atom already clean → everything is
    // "validated clean" while id/join still hold pre-write values.
    a.set(1);
    const joinNow = join.state;
    dispose();
    expect(seen).toEqual([99, 101]); // FAILS: [99] — effect never re-ran
    expect(joinNow).toBe(101); // FAILS: 99 — wrong cached value, permanent
  });
});

// ---------------------------------------------------------------------------
// Finding 2 (CRITICAL): eager subscription confirm mid-propagate suppresses
// sibling subscriptions.
//
// notifyWatcher confirms subscriptions inline while propagate is still
// walking the subscriber list (engine.ts:585-603). The first subscription's
// confirmSubscriptionDirty→checkDirty commits the atom; shallowPropagate can
// only promote subs that are already Pending, and propagate has not marked
// the later siblings yet. When it does, their confirm finds a clean graph and
// swallows the notification. (The double-notify half of this defect — the
// same watcher notified once via shallowPropagate re-entry and once via its
// own confirm — is covered by review-fable.test.ts "H".)
// ---------------------------------------------------------------------------

describe('finding 2: sibling subscription notification lost', () => {
  test('2a: two subscriptions on one atom — each notified on a write', () => {
    const a = new Atom({ state: 1 });
    let n1 = 0;
    let n2 = 0;
    const s1 = createWatcher(WATCHER_SUBSCRIPTION, null, () => void n1++);
    const s2 = createWatcher(WATCHER_SUBSCRIPTION, null, () => void n2++);
    subscribeTo(s1, a.node);
    subscribeTo(s2, a.node);
    try {
      writeAtom(a.node, 2);
      expect(n2).toBeGreaterThan(0); // FAILS: 0 — s2 never hears the write
      expect(n1).toBe(1); // FAILS: 2 — s1 double-notified (see fable H)
    } finally {
      disposeWatcher(s1);
      disposeWatcher(s2);
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 3 (HIGH): steady-mode writes leave permanent HeadPending on
// computeds, which prunes HEAD-plane propagation after the next fork.
//
// Steady-mode propagate marks subscribers in BOTH planes
// (Pending|HeadPending), but every BASE-plane pull (startTracking /
// checkDirty resolve / runQueuedWatcher) clears only the BASE bits, so any
// computed that was invalidated then re-pulled in steady mode keeps
// HeadPending forever. The first transition write's HEAD propagate then sees
// `alreadyMarked` at that computed (engine.ts:519) and prunes the branch:
// nodes *downstream* of it are never invalidated in the HEAD plane, and
// subscriptions below it are never notified.
// ---------------------------------------------------------------------------

describe('finding 3: stale HeadPending prunes HEAD propagation after fork', () => {
  test('3a: head read of a downstream computed sees the transition write', () => {
    const a = new Atom({ state: 1 });
    const c = new Computed({ fn: () => a.state * 10 });
    expect(c.state).toBe(10); // evaluate + link c→a

    a.set(2); // steady write: marks c Pending|HeadPending
    const d = new Computed({ fn: () => c.state + 1 });
    expect(d.state).toBe(21); // BASE pull clears c's Pending; HeadPending survives

    withBatch(T_BATCH, () => {
      a.set(3); // HEAD propagate prunes at c → d never marked HeadPending
    });
    expect(isForked()).toBe(true);
    expect(c.state).toBe(30); // c itself self-heals via its own stale bit
    expect(d.state).toBe(31); // FAILS: 21 — stale head value
  });

  test('3b: subscription below such a computed is notified of the transition', () => {
    const a = new Atom({ state: 1 });
    const c = new Computed({ fn: () => a.state * 10 });
    expect(c.state).toBe(10);
    a.set(2); // pollute c with stale HeadPending
    expect(c.state).toBe(20); // BASE pull; HeadPending remains

    let notifies = 0;
    const s = createWatcher(WATCHER_SUBSCRIPTION, null, () => void notifies++);
    subscribeTo(s, c.node);
    try {
      withBatch(T_BATCH, () => {
        a.set(3); // genuine head change 20→30; propagate prunes at c
      });
      expect(notifies).toBeGreaterThan(0); // FAILS: 0 — component never re-renders
    } finally {
      disposeWatcher(s);
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 4 (MEDIUM): checkDirty drops alien's disposal guard
// (`return dirty && !!sub.flags`, system.ts:235). If the watcher is disposed
// by a side effect of the pull itself (here: a computed's in-getter write
// notifies a subscription whose onChange disposes the effect — a normal
// "unmount on change" reaction), checkDirty still returns true and
// runQueuedWatcher calls runEffect on the disposed node: startTracking
// resurrects its flags, the fn re-runs and re-links deps, and the effect is
// alive again after its disposer already ran.
// ---------------------------------------------------------------------------

describe('finding 4: effect disposed during its own dirtiness check is resurrected', () => {
  test('disposal during the update wave sticks', () => {
    const a = new Atom({ state: 1 });
    const x = new Atom({ state: 0 });
    const c = new Computed({
      fn: () => {
        const v = a.state * 10;
        x.set(v); // legal write-inside-computed (side channel)
        return v;
      },
    });
    const runs: number[] = [];
    const disposeE = effect(() => void runs.push(c.state));
    expect(runs).toEqual([10]);

    let disposed = false;
    const s = createWatcher(WATCHER_SUBSCRIPTION, null, () => {
      if (!disposed) {
        disposed = true;
        disposeE(); // unmount-on-change: dispose the effect
      }
    });
    subscribeTo(s, x.node);
    try {
      // Since batch-deferred delivery, s.onChange no longer fires mid-pull:
      // the write to x inside c's evaluation queues s, the effect's re-run
      // completes (runs gains 20), and only then does s fire and dispose e.
      // The guarded property is anti-resurrection: once disposed, e must
      // never run again — with the original bug, runs kept growing forever.
      a.set(2);
      expect(runs).toEqual([10, 20]); // ran once, then unmount-on-change fired
      a.set(3);
      expect(runs).toEqual([10, 20]); // disposed stays disposed
    } finally {
      disposeWatcher(s);
      disposeE();
    }
  });
});
