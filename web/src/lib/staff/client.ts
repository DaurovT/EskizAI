'use client';

/**
 * Клиент API для сотрудников (docs/staff_vendor_contract.md §2): вход по почте и паролю,
 * токены в localStorage, автоматическое обновление access по refresh, выход, смена пароля.
 * Один экземпляр на кабинет: админка платформы (scope 'admin', плюс старый X-Admin-Token)
 * и кабинет поставщика (scope 'vendor'). Ключи хранилища у них разные.
 */

/**
 * Адрес API: NEXT_PUBLIC_API_URL (подставляется при сборке). Если не задан — на боевых доменах
 * admin.<домен> / vendor.<домен> / app.<домен> берём https://api.<домен>, локально — http://localhost:8000.
 */
function resolveApiUrl(): string {
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env) return env.replace(/\/$/, '');
  if (typeof window !== 'undefined') {
    const m = /^(?:admin|vendor|app)\.(.+)$/.exec(window.location.hostname);
    if (m) return `${window.location.protocol}//api.${m[1]}`;
  }
  return 'http://localhost:8000';
}

export const API_URL = resolveApiUrl();

export interface StaffOrg {
  kind: 'platform' | 'supplier';
  supplier_id?: string | null;
  supplier_code?: string | null;
  supplier_name?: string | null;
}

export interface StaffMe {
  id: string;
  email: string;
  name: string;
  role: string;
  org: StaffOrg;
  permissions: string[];
  must_change_password: boolean;
  /** 2FA (§4a): включена ли у сотрудника и обязательна ли для его роли. */
  mfa_enabled?: boolean;
  mfa_required?: boolean;
  mfa_setup_required?: boolean;
  role_title?: string;
}

/** Нужно ли пройти настройку 2FA, прежде чем работать дальше. */
export function needsMfaSetup(me: StaffMe): boolean {
  if (me.mfa_setup_required !== undefined) return me.mfa_setup_required;
  if (me.mfa_enabled !== false) return false;
  return Boolean(me.mfa_required) || me.role === 'superadmin';
}

export type LoginResult = { kind: 'ok'; me: StaffMe } | { kind: 'mfa'; mfaToken: string };

interface Tokens {
  access: string;
  refresh: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  scope: 'admin' | 'vendor';
  /** Страница входа (вычисляется в момент перехода: у кабинета поставщика на своём домене нет префикса /vendor). */
  loginPath: () => string;
  /** Экран обязательной смены пароля. */
  passwordPath: () => string;
  /** Экран безопасности (настройка 2FA). */
  securityPath: () => string;
  /** Ключ старого общего токена админки (X-Admin-Token); только для админки. */
  legacyKey?: string;
}

function store(key: string, value: string | null): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    /* приватный режим — живёт до перезагрузки */
  }
}

function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.status === 403 ? 'Нет доступа' : `Ошибка ${res.status}`;
  let details: unknown;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown }; detail?: unknown };
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    } else if (typeof body.detail === 'string') {
      message = body.detail;
    }
  } catch {
    /* не JSON */
  }
  return new ApiError(res.status, code, message, details);
}

const CREDENTIAL_CODES = new Set(['invalid_credentials', 'wrong_password', 'invalid_password', 'current_password_invalid']);

export type StaffClient = ReturnType<typeof createStaffClient>;

export function createStaffClient(opts: ClientOptions) {
  const KEY = `eskiz_staff_${opts.scope}`;
  const ME_KEY = `${KEY}_me`;
  let refreshing: Promise<boolean> | null = null;

  function getTokens(): Tokens | null {
    const raw = load(KEY);
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as Tokens;
      return t.access && t.refresh ? t : null;
    } catch {
      return null;
    }
  }

  function setTokens(t: Tokens | null): void {
    store(KEY, t ? JSON.stringify(t) : null);
  }

  function getLegacy(): string | null {
    return opts.legacyKey ? load(opts.legacyKey) : null;
  }

  function setLegacy(token: string | null): void {
    if (opts.legacyKey) store(opts.legacyKey, token);
  }

  /** Последний известный профиль — чтобы шапка не мигала при переходах. */
  function cachedMe(): StaffMe | null {
    const raw = load(ME_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StaffMe;
    } catch {
      return null;
    }
  }

  function setCachedMe(me: StaffMe | null): void {
    store(ME_KEY, me ? JSON.stringify(me) : null);
  }

  function clear(): void {
    setTokens(null);
    setLegacy(null);
    setCachedMe(null);
  }

  function hasSession(): boolean {
    return Boolean(getTokens() || getLegacy());
  }

  function mode(): 'staff' | 'legacy' | null {
    if (getTokens()) return 'staff';
    if (getLegacy()) return 'legacy';
    return null;
  }

  function goto(path: string): void {
    if (typeof window === 'undefined') return;
    if (window.location.pathname !== path) window.location.href = path;
  }

  function toLogin(): void {
    clear();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith(opts.loginPath())) goto(opts.loginPath());
  }

  async function doRefresh(usedAccess: string): Promise<boolean> {
    const t = getTokens();
    if (!t) return false;
    // Другая вкладка уже обновила токены — просто повторяем запрос с новыми.
    if (t.access !== usedAccess) return true;
    try {
      const res = await fetch(`${API_URL}/staff/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: t.refresh }),
      });
      if (!res.ok) {
        // Гонка вкладок: refresh уже ротирован другой вкладкой — берём её токены.
        const now = getTokens();
        return Boolean(now && now.access !== usedAccess);
      }
      const body = (await res.json()) as { access_token: string; refresh_token: string };
      setTokens({ access: body.access_token, refresh: body.refresh_token });
      return true;
    } catch {
      return false;
    }
  }

  function refreshOnce(usedAccess: string): Promise<boolean> {
    if (!refreshing) {
      refreshing = doRefresh(usedAccess).finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  function url(path: string): string {
    return /^https?:\/\//.test(path) ? path : `${API_URL}${path}`;
  }

  async function raw(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const headers = new Headers(init.headers);
    const tokens = getTokens();
    const legacy = tokens ? null : getLegacy();
    if (tokens) headers.set('Authorization', `Bearer ${tokens.access}`);
    else if (legacy) headers.set('X-Admin-Token', legacy);
    if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    let res: Response;
    try {
      res = await fetch(url(path), { ...init, headers });
    } catch {
      throw new ApiError(0, 'network', `API недоступен (${API_URL}). Запустите сервер или проверьте NEXT_PUBLIC_API_URL`);
    }
    if (res.status === 401) {
      const err = await errorFrom(res);
      // Неверный текущий пароль при смене — это не потеря сессии.
      if (CREDENTIAL_CODES.has(err.code)) throw err;
      if (tokens && !retried && (await refreshOnce(tokens.access))) return raw(path, init, true);
      toLogin();
      throw new ApiError(401, err.code, err.code === 'admin_required' ? 'Нужно войти' : err.message);
    }
    if (!res.ok) {
      const err = await errorFrom(res);
      if (res.status === 403 && err.code === 'password_change_required') {
        const cached = cachedMe();
        if (cached) setCachedMe({ ...cached, must_change_password: true });
        goto(opts.passwordPath());
      }
      if (res.status === 403 && /^mfa_(setup|enroll)/.test(err.code)) {
        const cached = cachedMe();
        if (cached) setCachedMe({ ...cached, mfa_enabled: false, mfa_required: true });
        goto(opts.securityPath());
      }
      throw err;
    }
    return res;
  }

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await raw(path, init);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
  const put = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  const del = <T,>(path: string) => api<T>(path, { method: 'DELETE' });

  /** multipart/form-data: поле file + дополнительные поля. */
  function upload<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
    const form = new FormData();
    form.append('file', file);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return api<T>(path, { method: 'POST', body: form });
  }

  /** Скачивание файла с авторизацией: fetch → blob → ссылка. */
  async function download(path: string, fallbackName: string): Promise<void> {
    const res = await raw(path);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') ?? '';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) ?? /filename="?([^";]+)"?/i.exec(cd);
    let name = fallbackName;
    if (m?.[1]) {
      try {
        name = decodeURIComponent(m[1]);
      } catch {
        name = m[1];
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function authPost<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'network', `API недоступен (${API_URL})`);
    }
    if (!res.ok) {
      const err = await errorFrom(res);
      if (err.code === 'invalid_credentials') err.message = 'Неверная почта или пароль';
      throw err;
    }
    return (await res.json()) as T;
  }

  type TokenResponse = { access_token: string; refresh_token: string; staff?: StaffMe };

  async function accept(body: TokenResponse): Promise<StaffMe> {
    setLegacy(null);
    setTokens({ access: body.access_token, refresh: body.refresh_token });
    if (body.staff) {
      setCachedMe(body.staff);
      return body.staff;
    }
    return me();
  }

  /** Шаг 1: почта и пароль. Для сотрудника с 2FA — нужен код (шаг 2, loginMfa). */
  async function login(email: string, password: string): Promise<LoginResult> {
    const body = await authPost<TokenResponse & { mfa_required?: boolean; mfa_token?: string }>('/staff/auth/login', {
      email: email.trim().toLowerCase(),
      password,
    });
    if (body.mfa_required && body.mfa_token) return { kind: 'mfa', mfaToken: body.mfa_token };
    return { kind: 'ok', me: await accept(body) };
  }

  /** Шаг 2: код из приложения-аутентификатора или резервный код. */
  async function loginMfa(mfaToken: string, code: string): Promise<StaffMe> {
    const body = await authPost<TokenResponse>('/staff/auth/mfa', { mfa_token: mfaToken, code: code.replace(/\s/g, '') });
    return accept(body);
  }

  async function logout(): Promise<void> {
    const t = getTokens();
    clear();
    if (t) {
      try {
        await fetch(`${API_URL}/staff/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.access}` },
          body: JSON.stringify({ refresh_token: t.refresh }),
        });
      } catch {
        /* токены уже стёрты локально */
      }
    }
  }

  async function me(): Promise<StaffMe> {
    const m = await api<StaffMe>('/staff/me');
    setCachedMe(m);
    return m;
  }

  async function changePassword(current: string, next: string): Promise<void> {
    await post('/staff/me/password', { current_password: current, new_password: next });
    const cached = cachedMe();
    if (cached) setCachedMe({ ...cached, must_change_password: false });
  }

  return {
    scope: opts.scope,
    raw,
    api,
    post,
    put,
    patch,
    del,
    upload,
    download,
    login,
    loginMfa,
    logout,
    me,
    cachedMe,
    changePassword,
    hasSession,
    mode,
    getLegacy,
    setLegacy,
    clear,
    loginPath: opts.loginPath,
    passwordPath: opts.passwordPath,
    securityPath: opts.securityPath,
    setCachedMe,
  };
}

/** Право есть, если оно в списке или у сотрудника «*». */
export function can(perms: readonly string[] | null | undefined, ...need: string[]): boolean {
  if (!perms) return false;
  if (perms.includes('*')) return true;
  return need.some((p) => perms.includes(p));
}

export const ROLE_LABEL: Record<string, string> = {
  superadmin: 'Суперадмин',
  orders_manager: 'Менеджер заказов',
  catalog_manager: 'Менеджер каталога',
  support: 'Поддержка',
  vendor_owner: 'Владелец',
  vendor_designer: 'Конструктор',
};

export const PLATFORM_ROLES = ['superadmin', 'orders_manager', 'catalog_manager', 'support'];
export const VENDOR_ROLES = ['vendor_owner', 'vendor_designer'];

export function roleLabel(role: string | null | undefined): string {
  return role ? (ROLE_LABEL[role] ?? role) : '—';
}

/** Ссылки на файлы/фото из API: относительные — к адресу API. */
export function apiUrl(path: string): string {
  return /^https?:\/\//.test(path) ? path : `${API_URL}${path}`;
}

export function qs(params: Record<string, string | number | boolean | null | undefined | string[]>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Списки из API: массив или {items}. */
export function itemsOf<T>(data: T[] | { items?: T[] } | null | undefined): T[] {
  if (!data) return [];
  return Array.isArray(data) ? data : (data.items ?? []);
}
