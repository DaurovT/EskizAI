import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Загрузка данных экрана: первый раз — индикатор, при возврате на экран — тихое обновление. */
export function useResource<T>(fn: () => Promise<T>, deps: unknown[], opts: { refetchOnFocus?: boolean; enabled?: boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(opts.enabled !== false);
  const [refreshing, setRefreshing] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // initial — первая загрузка (экран загрузки); silent — фоновое обновление без индикатора
  // (при возврате на экран, после действий); pull — пользователь потянул список: крутилка RefreshControl.
  // Фоновое обновление не трогает refreshing: на iOS программно включённый RefreshControl зависает сверху.
  const load = useCallback(async (mode: 'initial' | 'silent' | 'pull' = 'initial') => {
    if (opts.enabled === false) return;
    if (mode === 'initial') setLoading(true);
    else if (mode === 'pull') setRefreshing(true);
    try {
      const r = await fnRef.current();
      if (alive.current) { setData(r); setError(null); }
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) { setLoading(false); setRefreshing(false); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, opts.enabled]);

  useEffect(() => { load('initial'); }, [load]);
  const first = useRef(true);
  useFocusEffect(useCallback(() => {
    if (first.current) { first.current = false; return; }
    if (opts.refetchOnFocus !== false) load('silent');
  }, [load, opts.refetchOnFocus]));

  return { data, setData, error, loading, refreshing, reload: () => load('silent'), refresh: () => load('pull') };
}
