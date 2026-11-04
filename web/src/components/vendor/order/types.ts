/** Карточка заказа в кабинете поставщика — GET /vendor/orders/{id} (§5.5). Поля необязательны: бэкенд дополняет. */
import type { Attachment } from '@/components/staff/OrderChat';

export interface Line {
  key: string;
  name: string;
  unit: string;
  qty: number;
  price: number;
  total: number;
  sku?: string | null;
  category?: string | null;
  group?: string | null;
}

export interface OrderEvent {
  id?: string;
  kind?: string;
  type?: string;
  action?: string;
  status?: string | null;
  from_status?: string | null;
  to_status?: string | null;
  actor_type?: string | null;
  actor_name?: string | null;
  comment?: string | null;
  data?: Record<string, unknown> | null;
  created_at: string;
}

export interface Correction {
  id: string;
  author_name?: string | null;
  comment?: string | null;
  lines_before?: Line[];
  lines_after?: Line[];
  total_before?: number | null;
  total_after?: number | null;
  files?: Attachment[];
  status: 'pending' | 'approved' | 'declined' | string;
  master_comment?: string | null;
  decision_comment?: string | null;
  delta?: number | null;
  decided_at?: string | null;
  created_at: string;
}

export interface OrderReturn {
  decided_by?: string | null;
  id: string;
  order_id: string;
  order_number?: number | null;
  project_title?: string | null;
  workshop_name?: string | null;
  opened_by_type?: string | null;
  created_by?: string | null;
  number?: number | null;
  /** Тип рекламации (§9: type; ранние ответы — kind). */
  type?: string;
  kind?: string;
  lines?: { key?: string; name?: string; qty?: number; amount?: number }[];
  amount?: number | null;
  description?: string | null;
  photos?: Attachment[];
  decision?: string | null;
  decision_comment?: string | null;
  status: string;
  refund_amount?: number | null;
  resolved_at?: string | null;
  created_at: string;
}

export interface VOrder {
  id: string;
  number?: number | null;
  group_id?: string | null;
  status: string;
  status_label?: string;
  project_id?: string;
  project_title?: string | null;
  version_number?: number | null;
  workshop_name?: string | null;
  workshop_phone?: string | null;
  master_name?: string | null;
  master_phone?: string | null;
  assignee_id?: string | null;
  assignee_name?: string | null;
  due_date?: string | null;
  reject_reason?: string | null;
  reject_comment?: string | null;
  return_comment?: string | null;
  vendor_status_note?: string | null;
  estimate_total?: number | null;
  invoice_total?: number | null;
  payment_url?: string | null;
  paid_at?: string | null;
  notes?: string | null;
  created_at: string;
  lines?: Line[];
  cost_total?: number | null;
  supplier_order?: {
    excluded?: string[];
    goods_total?: number;
    delivery?: { distance_km: number; cost: number } | null;
    weight_kg?: number;
  } | null;
  project?: {
    id?: string;
    title?: string | null;
    dimensions?: unknown;
    measurements?: unknown;
    photos?: (Attachment | string)[];
    viewer_url?: string | null;
    model_url?: string | null;
    share_url?: string | null;
    version_number?: number | null;
    comment?: string | null;
  } | null;
  photos?: (Attachment | string)[];
  measurements?: unknown;
  dimensions?: unknown;
  viewer_url?: string | null;
  /** GET-ссылка на 3D-модель версии (JSON для просмотрщика). */
  model_url?: string | null;
  files?: (Attachment & { kind?: string; label?: string; title?: string })[];
  csv_url?: string | null;
  allowed_statuses?: string[];
  allowed_actions?: string[];
  history?: OrderEvent[];
  events?: OrderEvent[];
  corrections?: Correction[];
  returns?: OrderReturn[];
  unread_messages?: number;
}

/** Ответ API → плоская карточка: assignee {id,name}, workshop {...}, master {...}, project.version {...}. */
type Raw = VOrder & {
  assignee?: { id: string; name: string } | null;
  workshop?: { id?: string; name?: string; phone?: string | null; city?: string | null } | null;
  master?: { id?: string; name?: string | null; phone?: string | null } | null;
  excluded?: string[];
  delivery?: { distance_km: number; cost: number } | null;
  goods_total?: number | null;
  project?: (VOrder['project'] & { version?: { id?: string; number?: number; viewer_url?: string | null } | null }) | null;
};

export function normalizeOrder(raw: VOrder): VOrder {
  const r = raw as Raw;
  const version = r.project?.version ?? null;
  return {
    ...r,
    assignee_id: r.assignee_id ?? r.assignee?.id ?? null,
    assignee_name: r.assignee_name ?? r.assignee?.name ?? null,
    workshop_name: r.workshop_name ?? r.workshop?.name ?? null,
    workshop_phone: r.workshop_phone ?? r.workshop?.phone ?? null,
    master_name: r.master_name ?? r.master?.name ?? null,
    master_phone: r.master_phone ?? r.master?.phone ?? null,
    version_number: r.version_number ?? version?.number ?? null,
    model_url: version?.viewer_url ?? null,
    supplier_order:
      r.supplier_order ??
      (r.excluded || r.delivery !== undefined || r.goods_total != null
        ? { excluded: r.excluded ?? [], delivery: r.delivery ?? null, goods_total: r.goods_total ?? undefined }
        : null),
  };
}
