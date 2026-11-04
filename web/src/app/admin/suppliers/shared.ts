/** Общие типы и подписи раздела «Поставщики». */

export interface Supplier {
  id: string;
  code: string;
  name: string;
  order_method?: string | null;
  commission_percent?: number | null;
  contacts?: Record<string, unknown> | null;
  site_url?: string | null;
  /** false — поставщик заблокирован (POST /admin/suppliers/{id}/block). */
  active?: boolean;
  blocked_reason?: string | null;
  settings?: Record<string, unknown> | null;
  /** Карточка GET /admin/suppliers/{id}: */
  commissions?: { id: string; category: string | null; rate_percent: number; effective_from: string; reason?: string | null }[];
  routes?: string[];
  staff?: { id: string; name: string; email: string; role: string; is_active: boolean }[];
  metrics?: Record<string, unknown> | null;
}

/** Категории строк состава заказа (типы ядра) + новые. Код категории — только a-z и «_». */
export const CATEGORY_LABEL: Record<string, string> = {
  sheet: 'Листы (ЛДСП, ДВП)',
  edge: 'Кромка',
  hardware: 'Фурнитура',
  countertop: 'Столешницы',
  front: 'Фасады',
  service: 'Услуги',
  other: 'Прочее',
  metal: 'Металл',
  glass: 'Стекло',
  nonstandard: 'Нестандарт',
};

/** Реквизиты и настройки организации (suppliers.settings). */
export const SETTINGS_FIELDS: [string, string, ('text' | 'date' | 'number')?][] = [
  ['legal_name', 'Юр. название'],
  ['inn', 'ИНН'],
  ['bank_name', 'Банк'],
  ['bank_account', 'Расчётный счёт'],
  ['mfo', 'МФО'],
  ['legal_address', 'Юр. адрес'],
  ['warehouse_address', 'Склад / самовывоз'],
  ['contact_name', 'Контактное лицо'],
  ['contact_phone', 'Телефон'],
  ['contact_email', 'Почта'],
  ['contract_number', 'Договор №'],
  ['contract_date', 'Договор от', 'date'],
  ['contract_until', 'Договор до', 'date'],
  ['default_lead_days', 'Срок производства по умолчанию, дней', 'number'],
];

/** finance.supplier_metrics(): orders, paid, avg_response_hours, returns_share, rejected_share, overdue, overdue_hours. */
export const PERFORMANCE_LABEL: Record<string, string> = {
  orders: 'Заказов всего',
  paid: 'Оплачено заказов',
  avg_response_hours: 'Среднее время ответа конструктора, ч',
  returns_share: 'Доля возвратов (от оплаченных)',
  rejected_share: 'Доля отклонённых заказов',
  overdue: 'Просрочено сейчас (без ответа)',
  overdue_hours: 'Порог просрочки, ч',
};

export function fmtValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') {
    if (/share/.test(key)) return `${(v * 100).toFixed(1)}%`;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
