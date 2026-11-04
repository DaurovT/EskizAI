'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Loading, Pager, Tag } from '@/components/admin/ui';
import { qs } from '@/lib/admin/api';
import { dt } from '@/lib/admin/format';
import { useApi } from '@/lib/admin/useApi';

interface Row {
  id: string;
  name: string;
  city: string;
  phone: string | null;
  owner_name: string | null;
  plan: string;
  blocked: boolean;
  free_left: number;
  free_limit: number;
  pack_left: number;
  unlimited: boolean;
  projects: number;
  orders: number;
  created_at: string;
}

const LIMIT = 50;

export default function WorkshopsPage() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi<{ items: Row[]; total: number }>(
    `/admin/workshops${qs({ q: query, limit: LIMIT, offset })}`,
  );
  return (
    <>
      <h1>Цеха и мастера</h1>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setQuery(q);
        }}
      >
        <input placeholder="Название или телефон" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="b" type="submit">
          Найти
        </button>
      </form>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Цех</th>
                <th>Телефон</th>
                <th>Тариф</th>
                <th>Лимит</th>
                <th className="num">Проекты</th>
                <th className="num">Заказы</th>
                <th>С нами с</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((w) => (
                <tr key={w.id} className="clickable" onClick={() => router.push(`/admin/workshops/${w.id}`)}>
                  <td>
                    {w.name} {w.blocked && <Tag color="red">заблокирован</Tag>}
                    <div className="muted">
                      {w.owner_name || '—'} · {w.city}
                    </div>
                  </td>
                  <td>{w.phone ?? '—'}</td>
                  <td>{w.plan}</td>
                  <td>
                    {w.unlimited ? 'без лимита' : `${w.free_left} из ${w.free_limit}`}
                    {w.pack_left > 0 && <span className="muted"> + пакет {w.pack_left}</span>}
                  </td>
                  <td className="num">{w.projects}</td>
                  <td className="num">{w.orders}</td>
                  <td>{dt(w.created_at, false)}</td>
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
