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
              <td>
                {e.actor_type}
                {e.actor_id ? ` (${e.actor_id.slice(0, 8)})` : ''}
              </td>
              <td>
                {e.entity} · {e.action}
              </td>
              <td>
                <code style={{ fontSize: 12 }}>
                  {e.before ? JSON.stringify(e.before) : '—'} → {e.after ? JSON.stringify(e.after) : '—'}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
