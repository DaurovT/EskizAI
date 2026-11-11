'use client';

/**
 * Сотрудники платформы и поставщиков (§3, §4a): роль, последний вход, 2FA, активные сессии, закрытый вход.
 * Действия: изменить имя и роль, отключить / включить (с причиной), сбросить пароль (временный показывается один раз),
 * сбросить 2FA (с причиной), посмотреть и завершить сессии. Последнего активного суперадмина API не даст отключить.
 */
import { Suspense, useState } from 'react';
import { ago, Dialog, ReasonField, reasonOk, SearchInput, Stat, useUrlState } from '@/components/admin/ops';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { TempPassword } from '@/components/staff/auth';
import { CreateForm, type Supplier } from '@/components/staff/StaffManager';
import { SessionsPanel } from '@/components/staff/security';
import { dt } from '@/lib/admin/format';
import { itemsOf, PLATFORM_ROLES, qs, roleLabel, VENDOR_ROLES } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';

interface Row {
  id: string;
  email: string;
  name: string;
  role: string;
  role_title?: string;
  supplier_id: string | null;
  supplier_name: string | null;
  is_active: boolean;
  must_change_password: boolean;
  mfa_enabled: boolean;
  locked: boolean;
  last_login_at: string | null;
  last_seen_at: string | null;
  active_sessions: number;
  created_at: string;
  self: boolean;
}

interface List {
  items: Row[];
  total: number;
  counters: { total: number; active_sessions: number; locked: number; without_mfa: number };
}

type Act = { kind: 'edit' | 'toggle' | 'password' | 'mfa'; user: Row };

const DEFAULTS = { q: '', scope: 'all', supplier_id: '', state: 'all' };

function Staff() {
  const [f, set] = useUrlState(DEFAULTS);
  const { data, error, loading, reload } = useApi<List>(
    `/admin/staff${qs({ q: f.q, scope: f.supplier_id ? null : f.scope, supplier_id: f.supplier_id, state: f.state })}`,
  );
  const suppliers = useApi<Supplier[] | { items: Supplier[] }>('/admin/suppliers');
  const [creating, setCreating] = useState(false);
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const [action, setAction] = useState<Act | null>(null);
  const [sessionsOf, setSessionsOf] = useState<Row | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const c = data?.counters;
  const supplierList = itemsOf(suppliers.data);

  return (
    <>
      <div className="ops-head">
        <div>
          <h1>Сотрудники</h1>
          <div className="ops-sub">Платформа и поставщики. Владельцев поставщика заводит только платформа; конструкторов — их владелец.</div>
        </div>
        <button type="button" className="b primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Скрыть форму' : '+ Сотрудник'}
        </button>
      </div>
      {temp && <TempPassword email={temp.email} password={temp.password} onClose={() => setTemp(null)} />}
      {done && <div className="msg ok">{done}</div>}
      {creating && (
        <CreateForm
          platform
          roles={[...PLATFORM_ROLES, ...VENDOR_ROLES]}
          suppliers={supplierList}
          defaultSupplier={f.supplier_id}
          onCreated={(email, password) => {
            setTemp({ email, password });
            setCreating(false);
            reload();
          }}
        />
      )}
      <div className="ops-stats">
        <Stat label="Сотрудников" value={c?.total ?? '…'} />
        <Stat label="Активных сессий" value={c?.active_sessions ?? '…'} />
        <Stat label="Без 2FA (активные)" value={c?.without_mfa ?? '…'} tone={c?.without_mfa ? 'warn' : undefined} />
        <Stat
          label="Вход закрыт после ошибок"
          value={c?.locked ?? '…'}
          tone={c?.locked ? 'bad' : undefined}
          on={f.state === 'locked'}
          onClick={() => set({ state: f.state === 'locked' ? 'all' : 'locked' })}
        />
      </div>
      <div className="ops-filters">
        <SearchInput value={f.q} onChange={(q) => set({ q })} placeholder="Имя или почта" />
        <select
          value={f.supplier_id ? `s:${f.supplier_id}` : f.scope}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('s:')) set({ supplier_id: v.slice(2), scope: 'all' });
            else set({ scope: v, supplier_id: '' });
          }}
          aria-label="Организация"
        >
          <option value="all">Все организации</option>
          <option value="platform">Платформа</option>
          <option value="suppliers">Все поставщики</option>
          {supplierList.map((s) => (
            <option key={s.id} value={`s:${s.id}`}>
              Поставщик: {s.name}
            </option>
          ))}
        </select>
        <select value={f.state} onChange={(e) => set({ state: e.target.value })} aria-label="Состояние">
          <option value="all">Активные и отключённые</option>
          <option value="active">Только активные</option>
          <option value="inactive">Только отключённые</option>
          <option value="locked">Вход закрыт</option>
        </select>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (data.items.length === 0 ? (
          <Empty>Под фильтры сотрудников нет</Empty>
        ) : (
          <div className="scroll" style={{ opacity: loading ? 0.6 : 1 }}>
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Роль</th>
                  <th>Организация</th>
                  <th>Последний вход</th>
                  <th>2FA</th>
                  <th className="num">Сессии</th>
                  <th>Состояние</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((u) => (
                  <tr key={u.id} className={u.is_active ? (u.locked ? 'ops-overdue' : '') : 'inactive'}>
                    <td>
                      <b>{u.name}</b> {u.self && <span className="muted">(вы)</span>}
                      <div className="sub">{u.email}</div>
                    </td>
                    <td>{u.role_title ?? roleLabel(u.role)}</td>
                    <td>{u.supplier_id ? (u.supplier_name ?? 'поставщик') : 'Платформа'}</td>
                    <td title={u.last_login_at ? dt(u.last_login_at) : undefined}>
                      {u.last_login_at ? ago(u.last_login_at) : <span className="muted">не входил</span>}
                      {u.last_seen_at && <div className="sub">активность {ago(u.last_seen_at)}</div>}
                    </td>
                    <td>{u.mfa_enabled ? <Tag color="green">включена</Tag> : u.role === 'superadmin' ? <Tag color="red">нет</Tag> : <span className="muted">нет</span>}</td>
                    <td className="num">
                      {u.active_sessions ? (
                        <button type="button" className="ops-clear" onClick={() => setSessionsOf(u)}>
                          {u.active_sessions}
                        </button>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td>
                      {u.is_active ? <Tag color="green">активен</Tag> : <Tag color="red">отключён</Tag>}{' '}
                      {u.locked && <Tag color="red">вход закрыт</Tag>} {u.must_change_password && <Tag color="yellow">временный пароль</Tag>}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="b" onClick={() => setAction({ kind: 'edit', user: u })}>
                          Изменить
                        </button>
                        <button type="button" className="b" onClick={() => setSessionsOf(sessionsOf?.id === u.id ? null : u)}>
                          Сессии
                        </button>
                        {!u.self && (
                          <>
                            <button type="button" className="b" onClick={() => setAction({ kind: 'password', user: u })}>
                              {u.locked ? 'Сбросить пароль и открыть вход' : 'Сбросить пароль'}
                            </button>
                            {u.mfa_enabled && (
                              <button type="button" className="b danger" onClick={() => setAction({ kind: 'mfa', user: u })}>
                                Сбросить 2FA
                              </button>
                            )}
                            <button type="button" className={`b ${u.is_active ? 'danger' : ''}`} onClick={() => setAction({ kind: 'toggle', user: u })}>
                              {u.is_active ? 'Отключить' : 'Включить'}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {sessionsOf && (
        <Box
          title={`Сессии: ${sessionsOf.name}`}
          extra={
            <button className="b" type="button" onClick={() => { setSessionsOf(null); reload(); }}>
              Закрыть
            </button>
          }
        >
          <SessionsPanel key={sessionsOf.id} userId={sessionsOf.id} self={sessionsOf.self} />
        </Box>
      )}
      {action && (
        <StaffDialog
          act={action}
          onClose={() => setAction(null)}
          onDone={(text, password) => {
            setAction(null);
            setDone(text);
            if (password) setTemp({ email: action.user.email, password });
            reload();
          }}
        />
      )}
    </>
  );
}

function StaffDialog({ act: a, onClose, onDone }: { act: Act; onClose: () => void; onDone: (text: string, password?: string) => void }) {
  const client = useClient();
  const act = useAction();
  const u = a.user;
  const [name, setName] = useState(u.name);
  const [role, setRole] = useState(u.role);
  const [reason, setReason] = useState('');
  const roles = u.supplier_id ? VENDOR_ROLES : PLATFORM_ROLES;
  const demote = u.role === 'superadmin' && role !== 'superadmin';

  if (a.kind === 'edit') {
    const changed = name.trim() !== u.name || role !== u.role;
    const roleChanged = role !== u.role;
    return (
      <Dialog title={`Изменить: ${u.name}`} onClose={onClose}>
        <div className="form-grid">
          <label>
            Имя
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Роль
            <select value={role} onChange={(e) => setRole(e.target.value)} disabled={u.self} title={u.self ? 'Свою роль менять нельзя' : undefined}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="muted">{u.email} · {u.supplier_id ? `поставщик ${u.supplier_name ?? ''}` : 'платформа'}</div>
        {roleChanged && (
          <>
            <div className={`ops-consequence ${demote ? 'red' : ''}`}>
              {roleLabel(u.role)} → <b>{roleLabel(role)}</b>. Права изменятся при следующем запросе сотрудника.
              {role === 'superadmin' && ' Суперадмину нужно будет включить 2FA.'}
            </div>
            <ReasonField value={reason} onChange={setReason} autoFocus={false} label="Причина смены роли (в журнал)" />
          </>
        )}
        <Msg message={act.message} />
        <Footer
          onClose={onClose}
          busy={act.busy}
          disabled={!changed || !name.trim() || (roleChanged && !reasonOk(reason))}
          label="Сохранить"
          onClick={() =>
            void act
              .run(() =>
                client.patch(`/staff/users/${u.id}`, {
                  ...(name.trim() !== u.name ? { name: name.trim() } : {}),
                  ...(roleChanged ? { role, reason: reason.trim() } : {}),
                }),
              )
              .then((ok) => ok && onDone('Сохранено'))
          }
        />
      </Dialog>
    );
  }

  if (a.kind === 'toggle') {
    const off = u.is_active;
    return (
      <Dialog title={`${off ? 'Отключить' : 'Включить'}: ${u.name}`} onClose={onClose}>
        <div className={`ops-consequence ${off ? 'red' : ''}`}>
          {off
            ? `Все сессии сотрудника (${u.active_sessions}) завершатся сразу, войти он больше не сможет. Данные и журнал остаются.`
            : 'Сотрудник снова сможет войти со своим паролем.'}
        </div>
        <ReasonField value={reason} onChange={setReason} />
        <Msg message={act.message} />
        <Footer
          onClose={onClose}
          busy={act.busy}
          danger={off}
          disabled={!reasonOk(reason)}
          label={off ? 'Отключить' : 'Включить'}
          onClick={() =>
            void act
              .run(() => client.patch(`/staff/users/${u.id}`, { is_active: !off, reason: reason.trim() }))
              .then((ok) => ok && onDone(off ? `${u.name} отключён` : `${u.name} снова активен`))
          }
        />
      </Dialog>
    );
  }

  if (a.kind === 'password') {
    return (
      <Dialog title={`Сбросить пароль: ${u.name}`} onClose={onClose}>
        <div className="ops-consequence">
          Старый пароль перестанет работать, все сессии завершатся{u.locked ? ', закрытый после ошибок вход откроется' : ''}. Будет
          выдан временный пароль — он покажется один раз; при входе сотрудник задаст свой.
        </div>
        <Msg message={act.message} />
        <Footer
          onClose={onClose}
          busy={act.busy}
          label="Сбросить пароль"
          onClick={() =>
            void act.run(async () => {
              const r = await client.post<{ temp_password: string }>(`/staff/users/${u.id}/reset-password`);
              onDone(`Пароль ${u.name} сброшен`, r.temp_password);
            })
          }
        />
      </Dialog>
    );
  }

  return (
    <Dialog title={`Сбросить 2FA: ${u.name}`} onClose={onClose}>
      <div className="ops-consequence red">
        Приложение-аутентификатор сотрудника перестанет подходить, все его сессии завершатся. При следующем входе он заново
        настроит 2FA{u.role === 'superadmin' ? ' (для суперадмина — обязательно)' : ''}. Делайте только после проверки личности
        (звонок, лично).
      </div>
      <ReasonField value={reason} onChange={setReason} />
      <Msg message={act.message} />
      <Footer
        onClose={onClose}
        busy={act.busy}
        danger
        disabled={!reasonOk(reason)}
        label="Сбросить 2FA"
        onClick={() =>
          void act.run(() => client.post(`/staff/users/${u.id}/mfa/reset`, { reason: reason.trim() })).then((ok) => ok && onDone(`2FA ${u.name} сброшена`))
        }
      />
    </Dialog>
  );
}

function Footer({ onClose, onClick, label, busy, disabled, danger }: { onClose: () => void; onClick: () => void; label: string; busy: boolean; disabled?: boolean; danger?: boolean }) {
  return (
    <div className="toolbar" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
      <button type="button" className="b" onClick={onClose}>
        Отмена
      </button>
      <button type="button" className={`b ${danger ? 'danger' : 'primary'}`} disabled={busy || disabled} onClick={onClick}>
        {label}
      </button>
    </div>
  );
}

export default function StaffPage() {
  return (
    <Suspense fallback={<div className="muted">Загрузка…</div>}>
      <Staff />
    </Suspense>
  );
}
