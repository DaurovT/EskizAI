import { Alert } from 'react-native';
import { ApiError } from '../api/errors';
import { BudgetDeclinedError, TaskFailedError, TaskTimeoutError } from '../api/tasks';
import { translate, type DictKey } from '../i18n';
import type { Lang } from '../api/types';

export function confirm(title: string, message: string | undefined, ok: string, cancel: string, destructive = false): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: cancel, style: 'cancel', onPress: () => resolve(false) },
      { text: ok, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

export type ErrorKind = 'offline' | 'generic' | 'ai' | 'timeout' | 'rebuild' | 'limit' | 'session' | 'not_found' | 'bad_photo' | 'maintenance'
  | 'busy' | 'forbidden' | 'login';

/**
 * Коды сервера, у которых свой понятный текст на языке мастера (сообщение сервера — только по-русски).
 * docs/staff_vendor_contract.md §8 «Вход по SMS, расходы ИИ и права мастера».
 */
export const KNOWN_ERRORS: Record<string, { kind: ErrorKind; title: DictKey; text: DictKey; serverRu?: boolean }> = {
  // ИИ: одна задача на проект, часовой и дневной лимиты, бюджет примеров
  ai_busy: { kind: 'busy', title: 'err_ai_busy_title', text: 'err_ai_busy_text' },
  ai_workshop_hourly_limit: { kind: 'limit', title: 'err_ai_hourly_title', text: 'err_ai_hourly_text' },
  ai_daily_limit: { kind: 'limit', title: 'err_ai_daily_title', text: 'err_ai_daily_text' },
  ai_budget_example: { kind: 'limit', title: 'err_ai_example_title', text: 'err_ai_example_text' },
  example_limit: { kind: 'limit', title: 'ex_limit_title', text: 'ex_limit_text' },
  // вход по коду
  code_locked: { kind: 'login', title: 'err_code_locked_title', text: 'err_code_locked_text' },
  code_limit: { kind: 'login', title: 'err_code_limit_title', text: 'err_code_limit_text' },
  sms_limit: { kind: 'login', title: 'err_code_limit_title', text: 'err_sms_limit_text' },
  registration_closed: { kind: 'login', title: 'err_reg_closed_title', text: 'err_reg_closed_text' },
  // фото не картинка (тип — по содержимому файла)
  unsupported_photo: { kind: 'bad_photo', title: 'err_photo_format_title', text: 'err_photo_format_text' },
  // 403 — нет права (переписка, возвраты, споры, исправления — у сотрудника без права заказа)
  // по-русски — точный текст сервера («Это делает владелец цеха или сотрудник с правом заказа»)
  forbidden: { kind: 'forbidden', title: 'err_forbidden_title', text: 'err_forbidden_text', serverRu: true },
};

/** Причина и понятный текст для SCR-28. Сообщения сервера (по-русски) показываем как есть. */
export function errorInfo(e: unknown, lang: Lang): { kind: ErrorKind; title: string; text: string } {
  const t = (k: DictKey, p?: Record<string, string | number>) => translate(lang, k, p);
  if (e instanceof ApiError) {
    if (e.isNetwork) return { kind: 'offline', title: t('err_offline_title'), text: t('err_offline_text') };
    if (e.status === 401) return { kind: 'session', title: t('err_session'), text: '' };
    if (e.code === 'maintenance') return { kind: 'maintenance', title: t('sys_work_title'), text: t('sys_work_text') };
    const known = KNOWN_ERRORS[e.code];
    if (known) return { kind: known.kind, title: t(known.title), text: known.serverRu && lang === 'ru' && e.message ? e.message : t(known.text) };
    if (e.status === 402) return { kind: 'limit', title: t('err_limit_title'), text: e.message };
    if (e.status === 404 && e.code !== 'model_missing') return { kind: 'not_found', title: t('err_not_found'), text: e.message };
    if (e.code === 'model_invalid' || e.code === 'build_failed' || e.code === 'invalid_tree') return { kind: 'rebuild', title: t('err_rebuild_title'), text: t('err_rebuild_text', { reason: e.message }) };
    return { kind: 'generic', title: t('err_generic_title'), text: e.message };
  }
  if (e instanceof TaskTimeoutError) return { kind: 'timeout', title: t('err_timeout_title'), text: t('err_timeout_text') };
  if (e instanceof TaskFailedError) return { kind: 'ai', title: t('err_ai_title'), text: t('err_ai_text') };
  if (e instanceof BudgetDeclinedError) return { kind: 'limit', title: t('ed_budget_title'), text: '' };
  return { kind: 'generic', title: t('err_generic_title'), text: t('err_generic_text') };
}

/** Текст ошибки одной строкой (под полем ввода): по известному коду — «Заголовок. Текст», иначе сообщение сервера. */
export function errorLine(e: unknown, lang: Lang): string {
  if (e instanceof ApiError && !KNOWN_ERRORS[e.code] && !e.isNetwork && e.message) return e.message;
  const i = errorInfo(e, lang);
  return i.text ? `${i.title}. ${i.text}` : i.title;
}

export function showError(e: unknown, lang: Lang) {
  const i = errorInfo(e, lang);
  Alert.alert(i.title, i.text || undefined);
}

/** Диалог 402 «бюджет ИИ исчерпан» → true, если мастер согласен списать ещё проект. */
export const askBudget = (lang: Lang) => (err: ApiError) =>
  confirm(translate(lang, 'ed_budget_title'), `${translate(lang, 'ed_budget_text')}${err.message ? `\n\n${err.message}` : ''}`, translate(lang, 'ed_budget_ok'), translate(lang, 'cancel'));
