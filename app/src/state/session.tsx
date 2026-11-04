/** Сессия мастера: токены (SecureStore), пользователь и цех (кэш в AsyncStorage для офлайн-запуска). */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler, tokenStore } from '../api';
import type { InviteOut, TokensOut, UserOut, WorkshopOut } from '../api/types';
import { dropPushToken } from '../services/push';

type Status = 'loading' | 'signedOut' | 'signedIn';
interface Session {
  status: Status;
  user: UserOut | null;
  workshop: WorkshopOut | null;
  isOwner: boolean;
  /** Права сотрудника (SCR-23); у владельца — всё. */
  seesCost: boolean;
  canOrder: boolean;
  /** Приглашение в цех после входа (SCR-38a) — Gate открывает экран приглашения. */
  invite: InviteOut | null;
  setInvite(i: InviteOut | null): void;
  signIn(t: TokensOut): Promise<void>;
  /** local — только забыть сессию на телефоне (аккаунт удалён: сервер уже всё отозвал). */
  signOut(opts?: { local?: boolean }): Promise<void>;
  refresh(): Promise<void>;
  setWorkshop(w: WorkshopOut): void;
}

const Ctx = createContext<Session | null>(null);
const USER = 'mebel.user';
const WS = 'mebel.workshop';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<UserOut | null>(null);
  const [workshop, setWs] = useState<WorkshopOut | null>(null);
  const [invite, setInvite] = useState<InviteOut | null>(null);

  const setWorkshop = useCallback((w: WorkshopOut) => {
    setWs(w);
    AsyncStorage.setItem(WS, JSON.stringify(w)).catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [u, w] = await Promise.all([api.me(), api.getWorkshop()]);
      setUser(u);
      setWorkshop(w);
      AsyncStorage.setItem(USER, JSON.stringify(u)).catch(() => undefined);
      // приглашение могли не досмотреть (приложение закрыли на экране приглашения)
      if (u.role === 'owner' && !w.name) api.myInvite().then(setInvite).catch(() => undefined);
    } catch {
      /* офлайн — остаёмся на кэше */
    }
  }, [setWorkshop]);

  const signOut = useCallback(async (opts?: { local?: boolean }) => {
    const t = opts?.local ? null : await tokenStore.get();
    // push на этот телефон больше не нужен (не ждём дольше 3 с — без сети выход не должен зависать)
    if (t) await Promise.race([dropPushToken(), new Promise((r) => setTimeout(r, 3000))]);
    if (t) api.logout(t.refresh).catch(() => undefined);
    await tokenStore.set(null);
    await AsyncStorage.multiRemove([USER, WS]).catch(() => undefined);
    await api.clearCache().catch(() => undefined);
    setUser(null);
    setWs(null);
    setInvite(null);
    setStatus('signedOut');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { signOut(); });
    (async () => {
      const t = await tokenStore.get();
      if (!t) return setStatus('signedOut');
      try {
        const [u, w] = await Promise.all([AsyncStorage.getItem(USER), AsyncStorage.getItem(WS)]);
        if (u) setUser(JSON.parse(u));
        if (w) setWs(JSON.parse(w));
      } catch {
        /* ignore */
      }
      setStatus('signedIn');
      refresh();
    })();
    return () => setUnauthorizedHandler(null);
  }, [refresh, signOut]);

  const signIn = useCallback(async (tk: TokensOut) => {
    await tokenStore.set({ access: tk.access_token, refresh: tk.refresh_token });
    setUser(tk.user);
    AsyncStorage.setItem(USER, JSON.stringify(tk.user)).catch(() => undefined);
    try {
      setWorkshop(await api.getWorkshop());
    } catch {
      /* ignore */
    }
    // приглашение — после цеха: после «Принять» Gate должен увидеть уже новый цех
    setInvite(tk.invite ?? null);
    setStatus('signedIn');
  }, [setWorkshop]);

  const value = useMemo<Session>(() => ({
    status, user, workshop, isOwner: user?.role !== 'employee',
    seesCost: user?.role !== 'employee' || !!user?.can_see_cost,
    canOrder: user?.role !== 'employee' || !!user?.can_order,
    invite, setInvite, signIn, signOut, refresh, setWorkshop,
  }), [status, user, workshop, invite, signIn, signOut, refresh, setWorkshop]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider missing');
  return v;
}
