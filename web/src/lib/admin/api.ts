'use client';

/** Клиент API админки: токен в localStorage, заголовок X-Admin-Token, ошибки API по-русски. */

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000').replace(/\/$/, '');
const TOKEN_KEY = 'mebel_admin_token';

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* приватный режим — токен живёт до перезагрузки */
  }
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

function toLogin() {
  setToken(null);
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/admin/login')) {
    window.location.href = '/admin/login';
  }
}

async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('X-Admin-Token', token);
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'network', `API недоступен (${API_URL}). Запустите сервер или проверьте NEXT_PUBLIC_API_URL`);
  }
  if (res.status === 401) {
    toLogin();
    throw new ApiError(401, 'admin_required', 'Нужен токен админки');
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = `Ошибка ${res.status}`;
    let details: unknown;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
      if (body.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        details = body.error.details;
      }
    } catch {
      /* не JSON */
    }
    throw new ApiError(res.status, code, message, details);
  }
  return res;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await raw(path, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

/** Скачивание файла с токеном: fetch → blob → ссылка. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await raw(path);
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = /filename="([^"]+)"/.exec(cd);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Проверка токена при входе: любой защищённый эндпоинт. */
export async function checkToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/admin/settings`, { headers: { 'X-Admin-Token': token } });
    return res.ok;
  } catch {
    throw new ApiError(0, 'network', `API недоступен (${API_URL})`);
  }
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
