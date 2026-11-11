'use client';

import { dt } from '@/lib/admin/format';
import { Empty } from './ui';

export interface LogEntry {
  id: string;
  actor_type: string;
  actor_id: string | null;
  entity: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

const ACTOR: Record<string, string> = {
  user: 'мастер', master: 'мастер', admin: 'админка', staff: 'сотрудник', vendor: 'поставщик', system: 'система',
};

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return v.toLocaleString('ru-RU');
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}…` : v;
  return JSON.stringify(v).slice(0, 60);
}

/** «поле: было → стало» по каждому изменившемуся ключу; служебные id прячем. */
function Changes({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])).filter(
    (k) => !/(^|_)id$/.test(k) && JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]),
  );
  if (!keys.length) return <span className="muted">—</span>;
  return (
    <div style={{ fontSize: 12, lineHeight: 1.5 }}>
      {keys.slice(0, 8).map((k) => (
        <div key={k}>
          <span className="muted">{k}:</span> {before ? `${show(before[k])} → ` : ''}
          <b>{show(after?.[k])}</b>
        </div>
      ))}
      {keys.length > 8 && <div className="muted">…ещё {keys.length - 8}</div>}
    </div>
  );
}

export function LogTable({ rows }: { rows: LogEntry[] }) {
  if (!rows.length) return <Empty />;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Когда</th>
            <th>Кто</th>
            <th>Что</th>
            <th>Было → стало</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td>{dt(e.created_at)}</td>
              <td>{ACTOR[e.actor_type] ?? e.actor_type}</td>
              <td>
                {e.entity} · {e.action}
              </td>
              <td>
                <Changes before={e.before} after={e.after} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
