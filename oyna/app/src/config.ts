/**
 * Настройки сборки (Expo подставляет EXPO_PUBLIC_* при сборке — только прямой записью process.env.X).
 * EXPO_PUBLIC_API_URL — адрес API Eskiz Oyna; локально: http://<Mac>.local:8030
 */
const clean = (v: string | undefined) => (v && v.trim() ? v.trim().replace(/\/$/, '') : undefined);

export const API_URL = clean(process.env.EXPO_PUBLIC_API_URL) ?? 'https://api.oyna.eskizai.uz';
export const APP_NAME = 'Eskiz Oyna';
/** Код из SMS: длина и попытки приходят с сервера (/auth/request-code), здесь — значения до ответа */
export const CODE_LENGTH = 5;
