import { ApiError, parseError } from './errors';
import type { TokensOut } from './types';

export interface TokenStore {
  get(): Promise<{ access: string; refresh: string } | null>;
  set(t: { access: string; refresh: string } | null): Promise<void>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  baseUrl: string;
  tokens: TokenStore;
  fetch?: FetchLike;
  /** Сессия окончательно потеряна (refresh не прошёл) — выйти на экран входа. */
  onUnauthorized?: () => void;
  /** Ответ 503 `maintenance` — идут техработы (SCR-45). */
  onMaintenance?: (e: ApiError) => void;
  timeoutMs?: number;
}

export interface RequestOpts {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | string[] | null | undefined>;
  auth?: boolean;
  form?: FormData;
}

export function buildQuery(q?: RequestOpts['query']): string {
  if (!q) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    for (const item of Array.isArray(v) ? v : [v]) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Тонкая обёртка над fetch: токен, обновление по 401, ошибки в ApiError, нет сети → status 0. */
export class Http {
  private refreshing: Promise<boolean> | null = null;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: HttpOptions) {
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  get baseUrl() { return this.opts.baseUrl.replace(/\/$/, ''); }

  async authHeader(): Promise<Record<string, string>> {
    const t = await this.opts.tokens.get();
    return t ? { Authorization: `Bearer ${t.access}` } : {};
  }

  async request<T>(path: string, o: RequestOpts = {}, retried = false): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (o.auth !== false) Object.assign(headers, await this.authHeader());
    let body: BodyInit | undefined;
    if (o.form) body = o.form as unknown as BodyInit;
    else if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(o.body);
    }
    let res: Response;
    try {
      res = await this.withTimeout(
        this.fetchImpl(`${this.baseUrl}${path}${buildQuery(o.query)}`, { method: o.method ?? 'GET', headers, body }),
      );
    } catch (e) {
      throw new ApiError(0, 'network', (e as Error)?.message || 'network');
    }
    if (res.status === 401 && o.auth !== false && !retried) {
      if (await this.refresh()) return this.request<T>(path, o, true);
      this.opts.onUnauthorized?.();
    }
    if (!res.ok) {
      const err = await parseError(res);
      if (err.code === 'maintenance') this.opts.onMaintenance?.(err);
      throw err;
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    const ms = this.opts.timeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  /** Одно обновление на все параллельные запросы (ротация refresh-токена на сервере). */
  refresh(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const t = await this.opts.tokens.get();
        if (!t) return false;
        try {
          const out = await this.request<TokensOut>('/auth/refresh', { method: 'POST', body: { refresh_token: t.refresh }, auth: false }, true);
          await this.opts.tokens.set({ access: out.access_token, refresh: out.refresh_token });
          return true;
        } catch {
          await this.opts.tokens.set(null);
          return false;
        }
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
}
