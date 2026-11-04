'use client';

/** ADM-09: очередь заявок «нестандарт» (US-7, FR-34/56). */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Empty, Loading, Pager, Tag } from '@/components/admin/ui';
import { qs } from '@/lib/admin/api';
import { dt, sum } from '@/lib/admin/format';
import { useApi } from '@/lib/admin/useApi';
import { NS_STATUSES, nsColor, type NsRow } from './shared';

const LIMIT = 50;

export default function NonstandardQueue() {
  const router = useRouter();
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi<{ items: NsRow[]; total: number }>(
    `/admin/nonstandard${qs({ status: status ? [status] : [], limit: LIMIT, offset })}`,
  );
  return (
    <>
      <h1>Нестандарт</h1>
      <div className="toolbar">
        <select value={status} onChange={(e) => { setOffset(0); setStatus(e.target.value); }}>
          <option value="">Все статусы</option>
          {NS_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && data.items.length === 0 && <Empty>Заявок нет</Empty>}
      {data && data.items.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>№</th>
                <th>Проект</th>
                <th>Цех</th>
                <th>Описание</th>
                <th>Статус</th>
                <th>Конструктор</th>
                <th className="num">Цена</th>
                <th>Срок</th>
                <th>Создана</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => router.push(`/admin/nonstandard/${r.id}`)}>
                  <td>{r.number ?? '—'}</td>
                  <td>{r.project_title ?? '—'}</td>
                  <td>{r.workshop_name ?? '—'}</td>
                  <td>{r.description.length > 80 ? `${r.description.slice(0, 80)}…` : r.description}</td>
                  <td><Tag color={nsColor(r.status)}>{r.status_label}</Tag>{r.path === 'self' ? <span className="muted"> сам</span> : null}</td>
                  <td>{r.assignee ?? <span className="muted">не назначен</span>}</td>
                  <td className="num">{sum(r.price)}</td>
                  <td>{r.lead_days != null ? `${r.lead_days} дн.` : '—'}</td>
                  <td>{dt(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
        </div>
      )}
    </>
  );
}
