/**
 * Вибрация (Motion.dc.html): лёгкая — переключатели и шаги шторки, «успех» — оплата и заказ, «ошибка» — неверный код.
 * expo-haptics подключается лениво: если нативного модуля нет (старая сборка, Expo Go, тесты) — молча ничего не делаем.
 */
type HapticsModule = typeof import('expo-haptics');

let mod: HapticsModule | null | undefined;
function load(): HapticsModule | null {
  if (mod !== undefined) return mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-haptics') as HapticsModule;
  } catch {
    mod = null;
  }
  return mod;
}

const safe = (fn: (h: HapticsModule) => Promise<unknown>) => {
  const h = load();
  if (!h) return;
  try { fn(h).catch(() => undefined); } catch { /* нет нативного модуля */ }
};

export const haptics = {
  /** Переключатель, выбор, шаг шторки. */
  light: () => safe((h) => h.impactAsync(h.ImpactFeedbackStyle.Light)),
  selection: () => safe((h) => h.selectionAsync()),
  /** Оплата прошла, заказ отправлен. */
  success: () => safe((h) => h.notificationAsync(h.NotificationFeedbackType.Success)),
  warning: () => safe((h) => h.notificationAsync(h.NotificationFeedbackType.Warning)),
  /** Неверный код, ошибка действия. */
  error: () => safe((h) => h.notificationAsync(h.NotificationFeedbackType.Error)),
};
