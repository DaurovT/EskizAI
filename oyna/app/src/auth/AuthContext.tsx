/**
 * Сессия: токены, пользователь, цех. Экраны входа вызывают requestCode / verifyCode / createCompany,
 * остальное приложение читает useAuth(). Без сети пользователь остаётся в аккаунте (замер работает офлайн).
 */
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, ApiError, setUnauthorizedHandler, tokenStore } from '@/api/http';
import type { CodeSent, Me, Role, Tokens } from '@/api/types';

type Company = { id: string; name: string; role: Role };
type State = { ready: boolean; user: Me | null; company: Company | null; companies: Company[] };
export type CompanyIn = {
  name: string; phone?: string; inn?: string; address?: string; mode?: 'manufacturer' | 'dealer'; dealer_coef?: number;
  markup_kind?: 'percent' | 'margin' | 'per_m2'; markup_value?: number; usd_rate?: number | null; lang_default?: 'ru' | 'uz';
  systems?: string[]; works?: Record<string, number>; demo_prices?: boolean;
};
type Auth = State & {
  language: 'ru' | 'uz';
  setLanguage: (l: 'ru' | 'uz') => void;
  requestCode: (phone: string) => Promise<CodeSent>;
  verifyCode: (phone: string, code: string) => Promise<Tokens>;
  createCompany: (body: CompanyIn) => Promise<void>;
  switchCompany: (id: string) => Promise<void>;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
  role: Role | null;
  isOwner: boolean;
};

const Ctx = createContext<Auth | null>(null);
const EMPTY: State = { ready: true, user: null, company: null, companies: [] };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<State>({ ...EMPTY, ready: false });
  const [language, setLanguage] = useState<'ru' | 'uz'>('ru');

  const applyTokens = useCallback(async (out: Tokens) => {
    await tokenStore.set({ access: out.access_token, refresh: out.refresh_token });
    const me = await api.get<Me>('/auth/me');
    const company = out.companies.find((c) => c.id === out.company_id) ?? null;
    setSt({ ready: true, user: me, company, companies: out.companies });
  }, []);

  const reload = useCallback(async () => {
    const t = await tokenStore.get();
    if (!t) { setSt(EMPTY); return; }
    try {
      const me = await api.get<Me>('/auth/me');
      setSt({ ready: true, user: me, company: me.companies.find((c) => c.id === me.company_id) ?? null, companies: me.companies });
    } catch (e) {
      if (e instanceof ApiError && e.isNetwork) setSt((p) => ({ ...p, ready: true })); // без сети — остаёмся в аккаунте
      else setSt(EMPTY);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { void tokenStore.set(null); setSt(EMPTY); });
    void reload();
    return () => setUnauthorizedHandler(null);
  }, [reload]);

  const value = useMemo<Auth>(() => ({
    ...st,
    language,
    setLanguage,
    role: st.company?.role ?? null,
    isOwner: st.company?.role === 'owner',
    requestCode: (phone) => api.post<CodeSent>('/auth/request-code', { phone }),
    verifyCode: async (phone, code) => {
      const out = await api.post<Tokens>('/auth/verify-code', { phone, code });
      await applyTokens(out);
      return out;
    },
    createCompany: async (body) => {
      const r = await api.post<{ tokens: Tokens }>('/oyna/company', body);
      await applyTokens(r.tokens);
    },
    switchCompany: async (id) => { await applyTokens(await api.post<Tokens>('/auth/switch-company', { company_id: id })); },
    reload,
    logout: async () => {
      const t = await tokenStore.get();
      try { if (t) await api.post('/auth/logout', { refresh_token: t.refresh }); } catch { /* выходим всё равно */ }
      await tokenStore.set(null);
      setSt(EMPTY);
    },
  }), [st, language, applyTokens, reload]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): Auth {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth вне AuthProvider');
  return v;
}
