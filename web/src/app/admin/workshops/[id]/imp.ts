/**
 * Токен «глазами мастера» (§4a): короткий access-токен мастера только на чтение (POST /admin/workshops/{id}/impersonate).
 * Живёт только в этой вкладке (sessionStorage, в приватном режиме — в памяти страницы) и до истечения срока;
 * в localStorage не пишется, на другие вкладки и после закрытия браузера не переживает.
 */

export interface Impersonation {
  access_token: string;
  expires_in?: number;
  expires_at?: string;
  read_only?: boolean;
  user_id?: string;
  workshop_id?: string;
  user_name?: string | null;
  user_phone?: string | null;
  user_role?: string | null;
  workshop_name?: string | null;
  reason?: string;
}

const memory = new Map<string, Impersonation>();

export const impKey = (workshopId: string) => `eskiz_imp_${workshopId}`;

export function saveImp(workshopId: string, imp: Impersonation): void {
  memory.set(workshopId, imp);
  try {
    sessionStorage.setItem(impKey(workshopId), JSON.stringify(imp));
  } catch {
    /* приватный режим — остаётся в памяти до перезагрузки */
  }
}

export function loadImp(workshopId: string): Impersonation | null {
  let imp = memory.get(workshopId) ?? null;
  if (!imp) {
    try {
      const raw = sessionStorage.getItem(impKey(workshopId));
      imp = raw ? (JSON.parse(raw) as Impersonation) : null;
    } catch {
      imp = null;
    }
  }
  if (!imp?.access_token || !imp.expires_at || new Date(imp.expires_at).getTime() <= Date.now()) return imp ? { ...imp, access_token: '' } : null;
  return imp;
}

export function clearImp(workshopId: string): void {
  memory.delete(workshopId);
  try {
    sessionStorage.removeItem(impKey(workshopId));
  } catch {
    /* нечего чистить */
  }
}
