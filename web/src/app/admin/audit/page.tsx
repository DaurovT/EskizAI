'use client';

/** Журнал действий (§4a, §6): только чтение — ни удалить, ни изменить нельзя. */
import { useState } from 'react';
import { defaultPeriod, PeriodFilter, type Period } from '@/components/admin/Period';
import { Empty, Loading, Pager } from '@/components/admin/ui';
import { dt } from '@/lib/admin/format';
import { qs } from '@/lib/staff/client';
import { useApi } from '@/lib/staff/hooks';

interface Entry {
  id: string;
  actor_type: string;
  actor_id: string | null;
  actor_name?: string | null;
  workshop_id?: string | null;
  entity: string;
  entity_id?: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

const ACTOR: Record<string, string> = { staff: 'сотрудник', admin: 'админ', master: 'мастер', system: 'система', user: 'мастер' };
const LIMIT = 100;

/** Причина опасного действия пишется в after.reason. */
function reasonOf(e: Entry): string | null {
  const r = e.after?.reason;
  return typeof r === 'string' && r ? r : null;
}

function short(v: Record<string, unknown> | null): string {
  if (!v) return '—';
  const s = JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

export default function AuditPage() {
  const [period, setPeriod] = useState<Period>(defaultPeriod(6));
  const [actor, setActor] = useState('');
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState({ actor: '', entity: '', action: '' });
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading } = useApi<{ items: Entry[]; total: number; page: number; page_size: number }>(
    `/admin/audit${qs({ ...applied, from: period.from, to: period.to, page: Math.floor(offset / LIMIT) + 1, page_size: LIMIT })}`,
  );
  const rows = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <>
      <h1>Журнал действий</h1>
      <PeriodFilter
        value={period}
        onChange={(p) => {
          setOffset(0);
          setPeriod(p);
        }}
      />
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setApplied({ actor: actor.trim(), entity: entity.trim(), action: action.trim() });
        }}
      >
        <input
          placeholder="Кто: id сотрудника, «admin-token» или тип (staff, master, system)"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          style={{ minWidth: 280 }}
        />
        <input placeholder="Объект (order, staff_user, supplier…)" value={entity} onChange={(e) => setEntity(e.target.value)} />
        <input placeholder="Действие (status, login…)" value={action} onChange={(e) => setAction(e.target.value)} />
        <button className="b" type="submit">
          Найти
        </button>
      </form>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (rows.length === 0 ? (
          <Empty>Записей нет</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кто</th>
                  <th>Что</th>
                  <th>Причина</th>
                  <th>Было → стало</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <td style={{ whiteSpace: 'nowrap' }}>{dt(e.created_at)}</td>
                    <td>
                      {e.actor_name ?? (e.actor_id === 'admin-token' ? 'общий токен' : (e.actor_id?.slice(0, 8) ?? '—'))}
                      <div className="muted">
                        {ACTOR[e.actor_type] ?? e.actor_type}
                      </div>
                    </td>
                    <td>
                      {e.entity} · <b>{e.action}</b>
                      {e.entity_id && <div className="muted">{e.entity_id.slice(0, 8)}</div>}
                    </td>
                    <td>{reasonOf(e) ?? '—'}</td>
                    <td>
                      {open === e.id ? (
                        <pre>{JSON.stringify({ before: e.before, after: e.after }, null, 2)}</pre>
                      ) : (
                        <code style={{ fontSize: 12, wordBreak: 'break-word' }}>
                          {short(e.before)} → {short(e.after)}
                        </code>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager total={total} limit={LIMIT} offset={offset} onChange={setOffset} />
          </div>
        ))}
    </>
  );
}
