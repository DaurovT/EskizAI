/** Определение окружения в браузере (только на клиенте). */

export function isTelegramInApp(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return /Telegram/i.test(navigator.userAgent) || 'TelegramWebviewProxy' in w || 'TelegramWebview' in w;
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

/**
 * Открыть текущую страницу во внешнем браузере.
 * Android: intent:// без пакета — система откроет браузер по умолчанию.
 * iOS: программно нельзя — копируем ссылку, пользователь вставит её в Safari.
 * Возвращает 'copied', если ссылка скопирована вместо открытия.
 */
export async function openInExternalBrowser(): Promise<'opened' | 'copied' | 'failed'> {
  const url = new URL(window.location.href);
  url.hash = '';
  if (isAndroid()) {
    const intent = `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${url.protocol.replace(':', '')};action=android.intent.action.VIEW;end`;
    window.location.href = intent;
    return 'opened';
  }
  try {
    await navigator.clipboard.writeText(url.toString());
    return 'copied';
  } catch {
    return 'failed';
  }
}
