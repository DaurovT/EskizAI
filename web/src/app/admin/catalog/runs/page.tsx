'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RunStatus, type Run } from '@/components/admin/RunStatus';
import { Box, Loading, Msg } from '@/components/admin/ui';
import { api } from '@/lib/admin/api';
import { dt } from '@/lib/admin/format';
import { useAction, useApi } from '@/lib/admin/useApi';

export default function RunsPage() {
  const router = useRouter();
  const { data, error, loading, reload } = useApi<Run[]>('/admin/catalog/parser-runs');
  const act = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState('csv');
  const [supplier, setSupplier] = useState('eman');
  const [full, setFull] = useState(true);

  return (
    <>
      <h1>Парсер прайса</h1>
      <Box title="Новый запуск">
        <p className="muted" style={{ marginTop: 0 }}>
          Прайс файлом (CSV: Артикул; Наименование; Тип; Цена; Ед; Декор; Толщина; …) или сохранённая HTML-страница
          каталога eman.uz. Автоматическая загрузка с сайта не включена — парсер сайта ждёт адаптации к настоящей
          разметке после разрешения EMAN.
        </p>
        <div className="toolbar">
          <input type="file" accept=".csv,.txt,.html,.htm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="csv">CSV-файл</option>
            <option value="eman_html">Страница eman.uz (HTML)</option>
          </select>
          <input value={supplier} onChange={(e) => setSupplier(e.target.value)} style={{ width: 90 }} title="Код поставщика" />
          <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> полный прайс (чего нет — «исчезло»)
          </label>
          <button
            className="b primary"
            type="button"
            disabled={!file || act.busy}
            onClick={async () => {
              if (!file) return;
              const fd = new FormData();
              fd.append('file', file);
              fd.append('source', source);
              fd.append('supplier_code', supplier);
              fd.append('full_snapshot', String(full));
              let created: Run | null = null;
              const ok = await act.run(async () => {
                created = await api<Run>('/admin/catalog/parser-runs', { method: 'POST', body: fd });
              });
              if (ok && created) router.push(`/admin/catalog/runs/${(created as Run).id}`);
              else reload();
            }}
          >
            Разобрать и сопоставить
          </button>
        </div>
        <Msg message={act.message} />
      </Box>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <table>
          <thead>
            <tr>
              <th>Когда</th>
              <th>Источник</th>
              <th>Статус</th>
              <th className="num">Всего</th>
              <th className="num">Новые</th>
              <th className="num">Изменены</th>
              <th className="num">&gt;15%</th>
              <th className="num">Исчезли</th>
              <th className="num">Ошибки</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => router.push(`/admin/catalog/runs/${r.id}`)}>
                <td>{dt(r.started_at)}</td>
                <td>
                  {r.source === 'csv' ? 'CSV' : 'eman.uz'} · {r.file_name ?? '—'}
                  <div className="muted">{r.supplier}</div>
                </td>
                <td>
                  <RunStatus status={r.status} />
                  {r.error && <div className="muted">{r.error}</div>}
                </td>
                <td className="num">{r.stats.total ?? '—'}</td>
                <td className="num">{r.stats.new ?? '—'}</td>
                <td className="num">{r.stats.changed ?? '—'}</td>
                <td className="num">{r.stats.review ?? '—'}</td>
                <td className="num">{r.stats.missing ?? '—'}</td>
                <td className="num">{r.stats.invalid ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
