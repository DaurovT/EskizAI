/**
 * Настройки из переменных окружения (Expo подставляет EXPO_PUBLIC_* при сборке).
 *
 * EXPO_PUBLIC_API_URL  — адрес FastAPI, например http://192.168.1.10:8000
 * EXPO_PUBLIC_MOCK     — "1" — работать без сервера на образцах из schemas/samples.
 *                         Если API_URL не задан, мок включается сам.
 * EXPO_PUBLIC_SHARE_URL — база ссылки клиента в моке (по умолчанию http://localhost:3000/p)
 * EXPO_PUBLIC_SUPPORT_TG — Telegram поддержки без @ (FR-57)
 * EXPO_PUBLIC_DIAG     — "1" — диагностика 3D (см. src/diag.ts)
 */
const clean = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);

// Только прямые обращения process.env.EXPO_PUBLIC_X: Expo подставляет значения в сборку
// лишь в такой записи. Через process.env[name] в Release-сборке значение всегда пустое.
export const API_URL = clean(process.env.EXPO_PUBLIC_API_URL) ?? '';
export const MOCK = clean(process.env.EXPO_PUBLIC_MOCK) === '1' || !API_URL;
export const SHARE_URL = clean(process.env.EXPO_PUBLIC_SHARE_URL) ?? 'http://localhost:3000/p';
export const SUPPORT_TG = clean(process.env.EXPO_PUBLIC_SUPPORT_TG) ?? 'mebel_support';
/** EXPO_PUBLIC_TERMS_URL — условия использования (ссылка «условия» на экране входа; пусто — без ссылки). */
export const TERMS_URL = clean(process.env.EXPO_PUBLIC_TERMS_URL) ?? '';
/** EXPO_PUBLIC_DIAG=1 — диагностика 3D на устройстве: плашка под 3D, Documents/diag.log, маршрут /diag. По умолчанию выключена. */
export const DIAG = clean(process.env.EXPO_PUBLIC_DIAG) === '1';
/** Режим сверки с макетом (только dev): без плашки демо-режима и подсказок отладчика на снимках. */
export const SHOTS_MODE = clean(process.env.EXPO_PUBLIC_SHOTS) === '1';
/** Демо SCR-45 в моке: EXPO_PUBLIC_MOCK_STATUS = optional | required | maintenance. */
export const MOCK_STATUS = (clean(process.env.EXPO_PUBLIC_MOCK_STATUS) ?? 'none') as 'none' | 'optional' | 'required' | 'maintenance';

/** Опрос фоновых задач: раз в 2 с (раздел 18 PRD), таймаут работы системы — 90 с (SCR-05). */
export const POLL_INTERVAL_MS = 2000;
export const AI_TIMEOUT_MS = 90_000;
export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
