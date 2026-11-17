/**
 * Единая переписка заказа (SCR-59, OrderChat.dc.html): сообщения мастера, конструктора и платформы, правки поставщика,
 * рекламации, споры и смены статуса — одной лентой по времени. Плюс шаги спора (что поменялось в правке — diffLines в orders.ts).
 * Без React — покрыто тестами (src/lib/__tests__/orderFeed.test.ts).
 */
import type { OrderCorrection, OrderDispute, OrderEvent, OrderMessage, OrderReturn, OrderStatus } from '../api/types';

export type FeedItem =
  | { kind: 'msg'; at: string; id: string; m: OrderMessage }
  | { kind: 'fix'; at: string; id: string; c: OrderCorrection }
  | { kind: 'return'; at: string; id: string; r: OrderReturn }
  | { kind: 'dispute'; at: string; id: string; d: OrderDispute }
  | { kind: 'sys'; at: string; id: string; status: OrderStatus };

/** Смены статуса, которые видны в ленте строкой по центру («Заказ оплачен · 15 нояб»). */
export const FEED_STATUSES: OrderStatus[] = ['accepted', 'paid', 'cutting', 'ready', 'issued', 'returned', 'rejected', 'cancelled'];

const time = (iso: string) => new Date(iso).getTime() || 0;

export function orderFeed(src: {
  messages?: OrderMessage[]; corrections?: OrderCorrection[]; returns?: OrderReturn[]; disputes?: OrderDispute[]; events?: OrderEvent[];
}): FeedItem[] {
  const out: FeedItem[] = [
    ...(src.messages ?? []).map((m): FeedItem => ({ kind: 'msg', at: m.created_at, id: `m:${m.id}`, m })),
    ...(src.corrections ?? []).map((c): FeedItem => ({ kind: 'fix', at: c.created_at, id: `c:${c.id}`, c })),
    ...(src.returns ?? []).map((r): FeedItem => ({ kind: 'return', at: r.created_at, id: `r:${r.id}`, r })),
    ...(src.disputes ?? []).map((d): FeedItem => ({ kind: 'dispute', at: d.created_at, id: `d:${d.id}`, d })),
  ];
  const seen = new Set<string>();
  for (const e of src.events ?? []) {
    if (e.type !== 'status_changed' || !e.status || !FEED_STATUSES.includes(e.status) || seen.has(e.status)) continue;
    seen.add(e.status); // один раз на статус: повторы «в распиле» после правки не нужны
    out.push({ kind: 'sys', at: e.created_at, id: `e:${e.id}`, status: e.status });
  }
  // по времени; при равном — как пришло (стабильная сортировка)
  return out.map((x, i) => [x, i] as const).sort((a, b) => time(a[0].at) - time(b[0].at) || a[1] - b[1]).map(([x]) => x);
}

/** Сколько правок ждут ответа мастера (красная цифра на вкладке «Правки»). */
export const pendingFixes = (list: OrderCorrection[]) => list.filter((c) => c.status === 'pending').length;

export type DisputeStep = { key: 'declined' | 'opened' | 'decision'; done: boolean; at: string | null };

/** Шаги спора по рекламации (вкладка «Спор»): отказ поставщика → спор открыт → решение менеджера платформы. */
export function disputeSteps(d: OrderDispute, r?: OrderReturn | null): DisputeStep[] {
  return [
    ...(d.subject === 'return' ? [{ key: 'declined' as const, done: true, at: r?.decided_at ?? null }] : []),
    { key: 'opened', done: true, at: d.created_at },
    { key: 'decision', done: d.status === 'resolved', at: d.resolved_at ?? null },
  ];
}
