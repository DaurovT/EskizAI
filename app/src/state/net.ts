import { createStore } from './store';

/** Состояние сети: NetInfo (online) + «последний ответ был из кэша». */
export const netStore = createStore({ online: true, fromCache: false });

export const netState = {
  markCache(v: boolean) {
    if (netStore.get().fromCache !== v) netStore.set({ fromCache: v });
  },
  setOnline(v: boolean) {
    if (netStore.get().online !== v) netStore.set({ online: v, fromCache: !v });
  },
};

export const useOffline = () => netStore.use((s) => !s.online || s.fromCache);
