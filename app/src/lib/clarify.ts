/**
 * SCR-07 «Уточним детали» (Clarify.dc.html): вопросы ИИ, предложения замены и пояснения одним списком.
 * Чистые функции — без React, покрыты тестами.
 */
import type { DesignQuestion } from '../api/types';

/** Предложение замены (✦): kind 'proposal' от сервера, иначе по id (alt_ / swap_ / replace_ / offer_). */
export const isProposal = (q: DesignQuestion) => q.kind === 'proposal' || (q.kind == null && /^(alt|swap|replace|offer)[_-]/.test(q.id));

export type ClarifyRow = { type: 'q'; q: DesignQuestion } | { type: 's'; q: DesignQuestion } | { type: 'i'; text: string };

/**
 * Порядок строк как в макете: первый вопрос, пояснения ИИ (что взял по умолчанию — не больше двух), остальные
 * вопросы, предложения замены.
 */
export function clarifyRows(qs: DesignQuestion[], info: string[] = []): ClarifyRow[] {
  const ask = qs.filter((q) => !isProposal(q)).map((q): ClarifyRow => ({ type: 'q', q }));
  const offers = qs.filter(isProposal).map((q): ClarifyRow => ({ type: 's', q }));
  const notes = [...new Set(info.map((x) => x.trim()).filter(Boolean))].slice(0, 2).map((text): ClarifyRow => ({ type: 'i', text }));
  return [...ask.slice(0, 1), ...notes, ...ask.slice(1), ...offers];
}
