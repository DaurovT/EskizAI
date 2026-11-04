import { useSyncExternalStore } from 'react';

/** Маленькое хранилище без зависимостей: get / set / subscribe + хук. */
export function createStore<S>(initial: S) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next: Partial<S> | ((s: S) => S)) {
      state = typeof next === 'function' ? (next as (s: S) => S)(state) : { ...state, ...next };
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => { subs.delete(f); };
    },
    use<T>(sel: (s: S) => T): T {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useSyncExternalStore(this.subscribe, () => sel(state), () => sel(state));
    },
  };
}
