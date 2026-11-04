/**
 * Офлайн (NFR-07): последние загруженные проекты, модель, смета и чат читаются из кэша без сети.
 * Правка модели, ИИ и отправка — только с сетью. Замер без сети кладётся в очередь и уходит при связи.
 */
import type { Api } from './client';
import { ApiError } from './errors';
import type { MeasurementIn, MeasurementOut } from './types';

export interface KV {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
}

/** Методы, ответы которых кэшируются для просмотра без сети. */
export const CACHED_METHODS = [
  'listProjects', 'getProject', 'getModel', 'getEstimate', 'getClientEstimate', 'getChat', 'listVersions',
  'listClients', 'getClient', 'listOrders', 'getOrder', 'getWorkshop', 'limits', 'listFiles', 'listShareLinks', 'listMeasurements',
  'getNesting', 'listDecors', 'searchDecors', 'listPaintColors', 'getFrontStyles', 'getLightingZones', 'getBuiltinOptions', 'getHardware', 'listPriceRequests', 'listNonstandard',
  'listOrderMessages', 'listOrderCorrections', 'listOrderReturns', 'listOrderDisputes',
] as const;
type CachedMethod = (typeof CACHED_METHODS)[number];

export interface OfflineEvents {
  /** Ответ взят из кэша (нет сети). */
  onServedFromCache?: (method: string) => void;
  onOnline?: () => void;
}

const OUTBOX = 'outbox:measurements';
export const cacheKey = (m: string, args: unknown[]) => `cache:${m}:${JSON.stringify(args)}`;

export interface OfflineApi extends Api {
  flushOutbox(): Promise<number>;
  pendingMeasurements(projectId?: string): Promise<{ projectId: string; body: MeasurementIn; at: string }[]>;
  clearCache(): Promise<void>;
}

/** Повторить позже: нет сети или идут техработы (503 maintenance, SCR-45). */
const retryLater = (e: unknown) => e instanceof ApiError && (e.isNetwork || e.code === 'maintenance');

export function withOfflineCache(api: Api, kv: KV, ev: OfflineEvents = {}): OfflineApi {
  const wrapped: Record<string, unknown> = { ...api };
  const keys = new Set<string>();
  for (const m of CACHED_METHODS) {
    const fn = (api[m] as (...a: unknown[]) => Promise<unknown>).bind(api);
    wrapped[m] = async (...args: unknown[]) => {
      const key = cacheKey(m, args);
      try {
        const r = await fn(...args);
        keys.add(key);
        kv.setItem(key, JSON.stringify(r)).catch(() => undefined);
        ev.onOnline?.();
        return r;
      } catch (e) {
        if (e instanceof ApiError && e.isNetwork) {
          const cached = await kv.getItem(key).catch(() => null);
          if (cached != null) {
            ev.onServedFromCache?.(m as CachedMethod);
            return JSON.parse(cached);
          }
        }
        throw e;
      }
    };
  }

  const readOutbox = async () => {
    try {
      return JSON.parse((await kv.getItem(OUTBOX)) ?? '[]') as { projectId: string; body: MeasurementIn; at: string }[];
    } catch {
      return [];
    }
  };

  wrapped.addMeasurement = async (projectId: string, body: MeasurementIn): Promise<MeasurementOut> => {
    try {
      return await api.addMeasurement(projectId, body);
    } catch (e) {
      if (!retryLater(e)) throw e;
      const box = await readOutbox();
      const at = new Date().toISOString();
      box.push({ projectId, body, at });
      await kv.setItem(OUTBOX, JSON.stringify(box));
      return { id: `pending-${box.length}`, version_id: null, created_at: at, ...body };
    }
  };

  const out = wrapped as unknown as OfflineApi;
  out.pendingMeasurements = async (projectId) => (await readOutbox()).filter((x) => !projectId || x.projectId === projectId);
  out.flushOutbox = async () => {
    const box = await readOutbox();
    const left: typeof box = [];
    let sent = 0;
    for (const item of box) {
      try {
        await api.addMeasurement(item.projectId, item.body);
        sent += 1;
      } catch (e) {
        // сетевые и техработы — повторим позже; ошибки сервера (409 и т. п.) выбрасываем из очереди
        if (retryLater(e)) left.push(item);
      }
    }
    await kv.setItem(OUTBOX, JSON.stringify(left));
    return sent;
  };
  out.clearCache = async () => {
    await Promise.all([...keys].map((k) => kv.removeItem(k)));
    keys.clear();
  };
  return out;
}
