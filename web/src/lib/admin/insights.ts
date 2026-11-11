/** Рабочий стол суперадмина: типы ответов /admin/insights/* и форматирование показателей. */

export interface Kpi {
  value: number;
  prev: number | null;
}

export interface SeriesRow {
  date: string;
  orders: number;
  registrations: number;
  projects: number;
  turnover?: number;
  ai_usd?: number;
}

export interface SupplierSnap {
  supplier_id: string | null;
  name: string;
  active: boolean;
  queue: number;
  overdue: number;
  oldest_hours: number | null;
  orders: number;
  rejected: number;
  paid: number;
  returns: number;
  median_accept_hours: number | null;
  return_rate: number | null;
}

export interface InsightsDashboard {
  from: string;
  to: string;
  prev_from: string;
  prev_to: string;
  days: number;
  sections: { money: boolean; ai: boolean; suppliers: boolean };
  kpis: Record<string, Kpi>;
  series: SeriesRow[];
  top_turnover?: { workshop_id: string; name: string; city: string; turnover: number; orders: number }[];
  top_ai?: { workshop_id: string; name: string; city: string; cost_usd: number; requests: number }[];
  suppliers?: SupplierSnap[];
  overdue_hours?: number;
}

export interface AlertItem {
  key: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  count: number;
  detail: string;
  href: string;
  items: { label: string; sub?: string; href: string }[];
}

export interface AlertsResponse {
  items: AlertItem[];
  count: number;
  maintenance: { on: boolean; until: string | null; message: { ru: string; uz: string } };
  generated_at: string;
}

export interface SearchResponse {
  q: string;
  total: number;
  groups: { key: string; title: string; items: { id: string; title: string; sub?: string; href: string }[] }[];
}

export interface AuditEntry {
  id: string;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  actor_role: string | null;
  ip: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  reason: string | null;
  workshop_id: string | null;
  workshop_name: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  href: string | null;
}

export interface AuditFacets {
  entities: { value: string; count: number }[];
  actions: Record<string, string[]>;
  actor_types: string[];
  staff: { id: string; name: string; email: string | null; role: string; is_active: boolean; supplier: boolean }[];
}

const NBSP = ' ';

function group3(n: number): string {
  return Math.round(Math.abs(n))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** Крупные суммы в плитках: «4,2 млн», «850 тыс.», «12 500». */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  const fmt = (v: number, unit: string) => `${sign}${v.toFixed(v >= 100 ? 0 : 1).replace('.', ',').replace(/,0$/, '')}${NBSP}${unit}`;
  if (a >= 1e9) return fmt(a / 1e9, 'млрд');
  if (a >= 1e6) return fmt(a / 1e6, 'млн');
  if (a >= 1e4) return fmt(a / 1e3, 'тыс.');
  return `${sign}${group3(a)}`;
}

/** Изменение к прошлому периоду: число процентов, «новое» (было 0) или null (нечего сравнивать). */
export function delta(k: Kpi | undefined): { pct: number | null; isNew: boolean } {
  if (!k || k.prev === null || k.prev === undefined) return { pct: null, isNew: false };
  if (k.prev === 0) return { pct: null, isNew: k.value > 0 };
  return { pct: ((k.value - k.prev) / Math.abs(k.prev)) * 100, isNew: false };
}

/** «02.11» из YYYY-MM-DD. */
export function dayLabel(d: string): string {
  return `${d.slice(8, 10)}.${d.slice(5, 7)}`;
}

/** Строка ISO-времени периода → дата по Ташкенту (DD.MM). Конец периода — исключительный, показываем минус секунду. */
export function periodDay(iso: string, end = false): string {
  const t = new Date(new Date(iso).getTime() - (end ? 1000 : 0) + 5 * 3600 * 1000);
  return `${String(t.getUTCDate()).padStart(2, '0')}.${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const SEVERITY_LABEL: Record<AlertItem['severity'], string> = {
  critical: 'Срочно',
  warning: 'Внимание',
  info: 'К сведению',
};
