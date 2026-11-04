/** Экран обновления / техработ (SCR-45): проверка при запуске и при возврате в приложение. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { api, setMaintenanceHandler } from '../api';
import { decideScreen, type SystemScreen } from '../lib/appStatus';
import { createStore } from './store';

const DISMISSED = 'mebel.update.dismissed';

export const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';

export const systemStore = createStore<{ screen: SystemScreen | null; checking: boolean }>({ screen: null, checking: false });

export const useSystemScreen = () => systemStore.use((s) => s.screen);
export const useSystemChecking = () => systemStore.use((s) => s.checking);

/** Спросить сервер. Нет сети или старый сервер без /app/status — ничего не показываем (кроме уже открытого блока). */
export async function checkAppStatus(): Promise<void> {
  systemStore.set({ checking: true });
  try {
    const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
    const s = await api.appStatus(platform, APP_VERSION);
    let dismissed: string | null = null;
    try { dismissed = await AsyncStorage.getItem(DISMISSED); } catch { /* нет хранилища */ }
    systemStore.set({ screen: decideScreen(s, APP_VERSION, dismissed) });
  } catch {
    /* офлайн — остаёмся как есть */
  } finally {
    systemStore.set({ checking: false });
  }
}

/** «Позже» на необязательном обновлении — больше не показываем для этой версии. */
export async function dismissOptional(): Promise<void> {
  const s = systemStore.get().screen;
  if (s?.kind === 'optional') {
    try { await AsyncStorage.setItem(DISMISSED, s.version); } catch { /* ignore */ }
  }
  systemStore.set({ screen: null });
}

/** Ответ API 503 `maintenance` — сразу показать экран техработ. */
export function showMaintenance(details: unknown): void {
  const d = (details ?? {}) as { until?: string | null; message?: { ru: string; uz: string } };
  systemStore.set({ screen: { kind: 'maintenance', until: d.until ?? null, message: d.message ?? { ru: '', uz: '' } } });
}

setMaintenanceHandler(showMaintenance);
