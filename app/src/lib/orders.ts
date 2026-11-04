/**
 * Заказ поставщику: группы состава для SCR-14, оплата SCR-31, статусы и действия мастера по контракту
 * docs/staff_vendor_contract.md §5.3/§5.6 (без React — покрыто тестами, кроме orderTone).
 */
import type {
  DisputeSubject, OrderDispute, OrderLine, OrderLineRef, OrderOut, OrderPreview, OrderReturn, OrderStatus, OrderStep,
} from '../api/types';
import { ORDER_FLOW } from '../api/types';
import { tones, type Tone } from '../ui/theme';

export const orderTone = (s: OrderStatus) => ({ fg: tones[statusTone(s)].fg, bg: tones[statusTone(s)].bg });

/** Цвет статуса заказа (метка в списке, история, уведомления). */
export function statusTone(s: OrderStatus): Tone {
  switch (s) {
    case 'ready': return 'green';
    case 'issued': case 'cancelled': return 'gray';
    case 'cutting': case 'returned': case 'awaiting_approval': return 'amber';
    case 'rejected': return 'red';
    default: return 'blue';
  }
}

/** Ждёт оплаты: счёт есть (или старый порядок — ссылка при created), денег ещё нет. */
const unpaid = (o: Pick<OrderOut, 'status' | 'payment'>) =>
  (o.status === 'accepted' || (o.status === 'created' && !!o.payment?.url)) && !!o.payment && o.payment.status !== 'paid';

/**
 * Метка и подпись строки заказа (SCR-15) — ключи словаря: метка `os_*` / `ol_unpaid`, подпись `ol_*`.
 * Подпись с датой — `ol_ready_by` с параметром date (ISO), её форматирует экран.
 */
export function orderBadge(o: Pick<OrderOut, 'status' | 'payment'>): { label: string; tone: Tone } {
  if (unpaid(o)) return { label: 'ol_unpaid', tone: 'red' };
  return { label: `os_${o.status}`, tone: statusTone(o.status) };
}
export function orderNote(o: Pick<OrderOut, 'status' | 'payment' | 'ready_date' | 'due_date'>): { key: string; date?: string } | null {
  if (unpaid(o)) return { key: 'ol_wait_pay' };
  switch (o.status) {
    case 'created': return { key: 'ol_in_review' };
    case 'returned': return { key: 'ol_returned' };
    case 'awaiting_approval': return { key: 'ol_awaiting' };
    case 'rejected': return { key: 'ol_rejected' };
    case 'ready': return { key: 'ol_pickup' };
    case 'issued': return { key: 'ol_issued' };
    case 'cancelled': return { key: 'ol_cancelled' };
    default: {
      const d = dueDate(o);
      return d ? { key: 'ol_ready_by', date: d } : null;
    }
  }
}

/** Заказ требует действия мастера (фильтр «Активные», счётчик). */
export const needsMaster = (o: Pick<OrderOut, 'status' | 'payment'>) => o.status === 'returned' || o.status === 'awaiting_approval' || unpaid(o);
/** «Активные» в SCR-15: всё, что ещё в работе или ждёт мастера. */
export const isActiveOrder = (o: Pick<OrderOut, 'status'>) => !['ready', 'issued', 'cancelled', 'rejected'].includes(o.status);

/** Полоса прогресса строки: доля пройденных шагов основного пути. */
export function orderProgress(o: Pick<OrderOut, 'status'>): number {
  if (o.status === 'ready' || o.status === 'issued') return 1;
  if (o.status === 'cancelled' || o.status === 'rejected') return 0;
  const at = o.status === 'returned' ? 'created' : o.status === 'awaiting_approval' ? 'created' : o.status;
  return (ORDER_FLOW.indexOf(at) + 1) / ORDER_FLOW.length;
}

/**
 * Шаги карточки (SCR-16): шаги сервера, если они есть и статус — на основном пути; для побочных статусов
 * шаги строятся здесь: returned — «Создан» текущий (на правке), awaiting_approval — «Принят» текущий (ждёт мастера).
 * Старый порядок (paid раньше accepted): шаг «Принят» отмечается пройденным, если заказ уже дальше по пути.
 */
export function orderSteps(o: Pick<OrderOut, 'status' | 'steps' | 'created_at' | 'paid_at'>): OrderStep[] {
  const side = o.status === 'returned' || o.status === 'awaiting_approval';
  if (o.steps?.length && !side) return o.steps;
  const cur: OrderStatus = o.status === 'returned' ? 'created' : o.status === 'awaiting_approval' ? 'accepted' : o.status;
  const idx = ORDER_FLOW.indexOf(cur);
  return ORDER_FLOW.map((s, i) => ({
    status: s, label: s, current: s === cur, done: idx >= 0 && (i < idx || (i === idx && !side)),
    at: s === 'created' ? o.created_at : s === 'paid' ? o.paid_at ?? null : null,
  }));
}

/** Срок готовности: от конструктора (due_date) или старый ready_date. */
export const dueDate = (o: Pick<OrderOut, 'ready_date' | 'due_date'>) => o.due_date ?? o.ready_date ?? null;
/** Имя конструктора: объект assignee или assignee_name. */
export const assigneeName = (o: Pick<OrderOut, 'assignee' | 'assignee_name'>) => o.assignee?.name ?? o.assignee_name ?? null;
/** Сумма к оплате: счёт конструктора, иначе по смете. */
export const invoiceTotal = (o: Pick<OrderOut, 'invoice_total' | 'total'>) => o.invoice_total ?? o.total ?? null;

/** «Исправить и отправить заново» — только после «Вернуть мастеру». */
export const canResubmit = (o: Pick<OrderOut, 'status'>) => o.status === 'returned';
/** «Сообщить о проблеме»: рекламация — по оплаченному заказу (оплачен, в распиле, готов, выдан). */
export const canReport = (o: Pick<OrderOut, 'status' | 'payment'>) =>
  ['paid', 'cutting', 'ready', 'issued'].includes(o.status) || (o.status === 'accepted' && o.payment?.status === 'paid');
/** Спор по отклонению: заказ отклонён и спора по нему ещё нет. */
export const canDisputeRejection = (o: Pick<OrderOut, 'status'>, disputes: OrderDispute[]) =>
  o.status === 'rejected' && !disputes.some((d) => d.subject === 'rejection');
/** Спор по рекламации: поставщик решил (кроме «переделать» без претензий — тоже можно) и спора по ней ещё нет. */
export const canDisputeReturn = (r: Pick<OrderReturn, 'id' | 'decision' | 'status'>, disputes: OrderDispute[]) =>
  !!r.decision && r.status !== 'awaiting_owner' && !disputes.some((d) => d.subject === 'return' && d.return_id === r.id);
export const disputeFor = (disputes: OrderDispute[], subject: DisputeSubject, returnId?: string | null) =>
  disputes.find((d) => d.subject === subject && (subject === 'rejection' || d.return_id === returnId)) ?? null;

/** Непрочитанные сообщения по всем заказам (вкладка «Заказы»). */
export const unreadTotal = (orders: Pick<OrderOut, 'unread_count'>[]) => orders.reduce((a, o) => a + (o.unread_count ?? 0), 0);

export type LineDiffKind = 'added' | 'removed' | 'changed' | 'same';
export interface LineDiff { key: string; name: string; unit: string | null; before: OrderLineRef | null; after: OrderLineRef | null; kind: LineDiffKind }
const lineKey = (l: OrderLineRef) => l.key || l.name;
const lineSum = (l: OrderLineRef) => l.total ?? (l.qty != null && l.price != null ? l.qty * l.price : null);
/**
 * Исправление поставщика: строки «было → стало» по ключу (или названию). Порядок — как в «стало», удалённые в конце.
 * Изменённой считается строка с другим количеством, ценой или суммой.
 */
export function diffLines(before: OrderLineRef[], after: OrderLineRef[]): LineDiff[] {
  const prev = new Map(before.map((l) => [lineKey(l), l]));
  const out: LineDiff[] = [];
  for (const a of after) {
    const k = lineKey(a);
    const b = prev.get(k) ?? null;
    prev.delete(k);
    const same = !!b && b.qty === a.qty && (b.price ?? null) === (a.price ?? null) && lineSum(b) === lineSum(a);
    out.push({ key: k, name: a.name, unit: a.unit ?? b?.unit ?? null, before: b, after: a, kind: !b ? 'added' : same ? 'same' : 'changed' });
  }
  for (const [k, b] of prev) out.push({ key: k, name: b.name, unit: b.unit ?? null, before: b, after: null, kind: 'removed' });
  return out;
}

/** Ссылка вложения: абсолютная — как есть, путь сервера (/files/…) — от адреса API. */
export function attachmentUrl(url: string | null | undefined, base: string): string | null {
  if (!url) return null;
  if (/^(https?:|file:|data:|content:|ph:|assets-library:)/.test(url)) return url;
  return `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

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
  !['cancelled', 'rejected', 'returned', 'awaiting_approval'].includes(o.status) && !!o.payment && o.payment.status !== 'paid' && !!o.payment.url;

export const methodLabel = (m: string | null | undefined) => (m === 'click' ? 'Click' : m === 'payme' ? 'Payme' : m === 'invoice' ? 'EMAN' : null);

/** Права в заказе (session: владелец — всё, сотрудник — по флагам can_order / can_see_cost). */
export interface OrderRights { canOrder: boolean; seesCost: boolean }
export interface OrderAccess {
  /** Переписка с поставщиком (и счётчик непрочитанных — ведёт в неё). */
  chat: boolean;
  /** Возвраты и рекламации: список и «Сообщить о проблеме». */
  returns: boolean;
  /** Споры: по отклонению и по решённому возврату. */
  disputes: boolean;
  /** Список исправлений поставщика и «Отклонить». */
  corrections: boolean;
  /** «Подтвердить» исправление: новую сумму подтверждает только тот, кто её видит. */
  approveCorrection: boolean;
  /** «Отправить заново» после «Вернуть мастеру». */
  resubmit: boolean;
  /** Отмена заказа до оплаты. */
  cancel: boolean;
  /** Суммы заказа, исправлений, возвратов и споров (сервер без права их не отдаёт). */
  amounts: boolean;
}
/**
 * Что показывать в заказе (docs/staff_vendor_contract.md §8): переписка, возвраты, споры, исправления и resubmit — владелец
 * или сотрудник с правом заказа (иначе сервер отвечает 403); подтвердить исправление — ещё и с правом «видит себестоимость».
 */
export const orderAccess = ({ canOrder, seesCost }: OrderRights): OrderAccess => ({
  chat: canOrder, returns: canOrder, disputes: canOrder, corrections: canOrder,
  approveCorrection: canOrder && seesCost, resubmit: canOrder, cancel: canOrder, amounts: seesCost,
});
