/**
 * Локальные данные проекта, которых пока нет в API:
 * - estimated: JSON Pointer значений «оценка» из последнего DesignOut (до подтверждения мастером);
 * - design: последний DesignOut — для экранов разбора и уточнений.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DesignOut } from '../api/types';
import { createStore } from './store';

interface Meta {
  estimated: string[];
  design: DesignOut | null;
  /** Локальные uri загруженных фото — в том же порядке, что photo_ids (для рамок objects). */
  photos: string[];
  /** Ответы на вопросы до отправки (например, тап по рамке на SCR-05 отвечает на `object`). */
  answers: Record<string, string>;
  /** Отправленные ответы прошлых раундов (текст вопроса → ответ) — показать свернуто, не спрашивать снова. */
  answered?: { id: string; text: string; value: string }[];
  /** Замечания мастера к строкам «Что я нашёл» до отправки (ключ строки → что не так). */
  notes?: Record<string, { title: string; text: string }>;
}
export const metaStore = createStore<Record<string, Meta>>({});

const KEY = (id: string) => `meta:${id}`;
const empty: Meta = { estimated: [], design: null, photos: [], answers: {} };

export async function loadMeta(id: string): Promise<Meta> {
  if (metaStore.get()[id]) return metaStore.get()[id];
  let m = empty;
  try {
    const raw = await AsyncStorage.getItem(KEY(id));
    if (raw) m = { ...empty, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  metaStore.set((s) => ({ ...s, [id]: m }));
  return m;
}

export function updateMeta(id: string, patch: Partial<Meta> | ((m: Meta) => Partial<Meta>)) {
  metaStore.set((s) => {
    const cur = s[id] ?? empty;
    const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
    AsyncStorage.setItem(KEY(id), JSON.stringify(next)).catch(() => undefined);
    return { ...s, [id]: next };
  });
}

export const useMeta = (id: string) => metaStore.use((s) => s[id] ?? empty);

/** Мастер подтвердил значение — снять «оценку». */
export const confirmPointer = (id: string, pointer: string) =>
  updateMeta(id, (m) => ({ estimated: m.estimated.filter((p) => p !== pointer && !pointer.startsWith(`${p}/`)) }));
