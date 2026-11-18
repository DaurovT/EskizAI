/** Типы ответов API Eskiz Oyna (oyna_api/*, oyna_core/api.py). Поля — как отдаёт сервер. */

export type Role = 'owner' | 'manager' | 'measurer' | 'installer' | 'production';
export type Severity = 'block' | 'lock' | 'warn' | 'hint' | 'auto_add';
export type OrderStatus = 'measure' | 'quoted' | 'agreed' | 'production' | 'ready' | 'installed' | 'closed' | 'cancelled';

export type Tokens = {
  access_token: string; refresh_token: string; expires_in: number; company_id: string | null;
  companies: { id: string; name: string; role: Role }[]; needs_onboarding: boolean; is_new?: boolean;
};
export type CodeSent = { phone: string; expires_in: number; resend_in: number; length: number; attempts: number };
export type Me = { id: string; phone: string; name: string | null; company_id: string | null; companies: Tokens['companies'] };

// ---------- изделие (PRD, раздел 6) ----------
export type CellType = 'fixed' | 'sash' | 'door_sash' | 'panel';
export type Opening = 'turn' | 'tilt_turn' | 'tilt' | 'sliding';
export type Hinge = 'left' | 'right' | 'top' | 'bottom';
export type Fill = { kind: 'glass'; glass: string } | { kind: 'panel'; item?: string };
export type Cell = {
  type: CellType; open?: Opening; hinge?: Hinge; handle?: boolean; mosquito?: boolean;
  fill?: Fill; options?: Record<string, string>; note?: string;
};
export type Part = { size: number | 'eq'; cell?: Cell; node?: Node };
export type Node = { cell?: Cell; split?: 'v' | 'h' | 'shtulp' | 'none'; parts?: Part[] };
export type Setup = {
  system?: string; color_out?: string; color_in?: string; glass?: string; fittings?: string; options?: Record<string, string>;
};
export type Extras = {
  sill?: { depth_cm: number } | false; drip?: boolean; slopes?: boolean; dismantle?: false | 'wood' | 'pvc' | 'metal' | 'alu';
  outside?: boolean; install?: boolean; floor?: number;
};
export type Doc = {
  id?: string; room?: string; qty?: number; kind: 'window' | 'balcony_block' | 'door' | 'sliding' | 'assembly';
  opening?: { width?: number | number[]; height?: number | number[]; floor_offset?: number; floor?: number; wall?: string;
    quarter_mm?: number; slope_depth_mm?: number; nearby?: string[] };
  setup?: Setup; frame: { w: number; h: number; shape?: string; root: Node }; extras?: Extras;
  accepted_warnings?: { rule: string; path?: string; by?: string; at?: string }[]; template?: string;
};
export type Command = { cmd: string; [k: string]: unknown };

// ---------- проверки, геометрия, расчёт ----------
export type Violation = {
  code: string; severity: Severity; title: string; msg?: string; path?: string; fix?: string;
  accepted: boolean; accepted_by?: string; accepted_by_name?: string; accepted_at?: string;
};
export type CellGeo = {
  path: string; type: CellType; axis: [number, number, number, number]; light: [number, number];
  glass: [number, number] | null; glass_spec: string | null; glass_thickness_mm: number | null;
  sash?: [number, number]; ffb?: number; ffh?: number; weight_kg?: number;
  fittings?: { code: string; name: string; qty: number; cams: number }[];
};
export type Geometry = { w: number; h: number; cells: CellGeo[]; mullions: { path: string; orient: 'v' | 'h'; at: number; length: number }[] };
export type BomLine = {
  kind: string; name: string; qty: number; unit: string; code?: string; article?: string; item_id?: string; path?: string;
  pieces?: number[]; unit_price?: number; price_unit?: string; cost?: number; price_status?: 'price' | 'demo' | 'estimate' | 'none'; note?: string;
};
export type Price = {
  currency: 'UZS'; qty: number; area_m2: number; total: number; per_m2: number; demo: boolean; complete: boolean; missing: string[];
  total_usd?: number; materials?: number; works?: number; cost?: number; markup_kind?: string; markup_value?: number; discount_pct?: number;
};
export type Validation = { violations: Violation[]; can_quote: boolean; price_group: string; setup: Setup; geometry: Geometry | null };
export type Calc = Validation & { bom?: BomLine[]; price?: Price };

// ---------- заказы ----------
export type OrderRow = {
  id: string; status: OrderStatus; address: string | null; floor: number | null; updated_at: string; created_at: string;
  client_name: string | null; client_phone: string | null; client_telegram: string | null;
  positions: number; units: number; total: number; area_m2: number | null; missing_price_positions: number; blocked_positions: number;
  demo: boolean; extras_total: number | null; quote_version: number | null; quote_sent_at: string | null;
  accepted_at: string | null; accepted_kit: string | null; accepted_total: number | null; kit_name: string | null;
};
export type Counts = Partial<Record<OrderStatus | 'all', number>>;
export type PositionOut = {
  id: string; rev: number; sort: number; deleted: boolean; doc: Doc; room: string | null; qty: number; size: string; label: string;
  total: number | null; per_m2: number | null; area_m2: number | null; demo: boolean; complete: boolean; can_quote: boolean;
  violations: Violation[]; warns: number; updated_at: string; updated_by: { id: string; name: string } | null;
};
export type Extra = { id: string; name: string; unit: string; qty: number; price_sum: number; total: number };
export type QuoteBrief = {
  version: number; token: string; url: string; sent_at: string; demo: boolean; lang: 'ru' | 'uz'; revoked: boolean;
  accepted_at: string | null; accepted_variant: number | null; accepted_kit: string | null; accepted_total: number | null;
  variants: { kit: string; total: number }[];
};
export type OrderFull = {
  order: OrderRow; client: { id: string; name: string | null; phone: string | null; telegram: string | null; lang: string } | null;
  positions: PositionOut[]; extras: Extra[]; quotes: QuoteBrief[];
  total: number; extras_total: number; area_m2: number; per_m2: number | null; units: number; can_quote: boolean;
  blocked_positions: string[]; demo: boolean; total_without_blocked: number; total_is_from: boolean; discount_pct: number;
  kit_name: string | null; quote_outdated: boolean; total_usd?: number; usd_rate?: number;
  cost?: number; margin?: number; margin_pct?: number | null; markup_kind?: string; markup_value?: number;
};
export type Conflict = { conflict: true; server: { doc: Doc; rev: number; deleted: boolean; updated_at: string; updated_by: { id: string; name: string } | null }; client: Doc };
export type SyncResult = { orders: { id: string; status: 'ok' }[]; positions: { position_id: string; status: 'ok' | 'conflict' | 'error'; rev?: number; server?: Conflict['server']; error?: string }[] };

// ---------- справочники ----------
export type Template = { id: string; name: string; kind: Doc['kind']; default_w: number; default_h: number; category: string; ready: boolean; fixed_parts: { path: string; size: number }[] };
export type Measure = { ok: boolean; frame_w?: number; frame_h?: number; opening_w?: number; opening_h?: number; gap_mm?: number;
  issues: { code: string; severity: Severity | 'warn'; msg: string; fix?: string; field?: string }[] };
export type Kit = { name: string; setup: Setup };
export type Variant = { kit: string; setup: Setup; total: number; area_m2: number; per_m2: number | null; demo: boolean; can_quote: boolean; current: boolean };
