/**
 * Push по заказу, пока приложение открыто: экраны заказов (список, карточка, переписка, рекламации) подписываются
 * и тихо перезагружаются. Открытая переписка заказа гасит баннер push о новом сообщении в ней (services/push.ts).
 */
import { useEffect, useRef } from 'react';

type Listener = (orderId: string, kind: string | null) => void;
const listeners = new Set<Listener>();
let activeChat: string | null = null;

export const orderEvents = {
  emit(orderId: string, kind: string | null = null) { for (const l of [...listeners]) l(orderId, kind); },
  subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; },
  /** Какая переписка сейчас на экране (null — никакая). */
  setActiveChat(orderId: string | null) { activeChat = orderId; },
  activeChat: () => activeChat,
};

/** Перезагрузить экран при push по этому заказу (orderId = null — по любому заказу). */
export function useOrderPush(orderId: string | null, onPush: (kind: string | null) => void) {
  const fn = useRef(onPush);
  fn.current = onPush;
  useEffect(() => orderEvents.subscribe((id, kind) => { if (orderId == null || id === orderId) fn.current(kind); }), [orderId]);
}
