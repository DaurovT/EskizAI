/**
 * Фоновые задачи ИИ: POST … → 202 {task_id}, затем GET /tasks/{id} раз в 2 с.
 * 402 — бюджет ИИ проекта исчерпан: спрашиваем мастера и повторяем с confirm_extra_project: true.
 * Модуль без React и без RN — покрыт тестами.
 */
import { ApiError } from './errors';
import type { TaskAccepted, TaskOut, TaskStatus } from './types';
import { AI_TIMEOUT_MS, POLL_INTERVAL_MS } from '../config';

export class TaskFailedError extends Error {
  constructor(message: string, public readonly taskId: string) {
    super(message);
    this.name = 'TaskFailedError';
  }
}
export class TaskTimeoutError extends Error {
  constructor(public readonly taskId: string) {
    super('timeout');
    this.name = 'TaskTimeoutError';
  }
}
export class TaskAbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'TaskAbortedError';
  }
}
/** Мастер отказался списывать ещё один проект из лимита. */
export class BudgetDeclinedError extends Error {
  constructor(public readonly cause402: ApiError) {
    super('budget_declined');
    this.name = 'BudgetDeclinedError';
  }
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: { aborted: boolean };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Сколько сетевых ошибок подряд терпим (плохой 3G на объекте). */
  maxNetworkErrors?: number;
  onStatus?: (s: TaskStatus) => void;
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const taskStatus = (t: TaskOut<unknown>): TaskStatus => t.status ?? 'queued';

export async function pollTask<R>(
  getTask: (id: string) => Promise<TaskOut<R>>,
  taskId: string,
  o: PollOptions = {},
): Promise<R> {
  const interval = o.intervalMs ?? POLL_INTERVAL_MS;
  const timeout = o.timeoutMs ?? AI_TIMEOUT_MS;
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? Date.now;
  const maxNet = o.maxNetworkErrors ?? 3;
  const started = now();
  let netErrors = 0;
  for (;;) {
    if (o.signal?.aborted) throw new TaskAbortedError();
    try {
      const t = await getTask(taskId);
      netErrors = 0;
      const s = taskStatus(t);
      o.onStatus?.(s);
      if (s === 'done') return t.result as R;
      if (s === 'failed') throw new TaskFailedError(t.error || 'failed', taskId);
    } catch (e) {
      if (!(e instanceof ApiError) || !e.isNetwork) throw e;
      netErrors += 1;
      if (netErrors > maxNet) throw e;
    }
    if (now() - started >= timeout) throw new TaskTimeoutError(taskId);
    await sleep(interval);
    if (o.signal?.aborted) throw new TaskAbortedError();
  }
}

/**
 * Отправить запрос, который может вернуть 402 (бюджет ИИ исчерпан).
 * `send(confirm)` — запрос; `ask(err)` — диалог «Списать ещё один проект из лимита?».
 */
export async function withBudgetConfirm<T>(
  send: (confirmExtraProject: boolean) => Promise<T>,
  ask: (err: ApiError) => Promise<boolean>,
): Promise<T> {
  try {
    return await send(false);
  } catch (e) {
    if (!(e instanceof ApiError) || !e.isPaymentRequired) throw e;
    if (!(await ask(e))) throw new BudgetDeclinedError(e);
    return send(true);
  }
}

/** Полный цикл: старт задачи (с подтверждением 402) → опрос до результата. */
export async function runAiTask<R>(
  start: (confirmExtraProject: boolean) => Promise<TaskAccepted>,
  getTask: (id: string) => Promise<TaskOut<R>>,
  ask: (err: ApiError) => Promise<boolean>,
  o: PollOptions = {},
): Promise<R> {
  const { task_id } = await withBudgetConfirm(start, ask);
  return pollTask(getTask, task_id, o);
}
