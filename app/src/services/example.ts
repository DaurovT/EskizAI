/** «Попробовать на примере» (PRD §15): готовый шкаф-купе, лимит не тратится, заказать нельзя. */
import { router } from 'expo-router';
import { api } from '../api';
import { SAMPLES } from '../api/mock/data';
import type { Lang } from '../api/types';
import { translate } from '../i18n';
import { updateMeta } from '../state/projectMeta';

export async function openExample(lang: Lang) {
  const p = await api.createProject({ title: translate(lang, 'example_title'), is_example: true });
  await api.saveModel(p.id, { tree: SAMPLES.kupe_3doors.tree, source: 'manual', label: translate(lang, 'example_title') });
  updateMeta(p.id, { estimated: ['/width'] });
  // SCR-41: пример открывается экраном с подсказками (OnboardingHints.dc.html), из него — редактор/отправка
  router.push(`/project/${p.id}/example`);
}
