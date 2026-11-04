'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** Загрузка данных GET-запросом; `path = null` — не загружать. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof ApiError ? e.message : String(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/** Действие с кнопки: busy-флаг и сообщение об ошибке/успехе. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const run = useCallback(async (fn: () => Promise<unknown>, okText?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (okText) setMessage({ kind: 'ok', text: okText });
      return true;
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof ApiError ? e.message : String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, message, run, setMessage };
}
