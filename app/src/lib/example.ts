/** «Попробовать на примере» без навигации (покрыто тестами): пример создаёт сервер — POST /projects/example. */
import type { Api } from '../api/client';
import { isApiError } from '../api/errors';

export type ExampleResult = { kind: 'open'; id: string } | { kind: 'limit'; message: string };

/**
 * Новый пример (201) или действующий пример цеха (200) — в обоих случаях его открываем.
 * `409 example_limit` (все примеры удалены, новых больше нельзя) — не ошибка экрана, а подсказка создать свой проект.
 */
export async function ensureExample(api: Pick<Api, 'createExample'>): Promise<ExampleResult> {
  try {
    const p = await api.createExample();
    return { kind: 'open', id: p.id };
  } catch (e) {
    if (isApiError(e) && e.code === 'example_limit') return { kind: 'limit', message: e.message };
    throw e;
  }
}
