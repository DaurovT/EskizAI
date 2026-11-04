'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Loading, Pager, Tag } from '@/components/admin/ui';
import { qs } from '@/lib/admin/api';
import { dt, PROJECT_STATUSES } from '@/lib/admin/format';
import { useApi } from '@/lib/admin/useApi';

interface Row {
  id: string;
  title: string;
  status: string;
  status_label: string;
  product_type: string | null;
  is_example: boolean;
  workshop_id: string;
  workshop_name?: string;
  client_name?: string;
  charged: boolean;
  archived: boolean;
  updated_at: string;
}

const LIMIT = 50;

function Projects() {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [type, setType] = useState('');
  const [offset, setOffset] = useState(0);
  const workshopId = params.get('workshop_id');
  const { data, error, loading } = useApi<{ items: Row[]; total: number }>(
    `/admin/projects${qs({ q: query, status, product_type: type, workshop_id: workshopId, limit: LIMIT, offset })}`,
  );
  return (
    <>
      <h1>Проекты</h1>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setQuery(q);
        }}
      >
        <input placeholder="Проект, клиент или цех" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => (setOffset(0), setStatus(e.target.value))}>
          <option value="">Все статусы</option>
          {PROJECT_STATUSES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={type} onChange={(e) => (setOffset(0), setType(e.target.value))}>
          <option value="">Любой тип</option>
          <option value="wardrobe">Шкаф</option>
          <option value="kitchen">Кухня</option>
        </select>
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
                <th>Проект</th>
                <th>Цех</th>
                <th>Клиент</th>
                <th>Статус</th>
                <th>Тип</th>
                <th>Изменён</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => router.push(`/admin/projects/${p.id}`)}>
                  <td>
                    {p.title} {p.is_example && <Tag>пример</Tag>} {p.archived && <Tag>архив</Tag>}
                  </td>
                  <td>{p.workshop_name ?? '—'}</td>
                  <td>{p.client_name ?? '—'}</td>
                  <td>{p.status_label}</td>
                  <td>{p.product_type ?? '—'}</td>
                  <td>{dt(p.updated_at)}</td>
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

export default function ProjectsPage() {
  return (
    <Suspense fallback={<div className="muted">Загрузка…</div>}>
      <Projects />
    </Suspense>
  );
}
