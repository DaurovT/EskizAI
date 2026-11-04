/** Точка входа API в приложении: мок или FastAPI по EXPO_PUBLIC_MOCK / EXPO_PUBLIC_API_URL. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { API_URL, MOCK } from '../config';
import { downloadToCache, writeCacheFile } from './download';
import { Http, type TokenStore } from './http';
import { createHttpApi } from './httpApi';
import { createMockApi } from './mock/mockApi';
import { withOfflineCache, type OfflineApi } from './offline';
import { netState } from '../state/net';

const TOKENS_KEY = 'mebel.tokens';

export const tokenStore: TokenStore = {
  async get() {
    try {
      const raw = await SecureStore.getItemAsync(TOKENS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  async set(t) {
    try {
      if (t) await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(t));
      else await SecureStore.deleteItemAsync(TOKENS_KEY);
    } catch {
      /* web / нет хранилища */
    }
  },
};

let unauthorizedHandler: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: (() => void) | null) => { unauthorizedHandler = fn; };
let maintenanceHandler: ((details: unknown) => void) | null = null;
export const setMaintenanceHandler = (fn: ((details: unknown) => void) | null) => { maintenanceHandler = fn; };

const http = new Http({
  baseUrl: API_URL, tokens: tokenStore, onUnauthorized: () => unauthorizedHandler?.(),
  onMaintenance: (e) => maintenanceHandler?.(e.details),
});

const base = MOCK ? createMockApi({ writeFile: (name, content) => writeCacheFile(name, content) }) : createHttpApi(http, downloadToCache);

export const api: OfflineApi = withOfflineCache(base, AsyncStorage, {
  onServedFromCache: () => netState.markCache(true),
  onOnline: () => netState.markCache(false),
});
