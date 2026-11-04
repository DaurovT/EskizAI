import { ApiError } from '../errors';
import { Http, type TokenStore } from '../http';
import { createHttpApi } from '../httpApi';
import { createMockApi } from '../mock/mockApi';
import { withOfflineCache, type KV } from '../offline';

const fast = (o: Parameters<typeof createMockApi>[0] = {}) => createMockApi({ latencyMs: 0, designMs: 0, editMs: 0, ...o });
const memKV = (): KV => {
  const m = new Map<string, string>();
  return { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => { m.set(k, v); }, removeItem: async (k) => { m.delete(k); } };
};
const tokens = (): TokenStore => {
  let v: { access: string; refresh: string } | null = { access: 'A', refresh: 'R' };
  return { get: async () => v, set: async (t) => { v = t; } };
};

describe('мок: приглашения (SCR-38a, SCR-23)', () => {
  it('приглашённый номер видит приглашение и принимает его', async () => {
    const api = fast();
    const tk = await api.verifyCode({ phone: '+998935550000', code: '00000' });
    expect(tk.invite?.status).toBe('pending');
    expect(tk.invite?.workshop.name).toBe('Мебель Плюс');
    expect((await api.myInvite())?.id).toBe(tk.invite?.id);
    const after = await api.acceptInvite(tk.invite!.id);
    expect(after.user.role).toBe('employee');
    expect(after.invite).toBeNull();
    expect(await api.myInvite()).toBeNull();
  });

  it('устаревшее приглашение принять нельзя, отклонить — можно', async () => {
    const api = fast();
    const tk = await api.verifyCode({ phone: '+998935550001', code: '00000' });
    expect(tk.invite?.status).toBe('expired');
    await expect(api.acceptInvite(tk.invite!.id)).rejects.toMatchObject({ status: 410, code: 'invite_expired' });
    await api.declineInvite(tk.invite!.id);
    expect(await api.myInvite()).toBeNull();
  });

  it('владелец: пригласить, повторить, отменить, права сотрудника', async () => {
    const api = fast();
    const inv = await api.inviteEmployee({ phone: '+998901110000', title: 'Замерщик', can_order: true });
    expect(inv.status).toBe('pending');
    expect(await api.listInvites()).toHaveLength(1);
    expect((await api.inviteEmployee({ phone: '+998901110000', title: 'Менеджер' })).id).toBe(inv.id);
    expect((await api.resendInvite(inv.id)).status).toBe('pending');
    await api.cancelInvite(inv.id);
    expect(await api.listInvites()).toHaveLength(0);
    const emp = (await api.listEmployees()).find((e) => e.role === 'employee')!;
    expect((await api.updateEmployee(emp.id, { can_see_cost: true })).can_see_cost).toBe(true);
    await expect(api.inviteEmployee({ phone: emp.phone })).rejects.toMatchObject({ code: 'phone_taken' });
    await api.removeEmployee(emp.id);
    expect((await api.listEmployees()).some((e) => e.id === emp.id)).toBe(false);
  });
});

describe('мок: удаление аккаунта (SCR-44)', () => {
  it('код → удаление цеха', async () => {
    const api = fast();
    const r = await api.requestDeleteCode();
    expect(r.code_length).toBe(5);
    await expect(api.deleteAccount('1111')).rejects.toMatchObject({ code: 'code_invalid' });
    expect(await api.deleteAccount('00000')).toEqual({ ok: true, scope: 'workshop' });
    expect((await api.listProjects()).items).toHaveLength(0);
  });
});

describe('техработы (SCR-45)', () => {
  it('мок отдаёт статус по режиму', async () => {
    expect((await fast().appStatus('ios', '0.1.0')).update).toBe('none');
    expect((await fast({ appStatus: 'required' }).appStatus('ios', '0.1.0')).update).toBe('required');
    const m = await fast({ appStatus: 'maintenance' }).appStatus('android', '0.1.0');
    expect(m.maintenance.on).toBe(true);
    expect(m.store_url).toContain('play.google.com');
  });

  it('503 maintenance вызывает обработчик, статус — без токена', async () => {
    const seen: unknown[] = [];
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.includes('/app/status')) return new Response(JSON.stringify({ update: 'none' }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 'maintenance', message: 'Идут технические работы', details: { until: null } } }), { status: 503 });
    };
    const http = new Http({ baseUrl: 'http://api', tokens: tokens(), fetch, onMaintenance: (e) => seen.push(e.details) });
    const api = createHttpApi(http);
    await expect(api.createProject({ title: 'x' })).rejects.toMatchObject({ status: 503, code: 'maintenance' });
    expect(seen).toEqual([{ until: null }]);
    await api.appStatus('ios', '1.0.0');
    const last = calls[calls.length - 1];
    expect(last.url).toBe('http://api/app/status?platform=ios&version=1.0.0');
    expect((last.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('замер во время техработ остаётся в очереди', async () => {
    const base = fast();
    let maintenance = true;
    const wrapped = new Proxy(base, {
      get(t, k) {
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        if (k === 'addMeasurement') {
          return (...a: unknown[]) => (maintenance ? Promise.reject(new ApiError(503, 'maintenance', 'techwork')) : (v as (...x: unknown[]) => unknown)(...a));
        }
        return v;
      },
    });
    const api = withOfflineCache(wrapped, memKV());
    const pid = (await api.listProjects()).items.find((p) => p.status === 'sent')!.id;
    expect((await api.addMeasurement(pid, { width: 1800 })).id).toMatch(/^pending-/);
    expect(await api.flushOutbox()).toBe(0);
    expect(await api.pendingMeasurements()).toHaveLength(1);
    maintenance = false;
    expect(await api.flushOutbox()).toBe(1);
  });
});
