/** Загрузка данных экрана: { data, error, loading, reload }. Перезагружается при возврате на экран. */
import { useFocusEffect } from 'expo-router';
import { DependencyList, useCallback, useRef, useState } from 'react';

import { errorText } from '@/api/http';

export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fn();
      if (alive.current) { setData(d); setError(null); }
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useFocusEffect(useCallback(() => { alive.current = true; void reload(); return () => { alive.current = false; }; }, [reload]));
  return { data, setData, error, loading, reload };
}
