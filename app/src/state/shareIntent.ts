import { createStore } from './store';

/** Что пришло через «Поделиться» (Telegram и др.): файлы-картинки и/или текст. */
export interface SharedPayload { images: { uri: string; mimeType: string; name: string; width?: number | null; height?: number | null; size?: number | null }[]; text: string | null }
export const shareStore = createStore<{ pending: SharedPayload | null }>({ pending: null });
export const takeShared = () => {
  const p = shareStore.get().pending;
  shareStore.set({ pending: null });
  return p;
};
