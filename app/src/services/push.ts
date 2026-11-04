/**
 * Push (PRD §19): Expo push token → POST /devices {push_token, platform, device_id} после входа и при
 * включении уведомлений. Без EAS projectId (Expo Go) токена нет — приложение работает дальше без push.
 * Сервер шлёт уведомления через Expo Push API; в data — project_id (и order_id / screen), по тапу
 * открывается нужный экран (src/lib/pushRoute.ts).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { api } from '../api';
import { orderEvents } from '../state/orderEvents';

const TOKEN = 'mebel.pushToken';
const DEVICE = 'mebel.deviceId';

Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    // новое сообщение в переписке, которая сейчас открыта, — без баннера (экран обновится сам)
    const d = n.request.content.data as { kind?: string; order_id?: string } | undefined;
    const inChat = d?.kind === 'order_message' && !!d.order_id && d.order_id === orderEvents.activeChat();
    return { shouldShowBanner: !inChat, shouldShowList: !inChat, shouldPlaySound: false, shouldSetBadge: false };
  },
});

export async function deviceId(): Promise<string> {
  const saved = await AsyncStorage.getItem(DEVICE).catch(() => null);
  if (saved) return saved;
  let id: string | null = null;
  try {
    id = Platform.OS === 'android' ? Application.getAndroidId() : await Application.getIosIdForVendorAsync();
  } catch {
    /* ignore */
  }
  id = id || `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  AsyncStorage.setItem(DEVICE, id).catch(() => undefined);
  return id;
}

export const savedPushToken = () => AsyncStorage.getItem(TOKEN).catch(() => null);

/** ask=false — не показываем системный запрос, берём токен только если разрешение уже есть. */
export async function registerForPush(ask: boolean): Promise<string | null> {
  if (!Device.isDevice) return null;
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', { name: 'default', importance: Notifications.AndroidImportance.HIGH });
      // тихие часы: сервер шлёт push в канал quiet — без звука и вибрации
      await Notifications.setNotificationChannelAsync('quiet', { name: 'quiet', importance: Notifications.AndroidImportance.DEFAULT, sound: null, enableVibrate: false });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted' && ask) status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return null;
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
    const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
    await AsyncStorage.setItem(TOKEN, token);
    return token;
  } catch {
    // Expo Go без EAS projectId / эмулятор без Google Play — push недоступен, приложение работает дальше
    return null;
  }
}

/** После входа: отдать токен серверу (сеть недоступна — токен остаётся в телефоне, отправим при следующем входе). */
export async function syncPushToken(ask = false): Promise<'api' | 'local' | null> {
  const token = (await registerForPush(ask)) ?? (await savedPushToken());
  if (!token) return null;
  try {
    return (await api.registerPushToken(token, Platform.OS === 'ios' ? 'ios' : 'android', await deviceId())).stored;
  } catch {
    return 'local';
  }
}

/** Выход: сервер больше не шлёт push на этот телефон. */
export async function dropPushToken(): Promise<void> {
  try { await api.unregisterPush(await deviceId()); } catch { /* устройства нет или нет сети */ }
}
