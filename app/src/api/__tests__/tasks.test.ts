import { ApiError } from '../errors';
import {
  BudgetDeclinedError, TaskAbortedError, TaskFailedError, TaskTimeoutError, pollTask, runAiTask, withBudgetConfirm,
} from '../tasks';
import type { TaskOut } from '../types';
import { createMockApi } from '../mock/mockApi';

/** Фальшивые часы: sleep двигает время, ничего не ждёт. */
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
}

const seq = <R>(items: (TaskOut<R> | Error)[]) => {
  let i = 0;
  const calls: string[] = [];
  const fn = jest.fn(async (id: string) => {
    calls.push(id);
    const x = items[Math.min(i++, items.length - 1)];
    if (x instanceof Error) throw x;
    return x;
  });
  return { fn, calls };
};

describe('pollTask', () => {
  it('опрашивает раз в 2 с до done и возвращает result', async () => {
    const c = clock();
    const { fn } = seq([
      { status: 'queued', result: null, error: null },
      { status: 'running', result: null, error: null },
      { status: 'done', result: { ok: 1 }, error: null },
    ]);
    await expect(pollTask(fn, 't1', { sleep: c.sleep, now: c.now })).resolves.toEqual({ ok: 1 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(c.sleeps).toEqual([2000, 2000]);
  });

  it('читает только status (контракт API: {id, status, result, error})', async () => {
    const c = clock();
    const { fn } = seq([{ id: 't', status: 'running', result: null, error: null }, { id: 't', status: 'done', result: 7, error: null }]);
    await expect(pollTask(fn, 't', { sleep: c.sleep, now: c.now })).resolves.toBe(7);
  });

  it('failed → TaskFailedError с текстом ошибки', async () => {
    const c = clock();
    const { fn } = seq([{ status: 'failed', result: null, error: 'ИИ вернул невалидный ответ' }]);
    await expect(pollTask(fn, 't', { sleep: c.sleep, now: c.now })).rejects.toEqual(new TaskFailedError('ИИ вернул невалидный ответ', 't'));
  });

  it('таймаут 90 с → TaskTimeoutError', async () => {
    const c = clock();
    const { fn } = seq([{ status: 'running', result: null, error: null }]);
    await expect(pollTask(fn, 't', { sleep: c.sleep, now: c.now })).rejects.toBeInstanceOf(TaskTimeoutError);
    expect(c.now()).toBe(90_000);
    expect(fn).toHaveBeenCalledTimes(46);
  });

  it('терпит до 3 сетевых ошибок подряд, потом бросает', async () => {
    const c = clock();
    const net = new ApiError(0, 'network', 'offline');
    const ok = seq([net, net, net, { status: 'done', result: 'x', error: null }]);
    await expect(pollTask(ok.fn, 't', { sleep: c.sleep, now: c.now })).resolves.toBe('x');
    const bad = seq([net, net, net, net]);
    await expect(pollTask(bad.fn, 't', { sleep: c.sleep, now: c.now })).rejects.toBe(net);
  });

  it('ошибка сервера (не сеть) пробрасывается сразу', async () => {
    const c = clock();
    const e404 = new ApiError(404, 'not_found', 'Задача не найдена');
    const { fn } = seq([e404]);
    await expect(pollTask(fn, 't', { sleep: c.sleep, now: c.now })).rejects.toBe(e404);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('отмена через signal', async () => {
    const c = clock();
    const signal = { aborted: false };
    const { fn } = seq([{ status: 'running', result: null, error: null }]);
    const p = pollTask(fn, 't', { sleep: async (ms) => { await c.sleep(ms); signal.aborted = true; }, now: c.now, signal });
    await expect(p).rejects.toBeInstanceOf(TaskAbortedError);
  });
});

describe('withBudgetConfirm (402)', () => {
  const e402 = new ApiError(402, 'ai_budget_exhausted', 'Бюджет ИИ исчерпан');

  it('без 402 — один запрос, без подтверждения', async () => {
    const send = jest.fn(async (c: boolean) => (c ? 'confirmed' : 'plain'));
    const ask = jest.fn(async () => true);
    await expect(withBudgetConfirm(send, ask)).resolves.toBe('plain');
    expect(ask).not.toHaveBeenCalled();
  });

  it('402 → спрашиваем → повтор с confirm_extra_project', async () => {
    const send = jest.fn(async (c: boolean) => { if (!c) throw e402; return 'confirmed'; });
    const ask = jest.fn(async () => true);
    await expect(withBudgetConfirm(send, ask)).resolves.toBe('confirmed');
    expect(send.mock.calls).toEqual([[false], [true]]);
    expect(ask).toHaveBeenCalledWith(e402);
  });

  it('мастер отказался → BudgetDeclinedError, повтора нет', async () => {
    const send = jest.fn(async () => { throw e402; });
    await expect(withBudgetConfirm(send, async () => false)).rejects.toBeInstanceOf(BudgetDeclinedError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('другие ошибки не трогает', async () => {
    const e409 = new ApiError(409, 'x', 'y');
    await expect(withBudgetConfirm(async () => { throw e409; }, async () => true)).rejects.toBe(e409);
  });
});

describe('runAiTask на моке: бюджет правок и 402', () => {
  it('после исчерпания бюджета спрашивает подтверждение и списывает проект', async () => {
    const api = createMockApi({ latencyMs: 0, editMs: 0, designMs: 0, aiBudget: 2 });
    const { items } = await api.listProjects();
    // шкаф: мок-ИИ понимает «ширина N» для шкафов (кухни он переспрашивает)
    const id = (items.find((p) => p.id === 'p-kupe' && p.current_version_id) ?? items.find((p) => p.current_version_id && !/кухн/i.test(p.title)))!.id;
    const limitsBefore = await api.limits();
    const c = clock();
    const ask = jest.fn(async () => true);
    for (let i = 0; i < 3; i++) {
      const r = await runAiTask(
        (confirm) => api.aiEdit(id, `ширина ${2000 + i * 10}`, confirm),
        (t) => api.getTask(t),
        ask,
        { sleep: c.sleep, now: c.now },
      );
      expect(r).toMatchObject({ ok: true });
    }
    expect(ask).toHaveBeenCalledTimes(1);
    expect((ask.mock.calls[0] as unknown[])[0]).toMatchObject({ status: 402 });
    expect((await api.limits()).free_left).toBe(limitsBefore.free_left - 1);
  });
});
