// @vitest-environment jsdom
/**
 * CONTRACT TESTS for the React patch's batch-token protocol.
 *
 * These define the boundary between react-signals userspace and the patched
 * React. When the patch is rebased onto a new React version, making this file
 * pass — through real renders, with no userspace changes — is the definition
 * of "the rebase is done".
 *
 * The contract (see notes/design/01-v2-batch-tokens-and-rewrite.md):
 *  - A token identifies a batch: all writes in one event/transition share it;
 *    distinct events get distinct tokens.
 *  - `deferred` distinguishes transition-like batches from immediate ones.
 *  - A render pass reports the tokens of every live batch it includes.
 *  - Every token retires exactly once; commits (including empty renders for
 *    work discarded by unmounts) retire committed=true, batches that never
 *    produced React work retire committed=false.
 *  - Tokens are allocated per batch, lazily, never per write.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as React from 'react';
import { act, startTransition, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Token = { deferred: boolean; id: number };
type PatchedReact = {
  unstable_getCurrentWriteBatch(): Token;
  unstable_isCurrentWriteDeferred(): boolean;
  unstable_subscribeToExternalRuntime(listener: {
    onRenderPassStart?: (container: unknown, includedBatches: readonly Token[]) => void;
    onBatchRetired?: (token: Token, committed: boolean) => void;
    onCommit?: (container: unknown) => void;
  }): () => void;
};
const R = React as unknown as PatchedReact;

const roots: { root: Root; el: HTMLElement }[] = [];
let unsubscribe: (() => void) | null = null;
let retired: { token: Token; committed: boolean }[] = [];
let passes: { included: readonly Token[] }[] = [];

beforeEach(() => {
  retired = [];
  passes = [];
  unsubscribe = R.unstable_subscribeToExternalRuntime({
    onRenderPassStart(_c, includedBatches) {
      passes.push({ included: includedBatches });
    },
    onBatchRetired(token, committed) {
      retired.push({ token, committed });
    },
  });
});
afterEach(async () => {
  unsubscribe?.();
  unsubscribe = null;
  for (const { root, el } of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    el.remove();
  }
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push({ root, el });
  await act(async () => {
    root.render(node);
  });
  return el;
}

function controlled(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('batch identity', () => {
  test('writes in one transition share a token; distinct events get distinct tokens', async () => {
    let t1a!: Token, t1b!: Token, t2!: Token;
    await act(async () => {
      startTransition(() => {
        t1a = R.unstable_getCurrentWriteBatch();
        t1b = R.unstable_getCurrentWriteBatch();
      });
    });
    await act(async () => {
      startTransition(() => {
        t2 = R.unstable_getCurrentWriteBatch();
      });
    });
    expect(t1a).toBe(t1b); // same batch, same identity — no per-call allocation
    expect(t1a.deferred).toBe(true);
    expect(t2.deferred).toBe(true);
    expect(t2).not.toBe(t1a); // distinct events, distinct identities
  });

  test('immediate (non-transition) batches are classified deferred=false', async () => {
    let t!: Token;
    await act(async () => {
      t = R.unstable_getCurrentWriteBatch();
    });
    expect(t.deferred).toBe(false);
  });

  test('isCurrentWriteDeferred classifies without minting a token', async () => {
    let inTransition!: boolean;
    let outside!: boolean;
    await act(async () => {
      startTransition(() => {
        inTransition = R.unstable_isCurrentWriteDeferred();
      });
      outside = R.unstable_isCurrentWriteDeferred();
    });
    expect(inTransition).toBe(true);
    expect(outside).toBe(false);
    // Classification must be pure: no token was minted, so nothing retires —
    // this is what lets external stores gate before allocating (design-note
    // invariant #2: no token unless a write actually needs logging).
    expect(retired).toHaveLength(0);
  });
});

describe('retirement', () => {
  test('a batch with no React work retires uncommitted at event close', async () => {
    let t!: Token;
    await act(async () => {
      startTransition(() => {
        t = R.unstable_getCurrentWriteBatch(); // external-only writes
      });
    });
    const mine = retired.filter((r) => r.token === t);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.committed).toBe(false);
  });

  test('a transition that renders and commits retires exactly once, committed', async () => {
    let setLabel!: (v: string) => void;
    function App() {
      const [label, set] = useState('a');
      setLabel = set;
      return <output>{label}</output>;
    }
    const el = await mount(<App />);

    let t!: Token;
    await act(async () => {
      startTransition(() => {
        t = R.unstable_getCurrentWriteBatch();
        setLabel('b'); // React work in the same batch
      });
    });
    expect(el.textContent).toBe('b');
    const mine = retired.filter((r) => r.token === t);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.committed).toBe(true);
  });

  test('a held-open transition retires only when it finally commits', async () => {
    let setLabel!: (v: string) => void;
    function App() {
      const [label, set] = useState('a');
      setLabel = set;
      return <output>{label}</output>;
    }
    await mount(<App />);

    const gate = controlled();
    let t!: Token;
    await act(async () => {
      startTransition(async () => {
        t = R.unstable_getCurrentWriteBatch();
        setLabel('b');
        await gate.promise;
      });
    });
    expect(retired.filter((r) => r.token === t)).toHaveLength(0); // still pending
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    const mine = retired.filter((r) => r.token === t);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.committed).toBe(true);
  });

  test('work discarded by unmount still retires through an ordinary commit', async () => {
    let setLabel!: (v: string) => void;
    function Child() {
      const [label, set] = useState('a');
      setLabel = set;
      return <output>{label}</output>;
    }
    function App({ show }: { show: boolean }) {
      return show ? <Child /> : <i>gone</i>;
    }
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    roots.push({ root, el });
    await act(async () => {
      root.render(<App show={true} />);
    });

    const gate = controlled();
    let t!: Token;
    await act(async () => {
      startTransition(async () => {
        t = R.unstable_getCurrentWriteBatch();
        setLabel('b'); // queued on Child
        await gate.promise;
      });
    });
    expect(retired.filter((r) => r.token === t)).toHaveLength(0);

    // Unmount Child while its transition update is still pending: the update
    // dies with the fiber, and React retires the lane via its normal path.
    await act(async () => {
      root.render(<App show={false} />);
    });
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    const mine = retired.filter((r) => r.token === t);
    expect(mine).toHaveLength(1); // exactly once — never resurrects
  });
});

describe('render inclusion', () => {
  test('a transition render includes its batch token; urgent renders do not', async () => {
    let setLabel!: (v: string) => void;
    let setUrgent!: (v: number) => void;
    function App() {
      const [label, set] = useState('a');
      const [n, setN] = useState(0);
      setLabel = set;
      setUrgent = setN;
      return <output>{`${label}:${n}`}</output>;
    }
    await mount(<App />);

    const gate = controlled();
    let t!: Token;
    await act(async () => {
      startTransition(async () => {
        t = R.unstable_getCurrentWriteBatch();
        setLabel('b');
        await gate.promise;
      });
    });

    passes.length = 0;
    // Urgent render while the transition is pending: the urgent batch's pass
    // must NOT include t. (React may also re-attempt the transition's own
    // render in the same flush — that pass legitimately includes t — so the
    // contract is "no pass includes both batches".)
    let urgentToken!: Token;
    await act(async () => {
      urgentToken = R.unstable_getCurrentWriteBatch();
      setUrgent(1);
    });
    const mixedPasses = passes.filter(
      (p) => p.included.includes(t) && p.included.includes(urgentToken),
    );
    expect(mixedPasses).toHaveLength(0);
    expect(passes.some((p) => p.included.includes(urgentToken) && !p.included.includes(t))).toBe(
      true,
    );

    passes.length = 0;
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    // The transition's own render includes t.
    expect(passes.some((p) => p.included.includes(t))).toBe(true);
  });
});
