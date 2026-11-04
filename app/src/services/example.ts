/**
 * «Попробовать на примере» (PRD §15): готовый шкаф-купе, лимит не тратится, заказать нельзя.
 * Пример создаёт сервер из своего шаблона (модель v1, ширина — «оценка»); повторное нажатие открывает тот же пример.
 */
import { router } from 'expo-router';
import { Alert } from 'react-native';
import { api } from '../api';
import type { Lang } from '../api/types';
import { translate } from '../i18n';
import { ensureExample } from '../lib/example';

export async function openExample(lang: Lang) {
  const r = await ensureExample(api);
  if (r.kind === 'limit') {
    const t = (k: 'ex_limit_title' | 'ex_limit_text' | 'ex_limit_new' | 'cancel') => translate(lang, k);
    Alert.alert(t('ex_limit_title'), t('ex_limit_text'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('ex_limit_new'), onPress: () => router.push('/project/new') },
    ]);
    return;
  }
  // SCR-41: пример открывается экраном с подсказками (OnboardingHints.dc.html), из него — редактор/отправка
  router.push(`/project/${r.id}/example`);
}
