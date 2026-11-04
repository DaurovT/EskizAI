'use client';

/**
 * Клиент API админки. Вход сотрудника по почте и паролю → `Authorization: Bearer …`
 * (с автообновлением токена); переходный режим — общий токен в `X-Admin-Token`.
 * Ошибки API — по-русски (ApiError).
 */
import { API_URL, ApiError, createStaffClient, qs } from '@/lib/staff/client';

export { API_URL, ApiError, qs };

/** Ключ старого общего токена — прежний, чтобы открытые сессии владельца не слетели. */
const LEGACY_KEY = 'mebel_admin_token';

export const adminClient = createStaffClient({
  scope: 'admin',
  loginPath: () => '/admin/login',
  passwordPath: () => '/admin/password',
  securityPath: () => '/admin/security',
  legacyKey: LEGACY_KEY,
});

export const { api, post, put, patch, del, upload, download } = adminClient;

/** Есть ли вход (сотрудник или старый токен). */
export function getToken(): string | null {
  return adminClient.hasSession() ? '1' : null;
}

/** Проверка старого токена админки: любой защищённый эндпоинт. */
export async function checkToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/admin/settings`, { headers: { 'X-Admin-Token': token } });
    return res.ok;
  } catch {
    throw new ApiError(0, 'network', `API недоступен (${API_URL})`);
  }
}
