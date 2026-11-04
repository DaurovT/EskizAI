/** Подписи кабинета поставщика (§5.3 статусы заказа, причины, возвраты). */

export const ORDER_STATUS: [string, string][] = [
  ['created', 'Новый, ждёт проверки'],
  ['returned', 'Возвращён мастеру'],
  ['awaiting_approval', 'Ждёт подтверждения исправления'],
  ['accepted', 'Принят, ждёт оплаты'],
  ['paid', 'Оплачен'],
  ['cutting', 'В раскрое'],
  ['ready', 'Готов'],
  ['issued', 'Выдан'],
  ['rejected', 'Отклонён'],
  ['cancelled', 'Отменён мастером'],
];

export const ORDER_STATUS_LABEL: Record<string, string> = Object.fromEntries(ORDER_STATUS);

export function statusColor(s: string): 'green' | 'red' | 'yellow' | undefined {
  if (s === 'rejected' || s === 'cancelled') return 'red';
  if (s === 'created' || s === 'returned' || s === 'awaiting_approval') return 'yellow';
  if (s === 'issued' || s === 'ready' || s === 'paid') return 'green';
  return undefined;
}

/** Производство: следующий статус (если сервер не прислал allowed_statuses). */
export const PRODUCTION_NEXT: Record<string, string> = { paid: 'cutting', cutting: 'ready', ready: 'issued' };

export const PRODUCTION_LABEL: Record<string, string> = {
  paid: 'Оплата получена',
  cutting: 'В раскрой',
  ready: 'Готов',
  issued: 'Выдан / отгружен',
};

/** Коды причин отклонения — §9 контракта (их видит и приложение мастера). */
export const REJECT_REASONS: [string, string][] = [
  ['wrong_measurements', 'Ошибка в замерах'],
  ['no_material', 'Нет материала / декора'],
  ['cannot_produce', 'Невозможно изготовить'],
  ['duplicate', 'Дубль заказа'],
  ['other', 'Другое'],
];

export const RETURN_KINDS: [string, string][] = [
  ['defect', 'Брак'],
  ['cut_error', 'Ошибка раскроя'],
  ['shortage', 'Недовложение'],
  ['cancel_after_pay', 'Отмена после оплаты'],
  ['other', 'Другое'],
];
export const RETURN_KIND_LABEL: Record<string, string> = Object.fromEntries(RETURN_KINDS);

export const RETURN_DECISIONS: [string, string][] = [
  ['redo', 'Переделать за счёт поставщика'],
  ['refund', 'Вернуть деньги'],
  ['declined', 'Отказать'],
];
export const RETURN_DECISION_LABEL: Record<string, string> = Object.fromEntries(RETURN_DECISIONS);

export const RETURN_STATUS_LABEL: Record<string, string> = {
  open: 'открыт',
  awaiting_owner: 'ждёт владельца',
  resolved: 'решён',
};

export const CORRECTION_STATUS_LABEL: Record<string, string> = {
  pending: 'ждёт мастера',
  approved: 'подтверждено',
  declined: 'мастер отказался',
  applied: 'применено (без изменения суммы)',
};

/** Дата из <input type=date> → конец рабочего дня по Ташкенту (API требует часовой пояс). */
export function dueDateIso(day: string): string | null {
  return day ? `${day}T18:00:00+05:00` : null;
}

/** ISO → YYYY-MM-DD по Ташкенту. */
export function isoDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Date(d.getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function parseNum(v: string): number | null {
  const s = v.replace(/[\s ]/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
