/** Заказ поставщику: группы состава для SCR-14, оплата SCR-31 (без React — покрыто тестами, кроме orderTone). */
import type { OrderLine, OrderOut, OrderPreview } from '../api/types';
import type { OrderStatus } from '../api/types';
import { colors } from '../ui/theme';

export const orderTone = (s: OrderStatus) =>
  s === 'issued' || s === 'ready' ? { fg: colors.ok, bg: colors.okSoft } : s === 'cancelled' ? { fg: colors.danger, bg: colors.dangerSoft } : s === 'created' ? { fg: colors.warn, bg: colors.warnSoft } : { fg: colors.primary, bg: colors.primarySoft };

export type OrderGroupKey = 'sheets' | 'cutting' | 'edging' | 'hardware' | 'other';
export interface OrderGroup { key: OrderGroupKey; lines: OrderLine[]; total: number }

/** Ключи строк ядра: sheet:… — листы, service:cut:… — распил, edge:… — кромкование, hw:… — фурнитура. */
export function groupOf(key: string): OrderGroupKey {
  if (key.startsWith('sheet:') || key.startsWith('countertop:')) return 'sheets';
  if (key.startsWith('service:cut')) return 'cutting';
  if (key.startsWith('edge:') || key.startsWith('service:edging')) return 'edging';
  if (key.startsWith('hw:')) return 'hardware';
  return 'other';
}

const ORDER: OrderGroupKey[] = ['sheets', 'cutting', 'edging', 'hardware', 'other'];

export function groupLines(lines: OrderLine[]): OrderGroup[] {
  const by = new Map<OrderGroupKey, OrderLine[]>();
  for (const l of lines) by.set(groupOf(l.key), [...(by.get(groupOf(l.key)) ?? []), l]);
  return ORDER.filter((k) => by.has(k)).map((k) => ({ key: k, lines: by.get(k)!, total: by.get(k)!.reduce((a, l) => a + l.total, 0) }));
}

/** Расстояние доставки из поля ввода: «12,5» → 12.5; пусто/ошибка → null (самовывоз нельзя путать с 0 км). */
export function parseKm(text: string): number | null {
  const v = Number(text.replace(',', '.').trim());
  return text.trim() && Number.isFinite(v) && v >= 0 && v <= 500 ? Math.round(v * 10) / 10 : null;
}

export const previewCheck = (p: OrderPreview) => p.total === p.goods_total + (p.delivery?.cost ?? 0);

/** Кнопка оплаты: есть ссылка от EMAN и заказ ещё не оплачен. */
export const canPay = (o: Pick<OrderOut, 'payment' | 'status'>) =>
  o.status !== 'cancelled' && !!o.payment && o.payment.status !== 'paid' && !!o.payment.url;

export const methodLabel = (m: string | null | undefined) => (m === 'click' ? 'Click' : m === 'payme' ? 'Payme' : m === 'invoice' ? 'EMAN' : null);
