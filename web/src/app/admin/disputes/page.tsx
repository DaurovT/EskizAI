'use client';

/** Очередь споров (§4a): мастер не согласен с решением поставщика по возврату или с отклонением заказа. */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Empty, Loading, Pager, Tag } from '@/components/admin/ui';
import { dt, sum } from '@/lib/admin/format';
import { itemsOf, qs } from '@/lib/staff/client';
import { useApi } from '@/lib/staff/hooks';
import { DECISION_LABEL, SUBJECT_LABEL, type DisputeRow } from './shared';

const LIMIT = 50;

export default function DisputesPage() {
  const router = useRouter();
  const [status, setStatus] = useState('open');
  // API отдаёт до 500 споров без постраничности — листаем на клиенте
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi<{ items: DisputeRow[] }>(`/admin/disputes${qs({ status })}`);
  const all = itemsOf(data);
  const rows = all.slice(offset, offset + LIMIT);
  const total = all.length;
  return (
    <>
      <h1>Споры</h1>
      <div className="toolbar">
        <select
          value={status}
          onChange={(e) => {
            setOffset(0);
            setStatus(e.target.value);
          }}
        >
          <option value="open">Открытые</option>
          <option value="resolved">Решённые</option>
        </select>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (rows.length === 0 ? (
          <Empty>{status === 'open' ? 'Открытых споров нет' : 'Пусто'}</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Спор</th>
                  <th>Цех</th>
                  <th>Поставщик</th>
                  <th>Предмет</th>
                  <th className="num">Сумма</th>
                  <th>Статус</th>
                  <th>Открыт</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} className="clickable" onClick={() => router.push(`/admin/disputes/${d.id}`)}>
                    <td>
                      Заказ №{d.order_number ?? d.order_id.slice(0, 8)}
                      <div className="muted" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {d.reason}
                      </div>
                    </td>
                    <td>{d.workshop_name ?? '—'}</td>
                    <td>{d.supplier_name ?? '—'}</td>
                    <td>{SUBJECT_LABEL[d.subject] ?? d.subject}</td>
                    <td className="num">{sum(d.amount)}</td>
                    <td>
                      {d.status === 'open' ? (
                        <Tag color="yellow">открыт</Tag>
                      ) : (
                        <Tag color="green">{DECISION_LABEL[d.decision ?? ''] ?? 'решён'}</Tag>
                      )}
                    </td>
                    <td>{dt(d.created_at)}</td>
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
