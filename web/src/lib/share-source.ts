import 'server-only';
import { mockShare, type MockResult } from './mock-share';
import type { ShareMaster } from './share-types';

export type ShareResult = MockResult;

/**
 * Источник данных ссылки. Сейчас — мок. Когда появится бэкенд, задать
 * SHARE_API_URL (например, https://api.example.uz/v1) — тогда данные берутся
 * из GET {SHARE_API_URL}/share/{token} в формате SharePayload.
 */
export async function getShare(token: string, viewOverride?: string | null): Promise<ShareResult> {
  const base = process.env.SHARE_API_URL;
  // ?view= — только для проверки мока; настоящий сервер отдаёт вид, выбранный мастером.
  if (!base) return mockShare(token, viewOverride);
  const res = await fetch(`${base}/share/${encodeURIComponent(token)}`, { cache: 'no-store' });
  if (res.status === 404) return { ok: false, status: 404, error: 'not_found' };
  if (res.status === 410) {
    // share_revoked — мастер отозвал ссылку или удалил аккаунт; share_expired — истёк срок
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; details?: { master?: ShareMaster } | null };
    } | null;
    const master = body?.error?.details?.master ?? undefined;
    return { ok: false, status: 410, error: body?.error?.code === 'share_revoked' ? 'revoked' : 'expired', master };
  }
  if (!res.ok) throw new Error(`share API: HTTP ${res.status}`);
  return { ok: true, data: await res.json() };
}
