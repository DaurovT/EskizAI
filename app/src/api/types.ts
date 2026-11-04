/**
 * Типы API (зеркало api/src/mebel_api/schemas/*.py и контракта ИИ/файлов).
 * Суммы — целые сумы, размеры — мм. Даты — ISO-строки.
 */
import type { ViewerModel } from '@mebel/viewer';

export type Lang = 'ru' | 'uz';
export type Role = 'owner' | 'employee';
export type Plan = 'free' | 'pack' | 'pro';
export type EstimateView = 'total' | 'short' | 'detailed';
export type ProjectStatus =
  | 'draft' | 'sketch' | 'sent' | 'measured' | 'contract' | 'in_work' | 'delivered' | 'cancelled';

export const STATUS_FLOW: ProjectStatus[] = [
  'draft', 'sketch', 'sent', 'measured', 'contract', 'in_work', 'delivered',
];

export interface Page<T> { items: T[]; total: number; limit: number; offset: number }

// --- auth ---
export interface RequestCodeOut { phone: string; channel: string; expires_in: number; resend_in: number; code_length?: number }
export interface UserOut {
  id: string; phone: string; name: string; role: Role; language: Lang; workshop_id: string;
  /** Должность и права сотрудника (SCR-23); у владельца — всё. */
  title?: string | null; can_see_cost?: boolean; can_order?: boolean;
}
export interface TokensOut {
  access_token: string; refresh_token: string; token_type: string; expires_in: number;
  user: UserOut; is_new_user: boolean;
  /** Приглашение в цех для этого номера (SCR-38a) — показать до онбординга. */
  invite?: InviteOut | null;
}
/** Приглашение сотрудника: 7 дней; expired вычисляет сервер. */
export type InviteStatus = 'pending' | 'expired' | 'accepted' | 'declined' | 'cancelled';
export interface InviteOut {
  id: string; status: InviteStatus; phone: string; name: string; title: string | null;
  can_see_cost: boolean; can_order: boolean; estimate_views: EstimateView[];
  sent_at: string; expires_at: string; created_at: string;
  workshop: { id: string; name: string; city: string };
  owner: { name: string; phone: string | null };
}
export interface InviteIn { phone: string; name?: string; title?: string | null; can_see_cost?: boolean; can_order?: boolean }
export interface EmployeeUpdateIn { name?: string; title?: string | null; can_see_cost?: boolean; can_order?: boolean }
export interface DeleteAccountOut { ok: boolean; scope: 'workshop' | 'user' }
/** GET /app/status (SCR-45): обновление и техработы. */
export interface AppStatusOut {
  platform: string | null; version: string | null;
  min_version: string; latest_version: string;
  update: 'none' | 'optional' | 'required';
  store_url: string; store_urls: { ios: string; android: string };
  release_notes: { ru: string[]; uz: string[] };
  maintenance: { on: boolean; until: string | null; message: { ru: string; uz: string } };
}
export interface VerifyCodeIn {
  phone: string; code: string; device_id?: string | null;
  platform?: 'ios' | 'android' | 'web' | null; push_token?: string | null;
}

// --- workshop ---
export interface PricingOut {
  labor_mode: 'percent' | 'fixed';
  labor_percent: number; labor_fixed: number;
  markup_body: number; markup_fronts: number; markup_hardware: number; markup_services: number;
  default_estimate_view: EstimateView;
  employee_estimate_views: EstimateView[];
}
export interface WorkshopOut {
  id: string; name: string; city: string; logo_url: string | null; phone: string | null; plan: Plan;
  default_estimate_view: EstimateView; employee_estimate_views: EstimateView[]; created_at: string;
  /** Только владельцу. */
  pricing?: PricingOut;
  /** Для КП (печатаются в PDF): срок, условия оплаты, гарантия — до 300 символов. */
  kp_lead?: string | null; kp_payment?: string | null; kp_warranty?: string | null;
}
export interface WorkshopUpdateIn {
  name?: string; city?: string; logo_url?: string | null; phone?: string | null;
  kp_lead?: string | null; kp_payment?: string | null; kp_warranty?: string | null;
}
export interface EmployeeOut {
  id: string; phone: string; name: string; role: Role; is_active: boolean; last_login_at: string | null;
  title?: string | null; can_see_cost?: boolean; can_order?: boolean;
}
export interface LimitsOut {
  plan: Plan; period: string; free_limit: number; free_used: number; free_left: number;
  pack_left: number; unlimited: boolean; can_create_sketch: boolean;
}

// --- clients ---
export interface ClientIn { name: string; phone?: string | null; address?: string | null; notes?: string | null }
export interface ClientOut extends Required<ClientIn> { id: string; created_at: string; updated_at: string }
export interface ClientProjectBrief { id: string; title: string; status: ProjectStatus; status_label: string; created_at: string }
export interface ClientCardOut extends ClientOut { projects: ClientProjectBrief[] }

// --- estimates ---
export interface PriceRange { from: number; to: number }
/** Причина неопределённости цены до замера (крупнейшая — первой). */
export interface EstimateUncertainty { category: 'sizes' | 'body' | 'fronts' | 'hardware' | 'services' | string; name: string; name_uz?: string; reason?: string; reason_uz?: string }
/** Пояснение диапазона на языке мастера. */
export const uncertaintyText = (e: { uncertainty_text?: string | null; uncertainty_text_uz?: string | null } | null | undefined, lang: string): string =>
  (lang === 'uz' ? e?.uncertainty_text_uz || e?.uncertainty_text : e?.uncertainty_text) || '';
export interface ClientEstimateGroup { key?: string; name: string; name_uz?: string; from: number; to: number }
export interface ClientEstimate {
  view: EstimateView; exact: boolean; total: PriceRange;
  /** До замера: чем объясняется диапазон («оценка: размеры, фасады»); после замера — пусто. Поля сервера. */
  uncertainty_text?: string | null;
  uncertainty_text_uz?: string | null;
  uncertainty?: EstimateUncertainty[] | null;
  materials?: PriceRange | null; work?: PriceRange | null;
  groups?: ClientEstimateGroup[] | null;
  requests?: { name: string; note: string }[] | null;
  has_requests?: boolean;
  /** Цены в смете старше 14 дней — пересчитать перед отправкой. */
  has_stale?: boolean;
}
export interface StaffEstimate {
  exact: boolean; total: PriceRange; materials_client: PriceRange; work: PriceRange;
  /** См. ClientEstimate.uncertainty_text. */
  uncertainty_text?: string | null;
  uncertainty_text_uz?: string | null;
  uncertainty?: EstimateUncertainty[] | null;
  /** Ожидаемая цена и ширина диапазона, % (до замера 3–8, после — 0). */
  expected?: number;
  band_percent?: number;
  has_requests: boolean; sheets: Record<string, number>; priced_at: string;
}
export type LineStatus = 'catalog' | 'analog' | 'request' | 'nonstandard';
export interface MasterEstimateLine {
  key: string; category: 'body' | 'fronts' | 'hardware' | 'services'; group: string; name: string;
  unit: string; qty: number; unit_price: number; cost: number; status: LineStatus | string;
  source: string; priced_at: string; stale?: boolean;
}
export interface MasterEstimate extends StaffEstimate {
  cost_materials: PriceRange;
  cost_by_category: Record<string, number>;
  markup_percent: Record<string, number>;
  lines: MasterEstimateLine[];
}
export type ProjectEstimate = MasterEstimate | StaffEstimate;
export const isMasterEstimate = (e: ProjectEstimate | null | undefined): e is MasterEstimate =>
  !!e && 'cost_materials' in e;

// --- projects ---
export interface ClientBrief { id: string; name: string; phone: string | null }
export interface PhotoOut { id: string; kind: 'source' | 'measurement' | 'result'; url: string; content_type: string; size_bytes: number; created_at: string }
export type ActionCode =
  | 'sketch' | 'share' | 'measure' | 'contract' | 'order' | 'deliver' | 'deliver_self_bought' | 'cancel' | 'unarchive';
export interface ActionOut { code: ActionCode | string; label: string; to_status: ProjectStatus | null }
export interface ProjectListItem {
  id: string; title: string; status: ProjectStatus; status_label: string; product_type: string | null;
  is_example: boolean; client: ClientBrief | null; current_version_id: string | null;
  client_agreed_at: string | null; archived_at: string | null; created_at: string; updated_at: string;
  /** Цена клиенту по последней посчитанной смете текущей версии (кэш на сервере); null — ещё не считали. */
  price?: PriceRange | null;
  /** Подсказка в списке (Projects.dc.html): «открыл 2 раза», «не открыла 3 дня», «готов — забрать в EMAN». Текст — с сервера. */
  activity?: { text: string; tone: 'green' | 'amber' | 'gray' } | null;
}
export interface ModelSummary {
  product_type?: string; size_mm?: [number, number, number]; sections?: number; parts_count?: number;
  materials?: { id: string; name: string; parts: number }[];
  hardware?: { kind: string; name: string; qty: number }[];
  moving_nodes?: number; errors?: number; warnings?: number;
}
export interface ProjectCardOut extends ProjectListItem {
  source_text: string | null; frozen_version_id: string | null; charged: boolean; charge_period: string | null;
  returned_to_limit: boolean; contract_at: string | null; delivered_at: string | null;
  materials_self_bought: boolean; cancelled_at: string | null; cancel_reason: string | null;
  has_order: boolean; photos: PhotoOut[]; model_summary: ModelSummary | null;
  estimate: ProjectEstimate | null; next_step: string; actions: ActionOut[];
}
export interface ProjectIn { title: string; client_id?: string | null; source_text?: string | null; is_example?: boolean }
/** Замер кухни (SCR-13b): расстояния — мм от угла вдоль стены (у прямой кухни — от левого края стены A). */
export type KitchenWall = 'a' | 'b';
export type UtilityKind = 'water' | 'sewer' | 'gas' | 'socket' | 'vent';
export interface KitchenWindow { wall: KitchenWall; from_corner: number; width: number; sill: number }
export interface KitchenUtility { kind: UtilityKind; wall: KitchenWall; from_corner: number; height?: number | null; size?: string | null }
export interface KitchenSite {
  wall_a: number; wall_b?: number | null; ceiling?: number | null;
  window?: KitchenWindow | null; utilities: KitchenUtility[];
}
export interface MeasurementIn {
  width?: number | null; height?: number | null; depth?: number | null; data?: Record<string, unknown>; notes?: string | null;
  /** Применить размеры к модели новой версией (по умолчанию да). */
  apply_to_model?: boolean;
  /** Замер кухни: стены, окно, коммуникации (сервер хранит в data.kitchen). */
  kitchen?: KitchenSite | null;
  /** Замер ниши в 3 точках (встроенный шкаф; сервер хранит в data.niche). */
  niche?: NicheMeasure | null;
}
export interface MeasurementOut extends MeasurementIn {
  id: string; version_id: string | null; created_at: string;
  /** Размеры замера применены к модели новой версией (шкаф). */
  applied_version_id?: string | null;
  /** Почему размеры не применены (модель с ними не собирается, кухня). */
  apply_error?: string | null;
  /** Что сделано при применении замера кухни: мойка к воде, варка к газу, проём над окном… */
  apply_notes?: string[];
}

// --- models ---
export interface FixOut { description: string; patch: Record<string, unknown>[] }
export interface IssueOut { level: 'error' | 'warning' | string; code: string; message: string; path: string; fixes: FixOut[] }
/** Дерево модулей (schemas/product.schema.json). Типизируем то, что правит приложение. */
export interface ProductTree {
  schema_version?: string;
  type?: 'wardrobe' | 'kitchen' | string;
  width?: number; height?: number; depth?: number;
  installation?: 'freestanding' | 'niche';
  body?: { material?: string; top?: 'between' | 'over'; plinth?: unknown; back?: unknown };
  fronts?: { material?: string | null; handles?: { kind?: HandleKind; spacing?: number; finish?: MetalFinish }; style?: FrontsStyle };
  mezzanine?: { height?: number; [k: string]: unknown } | null;
  sliding_doors?: { count?: number; fills?: string[]; [k: string]: unknown } | null;
  sections?: TreeSection[];
  [k: string]: unknown;
}
export interface TreeSection {
  width?: number | null;
  fill?: ({ kind: 'shelves'; count?: number } | { kind: 'rod' } | { kind: 'drawers'; count?: number; height?: number; external?: boolean } | { kind: 'empty' } | { kind: string; [k: string]: unknown })[];
  doors?: { count?: 1 | 2; hinge?: 'left' | 'right' } | null;
}
export interface VersionBrief {
  id: string; number: number; parent_id: string | null; source: 'manual' | 'ai' | 'restore' | 'fix' | string;
  label: string | null; ok: boolean; frozen: boolean; is_current: boolean; rules_version: string;
  summary: ModelSummary; build_ms: number; created_at: string;
  /** JSON Pointer'ы значений «оценка» — хранятся на сервере, общие для всех устройств. */
  estimated?: string[];
  /** Цена клиенту по этой версии (сравнение версий); null — модель с ошибками. */
  price?: (PriceRange & { exact?: boolean }) | null;
}
export interface VersionOut extends VersionBrief {
  tree: ProductTree; schema_version: string; module_versions: Record<string, string>;
  issues: IssueOut[]; viewer: ViewerModel;
}
export interface ModelStateOut { version: VersionOut; can_undo: boolean; can_redo: boolean; frozen_version_id: string | null }
export interface ModelIn { tree: ProductTree; label?: string | null; source?: 'manual' | 'ai'; reject_on_errors?: boolean }

// --- share ---
export interface ShareLinkIn { language: Lang; estimate_view?: EstimateView | null; show_price: boolean; expires_in_days?: number | null }
export interface ShareLinkOut {
  id: string; token: string; url: string; version_id: string; language: Lang; estimate_view: EstimateView;
  show_price: boolean; expires_at: string; revoked_at: string | null; views: number; ar_starts: number;
  ar_failures: number; first_opened_at: string | null; agreed_at: string | null; created_at: string;
}

// --- tasks (GET /tasks/{id}) ---
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed';
export interface TaskOut<R = unknown> {
  id?: string;
  status: TaskStatus;
  result: R | null; error: string | null;
}
export interface TaskAccepted { task_id: string }

// --- AI (контракт параллельного агента) ---
export interface DesignElement { name: string; kind: string; count: number; sure: boolean; note?: string | null }
export interface DesignQuestion { id: string; text: string; options: string[]; default?: string | null; affects?: string[] | string | null }
/** Предмет на фото, когда их несколько: рамка в долях ширины/высоты (0–1). */
export interface DesignObject {
  label: string; photo: number; box: [number, number, number, number]; chosen: boolean;
  /** Примерные габариты [ширина, глубина, высота], мм; пусто — ИИ не оценил. */
  size?: number[]; summary?: string;
}
/** Несколько предметов → несколько проектов: текущий первым, затем новые; у каждого своя задача (DesignOut). */
export interface ObjectProjectOut { project_id: string; task_id: string; object_index: number; label: string; title: string; created: boolean }
export interface ChooseObjectsOut { projects: ObjectProjectOut[]; charged: number }
export interface DesignOut {
  status: 'ready' | 'questions' | 'choose_type' | 'failed';
  product_kind: string | null; confidence: number;
  alternatives: { product_kind: string; confidence?: number; label?: string }[] | string[];
  elements: DesignElement[]; understood: string[]; unclear: string[];
  /** JSON Pointer в дереве — эти значения показываем с пометкой «оценка». */
  estimated: string[];
  questions: DesignQuestion[]; differences: string[]; message: string | null;
  version_id: string | null; issues: IssueOut[]; error: string | null;
  /** Несколько предметов на фото → вопрос с id `object` (варианты = label). Нет поля — считаем []. */
  objects?: DesignObject[];
  /** Все ответы мастера в сессии (id вопроса → ответ): эти вопросы больше не задаются. */
  answers?: Record<string, string>;
}
export interface EditOut {
  ok: boolean; summary: string | null; question: string | null; version_id: string | null;
  price_delta: PriceRange | null; issues: IssueOut[]; error: string | null;
}
export interface DesignIn { text?: string | null; photo_ids?: string[]; language?: Lang; confirm_extra_project?: boolean }
export interface ChatMessage {
  id: string; author: 'master' | 'ai'; kind?: string; text: string; options?: string[] | null; version_id?: string | null;
  price_delta?: PriceRange | null; undone: boolean; created_at: string;
  /** Разница цены для клиента по каждому варианту `options` (сум; null — не считали). */
  option_deltas?: (number | null)[] | null;
}
/** GET /projects/{id}/chat: история + вопросы распознавания без ответа (ответить разом — aiAnswer). */
export interface ChatOut { messages: ChatMessage[]; questions?: DesignQuestion[]; answers?: Record<string, string> }
/** GET /projects/{id}/parts/{number} — деталь (SCR-25): чистовой размер, распил, кромка по сторонам, присадка. */
export interface PartOut {
  number: number; key: string; name: string; role: string; module: string; material_id: string; material: string;
  length_mm: number; width_mm: number; thickness_mm: number; cut_length_mm: number; cut_width_mm: number; grain: string;
  /** y0/y1 — длинные стороны, x0/x1 — короткие; thickness_mm 0 — без кромки. */
  edges: { side: string; edge_id?: string | null; name?: string | null; thickness_mm: number }[];
  holes: { purpose: string; diameter_mm: number; count: number }[];
  grooves: number; cutouts: number;
  hardware: { kind: string; name: string; qty: number }[];
  /** Габарит изделия: ширина, высота, глубина, мм. */
  product_size_mm: number[];
}
/** GET /projects/{id}/ai/budget — бюджет ИИ-правок проекта. */
export interface AiBudgetOut {
  spent_usd: number; limit_usd: number; percent: number; extra_projects: number; warning: boolean; exceeded: boolean; message?: string | null;
}

// --- files ---
export type FileKind = string; // offer_pdf | spec_pdf | cut_pdf | parts_csv | dxf | hardware_xlsx | estimate_xlsx | glb …
export interface FileItem {
  kind: FileKind; name?: string; title?: string; format?: string; size_bytes?: number | null;
  available: boolean; reason?: string | null; free?: boolean;
  /** Имя файла для «Поделиться»: «Шкаф_Азиза_спецификация_v3.pdf». */
  file_name?: string | null; content_type?: string;
}
/** «Скачать без заказа ≈ 45 000 сум»: цена файлов проекта (Pro — со скидкой). */
export interface FilesPurchase { price: number; full_price: number; discount_pct: number; pro_discount_pct: number; currency: string }
/** GET /projects/{id}/files целиком. */
export interface FilesOut {
  version_id: string | null; version_number: number | null; frozen: boolean;
  access: { production: boolean; basis: string | null; pro_discount: boolean };
  /** null — файлы уже открыты. */
  purchase?: FilesPurchase | null;
  files: FileItem[];
}

// --- orders (SCR-14/15/16/31) ---
export type OrderStatus = 'created' | 'paid' | 'accepted' | 'cutting' | 'ready' | 'issued' | 'cancelled';
export const ORDER_FLOW: OrderStatus[] = ['created', 'paid', 'accepted', 'cutting', 'ready', 'issued'];
export type PaymentMethod = 'click' | 'payme' | 'invoice';
export interface OrderPayment {
  status: 'waiting' | 'failed' | 'paid'; method?: PaymentMethod | null; url?: string | null;
  paid_at?: string | null; reference?: string | null;
}
export interface OrderLine { key: string; name: string; unit: string; qty: number; price: number; total: number }
export interface Delivery { weight_kg: number; distance_km: number; cost: number; breakdown: Record<string, number> }
/** mebel_core.supplier_order(): состав заказа поставщику по себестоимости. */
export interface OrderPreview {
  lines: OrderLine[]; excluded: string[]; goods_total: number; delivery: Delivery | null; total: number; weight_kg: number;
}
export interface OrderStep { status: OrderStatus; label: string; done: boolean; current: boolean; at: string | null }
export interface OrderItem { key?: string | null; name: string; qty: number | null; unit: string | null; price?: number | null; amount?: number | null; excluded?: boolean }
export interface OrderOut {
  id: string; number: string; project_id: string; project_title: string | null; status: OrderStatus; status_label?: string;
  /** Нет у сотрудника. */
  total?: number | null; goods_total?: number | null; delivery?: Delivery | null;
  pickup?: boolean; distance_km?: number | null; weight_kg?: number | null;
  ready_date: string | null; created_at: string; paid_at?: string | null; payment: OrderPayment | null;
  steps?: OrderStep[]; items: OrderItem[]; excluded?: string[]; cancellable?: boolean;
  /** invoice — «Счёт EMAN · PDF» (GET /orders/{id}/invoice); у сотрудника без цен — пусто. */
  documents: { kind: string; title: string; format?: string; url?: string }[];
}

// --- нестандарт (SCR-19, SCR-34) ---
export type NonstandardStatus = 'sent' | 'estimated' | 'in_work' | 'done' | 'cancelled';
export interface NonstandardIn { description: string; photo_ids?: string[]; differences?: string[] | null; path?: 'eman' | 'self' }
export interface NonstandardFile { id: string; name: string; content_type: string; size: number; uploaded_at: string; url: string }
export interface NonstandardOut {
  id: string; number: number | null; project_id: string; description: string; photo_ids: string[]; differences: string[];
  path: 'eman' | 'self'; status: NonstandardStatus; status_label: string; status_label_uz?: string;
  steps: { status: NonstandardStatus; label: string; done: boolean }[];
  price: number | null; lead_days: number | null; assignee: string | null; files: NonstandardFile[];
  can_accept: boolean; can_cancel: boolean; created_at: string;
  /** Комментарий конструктора к оценке: «Нишу сделаем из гнутого МДФ R250…». */
  designer_comment?: string | null;
}

// --- цена «под запрос» (SCR-30) ---
export interface PriceRequestOut {
  id: string; project_id: string; line_key: string; name: string; unit: string; qty: number;
  status: 'pending' | 'priced' | 'accepted' | 'declined';
  price: number | null; total: number | null; estimate_price: number; delta: number | null; lead_days: number | null;
  supplier_name: string | null; note: string | null; priced_at: string | null;
  /** Цена действует до (по умолчанию +7 дней от оценки); expired — срок прошёл, принять нельзя. */
  valid_until?: string | null; expired?: boolean;
}

// --- каталог декоров (SCR-09) ---
export interface DecorOut {
  id: string; name: string; name_uz: string; kind: string; decor: string | null; color: string; has_grain: boolean;
  thickness: number; texture: string | null; available: boolean; brand: string; sku: string | null;
  source: 'catalog' | 'core' | 'eman';
  /** Только у декоров EMAN (GET /catalog/decors): вид у EMAN, семейство цвета, лист, цена листа (владельцу). */
  eman_kind?: string; family?: ColorFamily | null; finish?: string; texture_size_mm?: [number, number] | null;
  sheet_mm?: [number, number] | null; price?: number | null; price_per_m2?: number | null; source_url?: string | null;
}
export type ColorFamily = 'white' | 'grey' | 'beige' | 'wood-light' | 'wood-dark' | 'black' | 'colour';
export interface DecorQuery {
  /** Через запятую: ldsp,mdf. */ kind?: string; brand?: string; family?: ColorFamily; q?: string; thickness?: number;
  min_thickness?: number; available?: boolean; limit?: number; offset?: number;
}
export interface DecorList { items: DecorOut[]; total: number; brands: string[]; families: ColorFamily[] }

// --- краска для МДФ-фасадов (docs/decor_contract.md) ---
export type PaintGlossId = 'matte' | 'satin' | 'gloss';
export interface PaintColor { code: string; system: 'RAL' | 'NCS'; name_ru: string; name_uz: string; hex: string }
export interface PaintGloss { id: PaintGlossId; name_ru: string; name_uz: string; price_m2: number | null }
export interface PaintMaterial { id: string; name: string; thickness: number }
export interface PaintPalette { colors: PaintColor[]; gloss: PaintGloss[]; materials: PaintMaterial[]; back_factor: number }
/** `fronts.style.paint` — что нарисует 3D и посчитает ядро. */
export interface FrontsStyle {
  paint?: { color: string; code: string; system: 'RAL' | 'NCS'; gloss: PaintGlossId } | null;
  milling?: { pattern: string; inset?: number; width?: number; depth?: number; radius?: number; pitch?: number } | null;
  overlay?: { pattern: string; profile?: string; inset?: number } | null;
  inlay?: { kind: string; finish?: MetalFinish; width?: number; inset?: number } | null;
  corners?: { radius: number } | null;
  [k: string]: unknown;
}

// --- декор фасадов, подсветка, встройка (docs/decor_contract.md, GET /catalog/front-styles …) ---
export type HandleKind = 'none' | 'bar' | 'knob' | 'gola';
export type MetalFinish = 'steel' | 'black' | 'chrome' | 'brass' | 'gold';
/** Себестоимость за единицу — только тем, кто видит себестоимость. */
export interface PriceHint { price: number; unit: string; status: string }
export interface StylePattern {
  id: string; name: string; name_uz: string;
  /** `mdf` — только по МДФ под покраску. */
  requires: string[];
  /** SVG-пути на эталонной двери (viewBox 0 0 400 700). */
  preview: string[];
  defaults?: Record<string, number>; profiles?: string[]; finishes?: MetalFinish[];
  /** У вставки — по отделке. */
  price_hint?: PriceHint | Record<string, PriceHint | null> | null;
}
export interface NamedOption { id: string; name: string; name_uz: string; price_hint?: PriceHint | null }
export interface FrontStylesOut {
  preview_viewbox: number[]; paint_material: string;
  milling: StylePattern[]; overlay: StylePattern[]; inlay: StylePattern[];
  paint: { requires: string[]; systems: string[]; gloss: NamedOption[]; back_factor: number };
  finishes: NamedOption[]; handles: NamedOption[];
  corners: { max_radius: number; edge_min_radius: number };
}
export interface LightingItem { zone: string; target?: string; temp?: number; sensor?: string; mount?: 'groove' | 'surface'; power?: number }
export interface LightingZonesOut {
  zones: (NamedOption & { products: string[] })[];
  temps: { value: number; name: string; name_uz: string }[];
  sensors: NamedOption[]; mounts: NamedOption[];
  price_hint: { profile: PriceHint | null; strip: PriceHint | null } | null;
}
export interface NicheMeasure {
  width?: number | null; width_top?: number | null; width_middle?: number | null; width_bottom?: number | null;
  height?: number | null; height_left?: number | null; height_right?: number | null; depth?: number | null;
  /** Какая стена завалена: весь перекос — в добор этой стороны (нет — поровну). */
  lean?: 'left' | 'right' | null;
}
export interface FloorMaterial { id: string; name: string; name_uz: string; color: string; texture: string; seam: string; step_mm: number }
export interface BuiltinOptionsOut {
  fillers: {
    sides: NamedOption[]; positions: NamedOption[]; mounts: NamedOption[]; materials: (Omit<NamedOption, 'id'> & { id: string | null })[];
    defaults: { filler_width: number; top_filler_width: number; allowance_side: number; allowance_top: number; scribe: number; filler_setback: number };
  };
  niche_fields: string[];
  /** «Добор клином» (`builtin.wedge`): кромка к стене по замеру. */
  wedge?: { field: string; name: string; name_uz: string; hint?: string; price_hint?: PriceHint | null };
  niche_lean?: (Omit<NamedOption, 'id'> & { id: 'left' | 'right' | null })[];
  /** Комната только для вида: пресеты пола (`room_colors.floor_material`). */
  room?: { view_only: boolean; walls_visible: boolean; floor_materials: FloorMaterial[] };
  side_panels: { sides: string[]; kitchen_rows: NamedOption[] };
  plinth: { wardrobe: { legs: boolean; floor_allowance: number }; kitchen: { setback: number; floor_allowance: number; sides: string[]; grilles: NamedOption[] } };
  back: NamedOption[];
  kitchen_modules: { kind: string; name: string; name_uz: string; dw?: boolean; defaults?: Record<string, unknown>; widths?: number[] }[];
  limits: { filler_min: number; filler_max: number; plumb_tolerance: number; door_clearance: number; top_panel_max: number };
  price_hint: Record<string, PriceHint | null> | null;
}

// --- раскрой (SCR-11) ---
export interface NestingPart { number: number; name: string; x: number; y: number; length: number; width: number; rotated: boolean }
export interface NestingSheet { index: number; length: number; width: number; usage: number; parts: NestingPart[] }
export interface NestingMaterial {
  material: string; material_name: string; has_grain: boolean; color?: string | null; sheets_count: number;
  waste_percent: number; parts_area_m2: number; sheets: NestingSheet[];
}
export interface NestingOut {
  version_id: string; version_number: number; trim: number; kerf: number; materials: NestingMaterial[];
  sheets_total: number; unplaced: { number: number; name: string }[];
}

// --- фурнитура (SCR-26) ---
export interface HardwareOption { value: string; label: string; current: boolean; delta: number | null; available: boolean; note: string }
export interface HardwareGroup { key: string; title: string; options: HardwareOption[] }
export interface HardwareOut {
  version_id: string; groups: HardwareGroup[]; items: { kind: string; name: string; qty: number }[]; editable: boolean;
}

// --- уведомления мастера (GET /notifications, Notifications.dc.html) ---
export interface NotificationOut {
  id: string; kind: string; title: string; body: string | null; data: Record<string, unknown> | null;
  status: string | null; project_id: string | null; read: boolean; created_at: string;
}
/** GET/PATCH /me/notification-settings (FR-66, Misc.dc.html): типы push и тихие часы (без звука). */
export type NotificationTypeKey =
  | 'client_opened' | 'client_agreed' | 'model_ready' | 'order_status' | 'prices_stale' | 'price_request' | 'nonstandard';
export interface NotificationSettingsOut {
  types: { key: NotificationTypeKey | string; enabled: boolean; title: string; subtitle: string }[];
  quiet: { enabled: boolean; from: string; to: string; timezone: string; silent: boolean };
}
export interface NotificationSettingsIn {
  types?: Partial<Record<NotificationTypeKey, boolean>>;
  quiet?: { enabled?: boolean; from?: string; to?: string };
}

// --- платежи платформе (GET /billing/payments, SCR-42) ---
export interface PaymentOut {
  id: string; kind: 'pack' | 'pro' | 'files' | string; title: string; amount: number | null; currency: string;
  method: string | null; method_label: string | null; status: 'paid' | 'refunded' | string;
  paid_at: string; refunded_at: string | null; receipt_url: string | null;
  project_id: string | null; project_title: string | null;
}
