/** ADM-09: общие типы и подписи заявок «нестандарт». */

export const NS_STATUSES: [string, string][] = [
  ['sent', 'Отправлена'],
  ['estimated', 'Оценена'],
  ['in_work', 'В работе'],
  ['done', 'Готово'],
  ['cancelled', 'Отменена'],
];

export interface NsRow {
  id: string;
  number: number | null;
  project_id: string;
  project_title: string | null;
  workshop_name?: string | null;
  description: string;
  status: string;
  status_label: string;
  path: 'eman' | 'self';
  assignee: string | null;
  price: number | null;
  lead_days: number | null;
  created_at: string;
}

export function nsColor(status: string): 'green' | 'red' | 'yellow' | undefined {
  return status === 'done' ? 'green' : status === 'cancelled' ? 'red' : status === 'sent' ? 'yellow' : undefined;
}

