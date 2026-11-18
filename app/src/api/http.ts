/**
 * HTTP к API Eskiz Oyna: Bearer-токен, обновление по 401 (одно на все параллельные запросы),
 * ошибки FastAPI `{"detail": "…" | {msg, …} | [{msg}]}` → ApiError, нет сети → ApiError(status 0, 'network').
 * Скопировано из Eskiz Temir и подогнано под формат ошибок Oyna (код семейства не подключается, а копируется).
 */
import * as SecureStore from 'expo-secure-store';

import { API_URL } from '@/config';
import type { Tokens } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
  get isNetwork() { return this.status === 0; }
  get isConflict() { return this.status === 409; }
}

type Stored = { access: string; refresh: string };
const KEY = 'oyna.tokens';
let cached: Stored | null | undefined;
export const tokenStore = {
  async get(): Promise<Stored | null> {
    if (cached !== undefined) return cached;
    const raw = await SecureStore.getItemAsync(KEY);
    cached = raw ? (JSON.parse(raw) as Stored) : null;
    return cached;
  },
  async set(t: Stored | null) {
    cached = t;
    if (t) await SecureStore.setItemAsync(KEY, JSON.stringify(t));
    else await SecureStore.deleteItemAsync(KEY);
  },
};

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) { onUnauthorized = fn; }

type Query = Record<string, string | number | boolean | string[] | null | undefined>;
export type Opts = { method?: string; body?: unknown; query?: Query; auth?: boolean; form?: FormData; timeoutMs?: number };

function qs(q?: Query) {
  if (!q) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    for (const item of Array.isArray(v) ? v : [v]) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** detail: строка | {msg, attempts_left, …} | [{loc, msg}] (ошибки валидации) | любое тело 409 */
async function parseError(res: Response): Promise<ApiError> {
  try {
    const j = await res.json();
    const d = j?.detail ?? j;
    if (typeof d === 'string') return new ApiError(res.status, 'error', d, j);
    if (Array.isArray(d)) return new ApiError(res.status, 'validation', d.map((x) => x?.msg).filter(Boolean).join('; ') || 'Проверьте данные', d);
    if (d?.msg) return new ApiError(res.status, 'error', d.msg, d);
    if (res.status === 409) return new ApiError(409, 'conflict', d?.error ?? 'Конфликт версий', j);
    return new ApiError(res.status, 'error', `Ошибка ${res.status}`, j);
  } catch {
    return new ApiError(res.status, 'error', `Ошибка сервера (${res.status})`);
  }
}

let refreshing: Promise<boolean> | null = null;
function refresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      const t = await tokenStore.get();
      if (!t) return false;
      try {
        const out = await request<Tokens>('/auth/refresh', { method: 'POST', body: { refresh_token: t.refresh }, auth: false });
        await tokenStore.set({ access: out.access_token, refresh: out.refresh_token });
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.isNetwork) return false; // нет сети — из аккаунта не выходим
        await tokenStore.set(null);
        return false;
      }
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function authHeaders(): Promise<Record<string, string>> {
  const t = await tokenStore.get();
  return t ? { Authorization: `Bearer ${t.access}` } : {};
}

export async function request<T>(path: string, o: Opts = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (o.auth !== false) Object.assign(headers, await authHeaders());
  let body: BodyInit | undefined;
  if (o.form) body = o.form as unknown as BodyInit;
  else if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}${qs(o.query)}`, { method: o.method ?? 'GET', headers, body, signal: ctrl.signal });
  } catch {
    throw new ApiError(0, 'network', 'Нет связи с сервером. Проверьте интернет');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 && o.auth !== false && !retried) {
    if (await refresh()) return request<T>(path, o, true);
    onUnauthorized?.();
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('json') === false) return text as unknown as T; // SVG
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown, query?: Query) => request<T>(path, { method: 'POST', body, query }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string, query?: Query) => request<T>(path, { method: 'DELETE', query }),
};

/** Сообщение ошибки для показа человеку. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return 'Что-то пошло не так. Попробуйте ещё раз';
}
