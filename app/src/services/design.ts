/** Результат DesignOut → куда вести мастера (SCR-05/06/07/29). */
import { router } from 'expo-router';
import type { DesignOut } from '../api/types';
import { updateMeta } from '../state/projectMeta';
import { createStore } from '../state/store';

/** Запрос, который экран разбора должен запустить при открытии (из SCR-04). */
export const pendingDesign = createStore<Record<string, { text: string | null; photo_ids: string[] }>>({});

export function applyDesign(projectId: string, d: DesignOut, opts: { replace?: boolean; from?: 'breakdown' | 'questions' | 'type'; navigate?: boolean } = {}) {
  updateMeta(projectId, (m) => ({
    design: { ...d, objects: d.objects ?? [] },
    estimated: d.status === 'ready' ? d.estimated ?? [] : m.estimated,
    answers: d.status === 'questions' ? m.answers : {},
    // ответы прошлых раундов живут, пока идут уточнения; новое распознавание — с чистого листа
    answered: d.status === 'questions' && opts.from === 'questions' ? m.answered : [],
  }));
  if (opts.navigate === false) return;
  const go = (path: string) => (opts.replace ? router.replace(path as never) : router.push(path as never));
  if (d.status === 'choose_type' && opts.from !== 'type') return go(`/project/${projectId}/choose-type`);
  if (d.status === 'questions' && opts.from === 'type') return go(`/project/${projectId}/questions`);
  if ((d.status === 'ready' || d.status === 'failed') && opts.from !== 'breakdown') return go(`/project/${projectId}/breakdown`);
}
