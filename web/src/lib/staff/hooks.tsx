'use client';

/** Общие хуки кабинетов сотрудников: текущий клиент API, сессия, загрузка данных, действия с кнопок. */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { adminClient } from '@/lib/admin/api';
import { ApiError, can, type StaffClient, type StaffMe } from './client';

const ClientCtx = createContext<StaffClient>(adminClient);

export function ClientProvider({ client, children }: { client: StaffClient; children: ReactNode }) {
  return <ClientCtx.Provider value={client}>{children}</ClientCtx.Provider>;
}

/** Клиент API текущего кабинета (по умолчанию — админка). */
export function useClient(): StaffClient {
  return useContext(ClientCtx);
}

export interface Session {
  me: StaffMe;
  /** Вход по старому общему токену админки (X-Admin-Token). */
  legacy: boolean;
  reload: () => void;
}

const SessionCtx = createContext<Session | null>(null);

export function SessionProvider({ value, children }: { value: Session; children: ReactNode }) {
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): Session | null {
  return useContext(SessionCtx);
}

/** Проверка прав текущего сотрудника: `can('vendor.orders')`. */
export function useCan(): (...perms: string[]) => boolean {
  const s = useSession();
  return useCallback((...perms: string[]) => can(s?.me.permissions, ...perms), [s]);
}

/** Загрузка данных GET-запросом; `path = null` — не загружать. */
export function useApi<T>(path: string | null) {
  const client = useClient();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    client
      .api<T>(path)
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
  }, [client, path, tick]);

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
