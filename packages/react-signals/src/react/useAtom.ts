/**
 * Component-lifetime signal creation hooks.
 *
 * These only CREATE signals (once, on mount — like useState's initial value,
 * later arguments are ignored). Reading still goes through useSignal, so
 * creation and subscription stay separate: a component can create an atom and
 * pass it to children without subscribing itself.
 */

import { useState } from 'react';
import {
  Atom,
  ReducerAtom,
  type AtomOptions,
  type ReducerAtomOptions,
} from '../core/api.ts';

export type UseAtomOptions<T> = {
  label?: string;
  isEqual?: (a: T, b: T) => boolean;
};

/**
 * Creates an Atom that lives for the lifetime of the component. Like
 * useState, `initialState` may be a function for lazy initialization, and is
 * only consulted on mount. Pair with useSignal to read it reactively.
 */
export function useAtom<T>(initialState: T | (() => T), options?: UseAtomOptions<T>): Atom<T> {
  const [atom] = useState(() => {
    const init: AtomOptions<T> = {
      state: typeof initialState === 'function' ? (initialState as () => T)() : initialState,
    };
    if (options?.label !== undefined) init.label = options.label;
    if (options?.isEqual !== undefined) init.isEqual = options.isEqual;
    return new Atom<T>(init);
  });
  return atom;
}

/**
 * Creates a ReducerAtom that lives for the lifetime of the component —
 * useReducer semantics (dispatched actions rebase across transitions exactly
 * like queued useReducer actions), but the state is a signal: readable via
 * useSignal here or anywhere the atom is passed. The reducer is captured on
 * mount.
 */
export function useReducerAtom<S, A>(
  reduce: (state: S, action: A) => S,
  initialState: S | (() => S),
  options?: UseAtomOptions<S>,
): ReducerAtom<S, A> {
  const [atom] = useState(() => {
    const init: ReducerAtomOptions<S, A> = {
      state: typeof initialState === 'function' ? (initialState as () => S)() : initialState,
      reduce,
    };
    if (options?.label !== undefined) init.label = options.label;
    if (options?.isEqual !== undefined) init.isEqual = options.isEqual;
    return new ReducerAtom<S, A>(init);
  });
  return atom;
}
