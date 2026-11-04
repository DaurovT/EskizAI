'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Empty, Loading, Tag } from '@/components/admin/ui';
import { NS_STATUSES, nsColor, type NsRow } from '@/app/admin/nonstandard/shared';
import { dt, sum } from '@/lib/admin/format';
import { itemsOf, qs } from '@/lib/staff/client';
import { useApi } from '@/lib/staff/hooks';

type Row = NsRow & { assignee_name?: string | null; assignee_id?: string | null; term_days?: number | null };

export default function VendorNonstandard() {
  const router = useRouter();
  const [status, setStatus] = useState('sent');
  const { data, error, loading } = useApi<Row[] | { items: Row[] }>(`/vendor/nonstandard${qs({ status })}`);
  const rows = itemsOf(data);
  return (
    <>
      <h1>Нестандарт</h1>
      <p className="muted">Заявки мастеров на изделия, которых нет в модулях: оцените цену и срок, возьмите в работу, приложите доработанные файлы.</p>
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Все</option>
          {NS_STATUSES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (rows.length === 0 ? (
          <Empty>Заявок нет</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>№</th>
                  <th>Проект</th>
                  <th>Цех</th>
                  <th>Что нужно</th>
                  <th>Статус</th>
                  <th>Конструктор</th>
                  <th className="num">Цена</th>
                  <th>Создана</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => router.push(`/vendor/nonstandard/${r.id}`)}>
                    <td>{r.number ?? '—'}</td>
                    <td>{r.project_title ?? '—'}</td>
                    <td>{r.workshop_name ?? '—'}</td>
                    <td style={{ maxWidth: 320 }}>{r.description.length > 120 ? `${r.description.slice(0, 120)}…` : r.description}</td>
                    <td>
                      <Tag color={nsColor(r.status)}>{r.status_label}</Tag>
                    </td>
                    <td>{r.assignee_name ?? r.assignee ?? '—'}</td>
                    <td className="num">{sum(r.price)}</td>
                    <td>{dt(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </>
  );
}
