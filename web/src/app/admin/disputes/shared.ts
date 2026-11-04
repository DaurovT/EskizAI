/** Споры по заказам (§4a): общие типы и подписи. Ответ API — _dispute_full() в routers/admin_platform.py. */

export interface Attachment {
  key?: string;
  url: string;
  name?: string | null;
  content_type?: string | null;
  size?: number | null;
}

export interface DisputeReturn {
  id: string;
  type?: string | null;
  description?: string | null;
  lines?: { name?: string; key?: string; qty?: number; unit?: string; total?: number; amount?: number }[];
  amount?: number | null;
  photos?: Attachment[];
  status?: string | null;
  decision?: string | null;
  decision_comment?: string | null;
  refund_amount?: number | null;
}

export interface DisputeRow {
  id: string;
  order_id: string;
  subject: 'return' | 'rejection' | string;
  return_id?: string | null;
  reason: string;
  comment?: string | null;
  photos?: Attachment[];
  status: 'open' | 'resolved' | string;
  decision?: string | null;
  decision_comment?: string | null;
  /** До решения — запрошенная сумма, после — решённая. */
  amount?: number | null;
  requested_amount?: number | null;
  created_at: string;
  resolved_at?: string | null;
  order_number?: number | null;
  order_status?: string | null;
  order_total?: number | null;
  reject_reason?: string | null;
  workshop_name?: string | null;
  supplier_name?: string | null;
  return?: DisputeReturn | null;
}

export const DECISION_LABEL: Record<string, string> = {
  master: 'В пользу мастера',
  supplier: 'В пользу поставщика',
  partial: 'Частично',
};

export const SUBJECT_LABEL: Record<string, string> = {
  return: 'Решение по возврату',
  rejection: 'Отклонение заказа',
};

export const RETURN_DECISION: Record<string, string> = {
  redo: 'переделать за счёт поставщика',
  refund: 'вернуть деньги',
  declined: 'отказ',
};
