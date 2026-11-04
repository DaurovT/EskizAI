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

export type ErrorKind = 'offline' | 'generic' | 'ai' | 'timeout' | 'rebuild' | 'limit' | 'session' | 'not_found' | 'bad_photo' | 'maintenance';

/** Причина и понятный текст для SCR-28. Сообщения сервера (по-русски) показываем как есть. */
export function errorInfo(e: unknown, lang: Lang): { kind: ErrorKind; title: string; text: string } {
  const t = (k: DictKey, p?: Record<string, string | number>) => translate(lang, k, p);
  if (e instanceof ApiError) {
    if (e.isNetwork) return { kind: 'offline', title: t('err_offline_title'), text: t('err_offline_text') };
    if (e.status === 401) return { kind: 'session', title: t('err_session'), text: '' };
    if (e.code === 'maintenance') return { kind: 'maintenance', title: t('sys_work_title'), text: t('sys_work_text') };
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

export function showError(e: unknown, lang: Lang) {
  const i = errorInfo(e, lang);
  Alert.alert(i.title, i.text || undefined);
}

/** Диалог 402 «бюджет ИИ исчерпан» → true, если мастер согласен списать ещё проект. */
export const askBudget = (lang: Lang) => (err: ApiError) =>
  confirm(translate(lang, 'ed_budget_title'), `${translate(lang, 'ed_budget_text')}${err.message ? `\n\n${err.message}` : ''}`, translate(lang, 'ed_budget_ok'), translate(lang, 'cancel'));
