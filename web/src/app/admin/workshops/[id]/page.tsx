'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { LogTable, type LogEntry } from '@/components/admin/LogTable';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { useReason } from '@/components/staff/reason';
import { useCan } from '@/lib/staff/hooks';
import { post } from '@/lib/admin/api';
import { dt, ORDER_STATUS_LABEL, sum, usd } from '@/lib/admin/format';
import { useAction, useApi } from '@/lib/admin/useApi';

interface Card {
  id: string;
  name: string;
  city: string;
  phone: string | null;
  plan: string;
  pro_until: string | null;
  blocked: boolean;
  created_at: string;
  pricing: { labor_mode: string; labor_percent: number; labor_fixed: number; markup: Record<string, number> };
  limits: { period: string; free_limit: number; free_used: number; free_left: number; pack_left: number; unlimited: boolean };
  extra_charges: number;
  users: { id: string; phone: string; name: string; role: string; is_active: boolean; last_login_at: string | null }[];
  projects: { id: string; title: string; status_label: string; product_type: string | null; is_example: boolean; updated_at: string }[];
  orders: { id: string; project_title: string | null; status: string; estimate_total: number | null; created_at: string }[];
  ai_cost_usd: number;
  action_log: LogEntry[];
}

export default function WorkshopCard() {
  const { id } = useParams<{ id: string }>();
  const { data: w, error, loading, reload } = useApi<Card>(`/admin/workshops/${id}`);
  const act = useAction();
  const [credit, setCredit] = useState('1');
  const [plan, setPlan] = useState('');
  const [proUntil, setProUntil] = useState('');
  const [reasonDialog, askReason] = useReason();
  const can = useCan();
  const [imp, setImp] = useState<{ token: string; expiresAt: string | null; userId: string | null } | null>(null);
  const [impUser, setImpUser] = useState('');

  if (!w) return <Loading error={error} loading={loading} />;

  /** Ручное начисление и тариф — опасные действия: с причиной (§4a). */
  async function grant(body: Record<string, unknown>, title: string, ok: string) {
    const reason = await askReason(title, { confirm: 'Начислить', danger: false });
    if (!reason) return;
    await act.run(() => post(`/admin/workshops/${id}/plan`, { ...body, reason }), ok).then(reload);
  }

  async function impersonate() {
    const reason = await askReason('Смотреть глазами мастера', {
      hint: 'Только чтение: выдаётся короткий токен, все запросы помечаются в журнале действий.',
      confirm: 'Открыть',
      danger: false,
    });
    if (!reason) return;
    await act.run(async () => {
      const r = await post<{ access_token: string; expires_in?: number; read_only?: boolean; user_id?: string }>(
        `/admin/workshops/${id}/impersonate`,
        { reason, user_id: impUser || null },
      );
      setImp({
        token: r.access_token,
        expiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000).toISOString() : null,
        userId: r.user_id ?? null,
      });
    });
  }

  return (
    <>
      {reasonDialog}
      <h1>
        {w.name} {w.blocked && <Tag color="red">заблокирован</Tag>}
      </h1>
      <Msg message={act.message} />
      {imp && (
        <div className="temp-pass">
          <b>
            Просмотр «глазами мастера» — только чтение
            {imp.userId && ` · ${w.users.find((u) => u.id === imp.userId)?.name || w.users.find((u) => u.id === imp.userId)?.phone || ''}`}
          </b>
          <div className="temp-pass-row">
            <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{imp.token}</code>
            <button type="button" className="b" onClick={() => void navigator.clipboard.writeText(imp.token)}>
              Скопировать токен
            </button>
          </div>
          <div className="muted">
            Токен мастера (Bearer) для API и приложения в режиме отладки; действует{' '}
            {imp.expiresAt ? `до ${dt(imp.expiresAt)}` : 'недолго'}. Изменения через него запрещены, каждый запрос пишется в
            журнал. Не передавайте его третьим лицам.
          </div>
          <div>
            <button type="button" className="b" onClick={() => setImp(null)}>
              Скрыть
            </button>
          </div>
        </div>
      )}
      <div className="grid2">
        <Box title="Цех">
          <dl className="kv">
            <dt>Город</dt>
            <dd>{w.city}</dd>
            <dt>Телефон</dt>
            <dd>{w.phone ?? '—'}</dd>
            <dt>Тариф</dt>
            <dd>
              {w.plan}
              {w.pro_until && <span className="muted"> до {dt(w.pro_until, false)}</span>}
            </dd>
            <dt>Работа мастера</dt>
            <dd>{w.pricing.labor_mode === 'fixed' ? sum(w.pricing.labor_fixed) : `${w.pricing.labor_percent}%`}</dd>
            <dt>Наценки</dt>
            <dd>
              корпус {w.pricing.markup.body}%, фасады {w.pricing.markup.fronts}%, фурнитура {w.pricing.markup.hardware}%,
              услуги {w.pricing.markup.services}%
            </dd>
            <dt>Расход на ИИ</dt>
            <dd>{usd(w.ai_cost_usd, 2)}</dd>
            <dt>Создан</dt>
            <dd>{dt(w.created_at)}</dd>
          </dl>
          <div className="toolbar" style={{ marginTop: 12 }}>
            <button
              className={`b ${w.blocked ? '' : 'danger'}`}
              type="button"
              disabled={act.busy}
              onClick={() =>
                void askReason(w.blocked ? 'Разблокировать цех' : 'Заблокировать цех', {
                  confirm: w.blocked ? 'Разблокировать' : 'Заблокировать',
                  danger: !w.blocked,
                }).then((reason) => {
                  if (!reason) return;
                  void act
                    .run(() => post(`/admin/workshops/${id}/block`, { blocked: !w.blocked, reason }), 'Сохранено')
                    .then(reload);
                })
              }
            >
              {w.blocked ? 'Разблокировать' : 'Заблокировать'}
            </button>
            {can('impersonate') && (
              <>
                <select value={impUser} onChange={(e) => setImpUser(e.target.value)} title="Чьими глазами">
                  <option value="">владелец цеха</option>
                  {w.users
                    .filter((u) => u.is_active && u.role !== 'owner')
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name || u.phone}
                      </option>
                    ))}
                </select>
                <button className="b" type="button" disabled={act.busy} onClick={() => void impersonate()}>
                  Смотреть глазами мастера
                </button>
              </>
            )}
          </div>
        </Box>
        <Box title={`Лимиты · ${w.limits.period}`}>
          <dl className="kv">
            <dt>Бесплатно</dt>
            <dd>{w.limits.unlimited ? 'без лимита (Pro)' : `использовано ${w.limits.free_used} из ${w.limits.free_limit}, осталось ${w.limits.free_left}`}</dd>
            <dt>Пакет</dt>
            <dd>{w.limits.pack_left}</dd>
            <dt>Доп. списания за ИИ</dt>
            <dd>{w.extra_charges}</dd>
          </dl>
          <h3>Ручное начисление проектов</h3>
          <div className="toolbar">
            <input type="number" value={credit} onChange={(e) => setCredit(e.target.value)} style={{ width: 90 }} />
            <button
              className="b primary"
              type="button"
              disabled={act.busy || !Number(credit)}
              onClick={() =>
                void grant({ add_pack_projects: Number(credit) }, `Начислить ${credit} проект(ов) в пакет`, 'Начислено')
              }
            >
              Начислить в пакет
            </button>
          </div>
          <h3>Тариф</h3>
          <div className="toolbar">
            <select value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="">— не менять —</option>
              <option value="free">free</option>
              <option value="pack">pack</option>
              <option value="pro">pro</option>
            </select>
            <input type="date" value={proUntil} onChange={(e) => setProUntil(e.target.value)} title="Pro до" />
            <button
              className="b"
              type="button"
              disabled={act.busy || (!plan && !proUntil)}
              onClick={() =>
                void grant(
                  {
                    plan: plan || null,
                    pro_until: proUntil ? new Date(`${proUntil}T23:59:59+05:00`).toISOString() : null,
                  },
                  'Изменить тариф / продлить Pro',
                  'Тариф изменён',
                )
              }
            >
              Сохранить тариф
            </button>
          </div>
        </Box>
      </div>
      <Box title="Пользователи">
        <table>
          <thead>
            <tr>
              <th>Телефон</th>
              <th>Имя</th>
              <th>Роль</th>
              <th>Последний вход</th>
            </tr>
          </thead>
          <tbody>
            {w.users.map((u) => (
              <tr key={u.id}>
                <td>{u.phone}</td>
                <td>{u.name || '—'}</td>
                <td>
                  {u.role === 'owner' ? 'владелец' : 'сотрудник'} {!u.is_active && <Tag color="red">отключён</Tag>}
                </td>
                <td>{dt(u.last_login_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
      <div className="grid2">
        <Box title={`Проекты (${w.projects.length})`}>
          {w.projects.length === 0 ? (
            <Empty />
          ) : (
            <table>
              <tbody>
                {w.projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/admin/projects/${p.id}`}>{p.title}</Link> {p.is_example && <Tag>пример</Tag>}
                    </td>
                    <td>{p.status_label}</td>
                    <td>{p.product_type ?? '—'}</td>
                    <td>{dt(p.updated_at, false)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Box>
        <Box title={`Заказы (${w.orders.length})`}>
          {w.orders.length === 0 ? (
            <Empty />
          ) : (
            <table>
              <tbody>
                {w.orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/admin/orders/${o.id}`}>{o.project_title ?? o.id.slice(0, 8)}</Link>
                    </td>
                    <td>{ORDER_STATUS_LABEL[o.status] ?? o.status}</td>
                    <td className="num">{sum(o.estimate_total)}</td>
                    <td>{dt(o.created_at, false)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Box>
      </div>
      <Box title="Журнал действий">
        <LogTable rows={w.action_log} />
      </Box>
    </>
  );
}
