/**
 * Куда открыть приложение по тапу на push (PRD §19). Сервер кладёт в data: kind, project_id и, по событию,
 * order_id / screen. Без React — покрыто тестами.
 *
 * Заказы (docs/staff_vendor_contract.md §5.6): новое сообщение поставщика → переписка; решение по рекламации →
 * список рекламаций; решение спора по рекламации → рекламации, по отклонению — карточка; принят / вернули /
 * отклонён / исправление ждёт подтверждения → карточка заказа. `screen` от сервера важнее `kind`.
 */
export interface PushData {
  kind?: string; project_id?: string; order_id?: string; screen?: string; return_id?: string; dispute_id?: string; [k: string]: unknown;
}

/** Виды push по заказу, которые открывают переписку / рекламации (остальные с order_id — карточку). */
const CHAT_KINDS = new Set(['order_message']);
const RETURN_KINDS = new Set(['order_return', 'return_decided', 'return_opened']);
const DISPUTE_KINDS = new Set(['order_dispute', 'dispute_resolved']);

/**
 * canOrder = false — сотрудник без права заказа: переписка и рекламации ему закрыты (403), push ведёт в карточку заказа.
 */
export function orderRoute(data: PushData, canOrder = true): string | null {
  const o = data.order_id;
  if (!o) return null;
  if (!canOrder) return `/order/${o}`;
  const screen = data.screen;
  if (screen === 'order_chat' || (!screen && CHAT_KINDS.has(data.kind ?? ''))) return `/order/chat/${o}`;
  if (screen === 'order_returns' || (!screen && RETURN_KINDS.has(data.kind ?? ''))) return `/order/returns/${o}`;
  // спор по рекламации — к рекламациям (решение видно у рекламации), по отклонению — в карточку
  if (!screen && DISPUTE_KINDS.has(data.kind ?? '')) return data.return_id ? `/order/returns/${o}` : `/order/${o}`;
  return `/order/${o}`;
}

export function routeForPush(data: PushData | null | undefined, canOrder = true): string | null {
  if (!data) return null;
  if (data.order_id) return orderRoute(data, canOrder);
  const p = data.project_id;
  if (data.screen === 'profile' || data.kind === 'limit_one_left') return '/profile';
  if (!p) return null;
  switch (data.screen) {
    case 'price_requests': return `/project/${p}/price-requests`;
    case 'nonstandard': return `/project/${p}/nonstandard`;
    case 'estimate': return `/project/${p}/estimate`;
    default: return data.kind === 'model_ready' ? `/project/${p}/editor` : `/project/${p}`;
  }
}
