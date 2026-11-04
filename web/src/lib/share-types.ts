/**
 * Данные ссылки клиента: GET /api/share/{token} → SharePayload.
 *
 * Контракт для бэкенда (группа API `share`, PRD §18). Правила (NFR-10):
 * - в ответе только поля выбранного вида сметы (см. ClientEstimate);
 * - никогда нет поставщика, артикулов поставщика, процента наценки,
 *   себестоимости и комиссии;
 * - суммы — целые сумы (UZS), размеры — мм.
 */
import type { ViewerModel } from '@mebel/viewer';

export type Lang = 'ru' | 'uz';

/** Текст на двух языках: рус и узбекский (латиница). */
export interface LocalizedText {
  ru: string;
  uz: string;
}

/** Целые сумы. */
export type Sum = number;

/** Сумма «от–до». После замера (exact = true) from === to. */
export interface SumRange {
  from: Sum;
  to: Sum;
}

/** Группа подробной сметы: «Листы», «Кромка», «Распил и кромкование», «Фурнитура»… */
export interface EstimateGroup {
  /** Название группы по-русски — как отдаёт ядро. */
  name: string;
  from: Sum;
  to: Sum;
}

/** Позиция «под запрос»: цены нет, показывается с пометкой. */
export interface EstimateRequest {
  name: string;
  /** Пометка для клиента, сейчас всегда «уточняется». */
  note: string;
}

export type EstimateView = 'total' | 'short' | 'detailed';

/**
 * Смета для клиента — РОВНО форма из ядра:
 * core/src/mebel_core/estimate.py → client_view(); примеры —
 * schemas/samples/<name>.estimate.json.
 *
 * - total:    { view, exact, total }
 * - short:    { view, exact, total, materials, work }
 * - detailed: { view, exact, total, materials, work, groups, requests }
 */
export interface ClientEstimate {
  view: EstimateView;
  /** true — после замера, суммы точные; false — диапазоны «от–до». */
  exact: boolean;
  total: SumRange;
  /** «Материалы» (short, detailed). */
  materials?: SumRange;
  /** «Работа мастера» (short, detailed). */
  work?: SumRange;
  /** Позиции по группам (detailed). */
  groups?: EstimateGroup[];
  /** Позиции «под запрос» (detailed). */
  requests?: EstimateRequest[];
  /** До замера: что в цене — оценка (главное первым); после замера — пусто. */
  uncertainty?: EstimateUncertainty[];
  /** Готовая строка: «оценка: размеры, фасады»; после замера — "". */
  uncertainty_text?: string;
  /** То же по-узбекски: «taxminiy: o‘lchamlar, fasadlar». */
  uncertainty_text_uz?: string;
}

/** Категория-оценка до замера. Диапазон — ожидаемая цена ± 3–8 %. */
export interface EstimateUncertainty {
  category: 'sizes' | 'body' | 'fronts' | 'hardware' | 'services';
  name: string;
  name_uz: string;
  /** «размеры по фото, уточнятся на замере», «цена по аналогу», «цена уточняется». */
  reason: string;
  reason_uz: string;
}

export interface ShareMaster {
  name: string;
  workshop?: string;
  /** E.164: "+998901234567". */
  phone: string;
  /** Имя пользователя Telegram без @ (необязательно). */
  telegram?: string;
  /** Город цеха — подпись под названием в шапке (необязательно). */
  city?: string;
  /** Логотип цеха (тариф Pro). Без него — круг с инициалами. */
  logoUrl?: string;
}

export interface ShareProject {
  title: LocalizedText;
  /** Габарит, мм: [ширина, высота, глубина]. */
  sizeMm: [number, number, number];
  /** Версия модели, по которой построены 3D и смета. */
  modelVersion: string;
}

export interface ShareGlb {
  /** URL GLB «закрыто» (метры, реальный масштаб). Должен быть публичным для Scene Viewer. */
  closed: string;
  /** URL GLB «открыто» (все двери и ящики открыты). */
  open: string;
  /** Необязательно: готовые USDZ для iOS. Если нет — model-viewer соберёт USDZ сам. */
  closedUsdz?: string;
  openUsdz?: string;
}

export interface SharePayload {
  version: 1;
  token: string;
  /** Язык по умолчанию — язык мастера при создании ссылки. */
  lang: Lang;
  /** Когда истекает (ISO 8601) или null. Просроченная ссылка → HTTP 410. */
  expiresAt: string | null;
  /** Клиент уже нажал «Согласен» — дата (ISO 8601) или null. */
  agreedAt: string | null;
  project: ShareProject;
  master: ShareMaster;
  /** Viewer model формата "1" (core/src/mebel_core/viewer.py). */
  model: ViewerModel;
  glb: ShareGlb;
  /** Смета в виде, выбранном мастером; null — мастер решил не показывать цену. */
  estimate: ClientEstimate | null;
  /** Дата снимка цены (ISO 8601). Если цена изменилась после отправки, клиент видит старую с датой. */
  priceDate: string | null;
}

/** Ошибка API ссылки. */
export interface ShareError {
  /** revoked — мастер отозвал ссылку или удалил аккаунт. */
  error: 'not_found' | 'expired' | 'revoked';
  /** Необязательно (410): контакты мастера для экрана «ссылка недоступна» — error.details.master. */
  master?: ShareMaster;
}

export type ShareEvent = 'opened' | 'ar_started' | 'ar_failed' | 'agreed';

/** POST /api/share/{token}/events */
export interface ShareEventBody {
  event: ShareEvent;
  /** ISO 8601, время на устройстве клиента. */
  at: string;
  meta?: Record<string, string | number | boolean>;
}

/** POST /api/share/{token}/agree → 200 */
export interface AgreeResponse {
  agreedAt: string;
}
