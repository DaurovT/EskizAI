'use client';

/**
 * Сотрудники (§3): список, создание (временный пароль показывается один раз), роль, отключение,
 * сброс пароля; у суперадмина — ещё сотрудники поставщиков, сессии и сброс 2FA с причиной.
 * mode = 'platform' — админка (все сотрудники), 'vendor' — кабинет поставщика (только свои).
 */
import { useMemo, useState } from 'react';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { dt } from '@/lib/admin/format';
import { itemsOf, PLATFORM_ROLES, qs, roleLabel, VENDOR_ROLES } from '@/lib/staff/client';
import { useAction, useApi, useClient, useSession } from '@/lib/staff/hooks';
import { TempPassword } from './auth';
import { useReason } from './reason';
import { SessionsPanel } from './security';

export interface StaffUser {
  id: string;
  email: string;
  name: string;
  role: string;
  supplier_id?: string | null;
  supplier_name?: string | null;
  org?: { kind: string; supplier_id?: string | null; supplier_name?: string | null } | null;
  role_title?: string;
  is_active: boolean;
  locked?: boolean;
  must_change_password?: boolean;
  mfa_enabled?: boolean;
  last_login_at?: string | null;
  locked_until?: string | null;
  created_at?: string | null;
}

interface Supplier {
  id: string;
  code: string;
  name: string;
}

export function StaffManager({ mode }: { mode: 'platform' | 'vendor' }) {
  const client = useClient();
  const session = useSession();
  const me = session?.me;
  const platform = mode === 'platform';
  const [filter, setFilter] = useState<string>(''); // '' — все, 'platform' — платформа, иначе supplier_id
  const listPath = `/staff/users${qs({
    supplier_id: platform && filter && filter !== 'platform' ? filter : null,
    scope: platform && filter === 'platform' ? 'platform' : null,
  })}`;
  const { data, error, loading, reload } = useApi<StaffUser[] | { items: StaffUser[] }>(listPath);
  const suppliers = useApi<Supplier[] | { items: Supplier[] }>(platform ? '/admin/suppliers' : null);
  const act = useAction();
  const [reasonDialog, askReason] = useReason();
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [sessionsOf, setSessionsOf] = useState<StaffUser | null>(null);

  const roles = platform ? [...PLATFORM_ROLES, ...VENDOR_ROLES] : VENDOR_ROLES;
  const supplierList = itemsOf(suppliers.data);
  const rows = useMemo(() => {
    // Организация: плоские поля или org {kind, supplier_id, supplier_name}
    const all = itemsOf(data).map((u) => ({
      ...u,
      supplier_id: u.supplier_id ?? u.org?.supplier_id ?? null,
      supplier_name: u.supplier_name ?? u.org?.supplier_name ?? null,
    }));
    return platform && filter === 'platform' ? all.filter((u) => !u.supplier_id) : all;
  }, [data, filter, platform]);

  async function resetPassword(u: StaffUser) {
    if (!window.confirm(`Сбросить пароль сотрудника ${u.name}? Старый пароль перестанет работать.`)) return;
    await act.run(async () => {
      const r = await client.post<{ temp_password: string }>(`/staff/users/${u.id}/reset-password`);
      setTemp({ email: u.email, password: r.temp_password });
      reload();
    });
  }

  async function resetMfa(u: StaffUser) {
    const reason = await askReason(`Сбросить 2FA: ${u.name}`, {
      hint: 'Сотрудник при следующем входе заново настроит приложение-аутентификатор.',
      confirm: 'Сбросить 2FA',
    });
    if (!reason) return;
    await act.run(async () => {
      await client.post(`/staff/users/${u.id}/mfa/reset`, { reason });
      reload();
    }, '2FA сброшена');
  }

  return (
    <>
      {reasonDialog}
      <div className="toolbar">
        {platform && (
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Все сотрудники</option>
            <option value="platform">Платформа</option>
            {supplierList.map((s) => (
              <option key={s.id} value={s.id}>
                Поставщик: {s.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="b primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Скрыть форму' : '+ Сотрудник'}
        </button>
      </div>
      <Msg message={act.message} />
      {temp && <TempPassword email={temp.email} password={temp.password} onClose={() => setTemp(null)} />}
      {creating && (
        <CreateForm
          platform={platform}
          roles={roles}
          suppliers={supplierList}
          defaultSupplier={platform && filter && filter !== 'platform' ? filter : ''}
          onCreated={(email, password) => {
            setTemp({ email, password });
            setCreating(false);
            reload();
          }}
        />
      )}
      <Loading error={error} loading={loading && !data} />
      {data &&
        (rows.length === 0 ? (
          <Empty>Сотрудников пока нет</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Роль</th>
                  {platform && <th>Организация</th>}
                  <th>Статус</th>
                  <th>Последний вход</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) =>
                  editing === u.id ? (
                    <EditRow
                      key={u.id}
                      user={u}
                      roles={u.supplier_id ? VENDOR_ROLES : PLATFORM_ROLES}
                      self={u.id === me?.id}
                      platform={platform}
                      onDone={(changed) => {
                        setEditing(null);
                        if (changed) reload();
                      }}
                    />
                  ) : (
                    <tr key={u.id} className={u.is_active ? '' : 'inactive'}>
                      <td>
                        <b>{u.name}</b>
                        {u.id === me?.id && <span className="muted"> (вы)</span>}
                        <div className="muted">{u.email}</div>
                      </td>
                      <td>{u.role_title ?? roleLabel(u.role)}</td>
                      {platform && <td>{u.supplier_id ? (u.supplier_name ?? 'поставщик') : 'Платформа'}</td>}
                      <td>
                        {u.is_active ? <Tag color="green">активен</Tag> : <Tag color="red">отключён</Tag>}{' '}
                        {u.must_change_password && <Tag color="yellow">временный пароль</Tag>}{' '}
                        {(u.locked || (u.locked_until && new Date(u.locked_until) > new Date())) && (
                          <Tag color="red">вход закрыт{u.locked_until ? ` до ${dt(u.locked_until)}` : ''}</Tag>
                        )}{' '}
                        {u.mfa_enabled === true && <Tag>2FA</Tag>}
                      </td>
                      <td>{dt(u.last_login_at)}</td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="b" onClick={() => setEditing(u.id)}>
                            Изменить
                          </button>
                          {u.id !== me?.id && (
                            <button type="button" className="b" disabled={act.busy} onClick={() => void resetPassword(u)}>
                              Сбросить пароль
                            </button>
                          )}
                          {platform && (
                            <button type="button" className="b" onClick={() => setSessionsOf(sessionsOf?.id === u.id ? null : u)}>
                              Сессии
                            </button>
                          )}
                          {platform && u.mfa_enabled && (
                            <button type="button" className="b danger" disabled={act.busy} onClick={() => void resetMfa(u)}>
                              Сбросить 2FA
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        ))}
      {sessionsOf && (
        <Box title={`Сессии: ${sessionsOf.name}`} extra={<button className="b" type="button" onClick={() => setSessionsOf(null)}>Закрыть</button>}>
          <SessionsPanel key={sessionsOf.id} userId={sessionsOf.id} self={sessionsOf.id === me?.id} />
        </Box>
      )}
    </>
  );
}

function CreateForm({
  platform,
  roles,
  suppliers,
  defaultSupplier,
  onCreated,
}: {
  platform: boolean;
  roles: string[];
  suppliers: Supplier[];
  defaultSupplier: string;
  onCreated: (email: string, password: string) => void;
}) {
  const client = useClient();
  const act = useAction();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState(platform ? (defaultSupplier ? 'vendor_owner' : 'orders_manager') : 'vendor_designer');
  const [supplierId, setSupplierId] = useState(defaultSupplier);
  const vendorRole = VENDOR_ROLES.includes(role);
  const needSupplier = platform && vendorRole;

  return (
    <Box title="Новый сотрудник">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            const r = await client.post<{ user: StaffUser; temp_password: string }>('/staff/users', {
              email: email.trim().toLowerCase(),
              name: name.trim(),
              role,
              ...(needSupplier ? { supplier_id: supplierId } : {}),
            });
            onCreated(r.user?.email ?? email, r.temp_password);
          });
        }}
      >
        <div className="form-grid">
          <label>
            Имя
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Почта (логин)
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Роль
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                  {platform && VENDOR_ROLES.includes(r) ? ' (поставщик)' : ''}
                </option>
              ))}
            </select>
          </label>
          {needSupplier && (
            <label>
              Поставщик
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
                <option value="">— выберите —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div>
            <button className="b primary" type="submit" disabled={act.busy || !name.trim() || !email.trim() || (needSupplier && !supplierId)}>
              Создать
            </button>
          </div>
        </div>
        <div className="muted">Будет выдан временный пароль — при первом входе сотрудник задаст свой.</div>
        <Msg message={act.message} />
      </form>
    </Box>
  );
}

function EditRow({
  user,
  roles,
  self,
  platform,
  onDone,
}: {
  user: StaffUser;
  roles: string[];
  self: boolean;
  platform: boolean;
  onDone: (changed: boolean) => void;
}) {
  const client = useClient();
  const act = useAction();
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState(user.role);
  const [active, setActive] = useState(user.is_active);

  return (
    <tr>
      <td>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <div className="muted">{user.email}</div>
      </td>
      <td>
        <select value={role} onChange={(e) => setRole(e.target.value)} disabled={self}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
      </td>
      {platform && <td>{user.supplier_id ? (user.supplier_name ?? 'поставщик') : 'Платформа'}</td>}
      <td>
        <label className="chk" title={self ? 'Нельзя отключить себя' : undefined}>
          <input type="checkbox" checked={active} disabled={self} onChange={(e) => setActive(e.target.checked)} /> активен
        </label>
      </td>
      <td colSpan={2}>
        <div className="row-actions">
          <button
            type="button"
            className="b primary"
            disabled={act.busy || !name.trim()}
            onClick={() =>
              void act
                .run(() =>
                  client.patch(`/staff/users/${user.id}`, {
                    ...(name.trim() !== user.name ? { name: name.trim() } : {}),
                    ...(role !== user.role ? { role } : {}),
                    ...(active !== user.is_active ? { is_active: active } : {}),
                  }),
                )
                .then((ok) => ok && onDone(true))
            }
          >
            Сохранить
          </button>
          <button type="button" className="b" onClick={() => onDone(false)}>
            Отмена
          </button>
        </div>
        <Msg message={act.message} />
      </td>
    </tr>
  );
}
