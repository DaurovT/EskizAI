/**
 * «Создать проект по чертежу» (SCR-53 / TInbox): POST /inbox/drawings/{id}/project, метаданные чертежа для разбора
 * (meta.drawing — шапка и лист в SCR-55), отложенный запуск ИИ по тексту листа и переход к разбору.
 * Общий для телефона (app/inbox/[id].tsx) и широкого планшета (src/screens/InboxWide.tsx).
 */
import { router } from 'expo-router';
import { api } from '../api';
import type { InboxDrawing, InboxSheet } from '../api/types';
import { drawingKind, drawingTitle } from '../lib/inbox';
import { updateMeta } from '../state/projectMeta';
import { pendingDesign } from './design';

/** Ключ листа для сервера: id, если есть, иначе номер. */
export const sheetKey = (s: InboxSheet) => s.id ?? s.number ?? null;

export async function makeProjectFromDrawing(d: InboxDrawing, sheet: InboxSheet | null): Promise<string> {
  const r = await api.projectFromDrawing(d.id, sheet ? sheetKey(sheet) : null);
  updateMeta(r.project_id, {
    photos: r.photo_url ? [r.photo_url] : [], answers: {}, answered: [], notes: {}, design: null,
    drawing: { inboxId: d.id, title: drawingTitle(d), kind: drawingKind(d), sheet: r.sheet?.number ?? null, sheetName: r.sheet?.name ?? null },
  });
  pendingDesign.set((p) => ({ ...p, [r.project_id]: { text: r.text, photo_ids: r.photo_id ? [r.photo_id] : [] } }));
  router.push(`/project/${r.project_id}/breakdown`);
  return r.project_id;
}
