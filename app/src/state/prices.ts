/** Итог для клиента в списке: основной источник — `price` из GET /projects; это запасной вариант из последней карточки. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PriceRange, ProjectCardOut } from '../api/types';
import { createStore } from './store';

const KEY = 'mebel.prices';
export const priceStore = createStore<Record<string, PriceRange>>({});
AsyncStorage.getItem(KEY).then((v) => { if (v) priceStore.set(JSON.parse(v)); }).catch(() => undefined);

export function rememberPrice(card: ProjectCardOut) {
  const total = card.estimate?.total ?? null;
  if (!total) return;
  priceStore.set((s) => {
    const next = { ...s, [card.id]: total };
    AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => undefined);
    return next;
  });
}
