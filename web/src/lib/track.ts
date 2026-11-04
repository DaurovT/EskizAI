import type { ShareEvent, ShareEventBody } from './share-types';

/**
 * Аналитика ссылки (FR-21). Пока заглушка: POST /api/share/{token}/events.
 * Ошибки сети глотаем — аналитика не должна ломать страницу.
 */
export function track(token: string, event: ShareEvent, meta?: ShareEventBody['meta']): void {
  const body: ShareEventBody = { event, at: new Date().toISOString(), ...(meta ? { meta } : {}) };
  const url = `/api/share/${encodeURIComponent(token)}/events`;
  try {
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}
