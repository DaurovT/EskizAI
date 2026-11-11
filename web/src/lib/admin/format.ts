const NBSP = ' ';

export function sum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const s = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${n < 0 ? '−' : ''}${s}${NBSP}сум`;
}

/** Для плиток: от миллиона — «12,5 млн сум», чтобы сумма помещалась. */
export function sumShort(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a < 1_000_000) return sum(n);
  const v = a >= 1e9 ? a / 1e9 : a / 1e6;
  const s = (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '')).replace('.', ',');
  return `${n < 0 ? '−' : ''}${s}${NBSP}${a >= 1e9 ? 'млрд' : 'млн'}${NBSP}сум`;
}

export function range(r: { from: number; to: number } | null | undefined): string {
  if (!r) return '—';
  return r.from === r.to ? sum(r.from) : `${sum(r.from).replace(`${NBSP}сум`, '')} – ${sum(r.to)}`;
}

export function usd(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined) return '—';
  return `$${n.toFixed(digits)}`;
}

/** ISO → «02.11.2026 14:05» по Ташкенту (UTC+5). */
export function dt(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const t = new Date(d.getTime() + 5 * 3600 * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  const date = `${p(t.getUTCDate())}.${p(t.getUTCMonth() + 1)}.${t.getUTCFullYear()}`;
  return withTime ? `${date} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}` : date;
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

export const PROJECT_STATUSES: [string, string][] = [
  ['draft', 'Черновик'],
  ['sketch', 'Эскиз'],
  ['sent', 'Отправлен'],
  ['measured', 'Замер'],
  ['contract', 'Договор'],
  ['in_work', 'В работе'],
  ['delivered', 'Сдан'],
  ['cancelled', 'Отменён'],
];

/** Статусы заказа (§5.3): основной путь, затем побочные. */
export const ORDER_STATUSES: [string, string][] = [
  ['created', 'Создан (в очереди)'],
  ['accepted', 'Принят поставщиком'],
  ['paid', 'Оплачен'],
  ['cutting', 'В распиле'],
  ['ready', 'Готов'],
  ['issued', 'Выдан'],
  ['returned', 'Возвращён мастеру'],
  ['awaiting_approval', 'Ждёт подтверждения исправления'],
  ['rejected', 'Отклонён поставщиком'],
  ['cancelled', 'Отменён'],
];

export function orderStatusColor(status: string): 'green' | 'red' | 'yellow' | undefined {
  if (status === 'cancelled' || status === 'rejected') return 'red';
  if (status === 'created' || status === 'returned' || status === 'awaiting_approval') return 'yellow';
  if (status === 'issued' || status === 'ready') return 'green';
  return undefined;
}

/** Даты для фильтров периода: YYYY-MM-DD по Ташкенту. */
export function isoDay(d: Date): string {
  const t = new Date(d.getTime() + 5 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
  return isoDay(new Date(Date.now() - n * 86400 * 1000));
}

export const ORDER_STATUS_LABEL: Record<string, string> = Object.fromEntries(ORDER_STATUSES);

export const ITEM_TYPES: [string, string][] = [
  ['sheet', 'Листы'],
  ['edge', 'Кромка'],
  ['hardware', 'Фурнитура'],
  ['service', 'Услуги'],
  ['countertop', 'Столешницы'],
  ['front', 'Фасады'],
  ['other', 'Прочее'],
];

export const ITEM_TYPE_LABEL: Record<string, string> = Object.fromEntries(ITEM_TYPES);

export const MATCH_LABEL: Record<string, string> = {
  new: 'новая',
  changed: 'изменена',
  unchanged: 'без изменений',
  invalid: 'ошибка',
  pending: 'не сопоставлена',
};

export const REVIEW_LABEL: Record<string, string> = {
  auto: 'авто',
  pending: 'ждёт проверки',
  approved: 'подтверждена',
  rejected: 'отклонена',
};
