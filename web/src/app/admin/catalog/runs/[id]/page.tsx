'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { RunStatus, type Run } from '@/components/admin/RunStatus';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { post } from '@/lib/admin/api';
import { dt, MATCH_LABEL, REVIEW_LABEL, sum } from '@/lib/admin/format';
import { useAction, useApi } from '@/lib/admin/useApi';

interface RawRecord {
  id: string;
  sku: string | null;
  name: string;
  price: number | null;
  parsed: Record<string, unknown>;
  data: Record<string, unknown>;
  matched_item_id: string | null;
  matched_item_name: string | null;
  match_status: string;
  old_price: number | null;
  change_pct: number | null;
  review_status: string;
  reviewed_by: string | null;
  published_at: string | null;
  error: string | null;
}
interface RunCard extends Run {
  records: RawRecord[];
  missing: { id: string; sku: string; name: string; price: number; price_date: string }[];
}

const FILTERS: [string, string][] = [
  ['', 'Все'],
  ['new', 'Новые'],
  ['changed', 'Изменены'],
  ['unchanged', 'Без изменений'],
  ['invalid', 'Ошибки'],
];

function pct(v: number | null): string {
  if (v === null) return '—';
  return `${v > 0 ? '+' : ''}${v}%`;
}

export default function RunCardPage() {
  const { id } = useParams<{ id: string }>();
  const [filter, setFilter] = useState('');
  const { data: r, error, loading, reload } = useApi<RunCard>(
    `/admin/catalog/parser-runs/${id}${filter ? `?match_status=${filter}` : ''}`,
  );
  const act = useAction();

  if (!r) return <Loading error={error} loading={loading} />;
  const pending = r.records.filter((x) => x.review_status === 'pending' && !x.published_at).length;

  return (
    <>
      <h1>
        Запуск парсера от {dt(r.started_at)} <RunStatus status={r.status} />
      </h1>
      <Msg message={act.message} />
      {r.error && <div className="msg error">{r.error}</div>}
      <Box title="Итог">
        <dl className="kv">
          <dt>Источник</dt>
          <dd>
            {r.source === 'csv' ? 'CSV-файл' : 'страница eman.uz'} · {r.file_name ?? '—'} · {r.supplier}
          </dd>
          <dt>Полный прайс</dt>
          <dd>{r.full_snapshot ? 'да' : 'нет'}</dd>
          <dt>Записей</dt>
          <dd>
            всего {r.stats.total ?? 0}: новых {r.stats.new ?? 0}, изменённых {r.stats.changed ?? 0} (из них &gt;15% — {r.stats.review ?? 0}),
            без изменений {r.stats.unchanged ?? 0}, с ошибкой {r.stats.invalid ?? 0}, исчезли {r.stats.missing ?? 0}
          </dd>
          {r.stats.published && (
            <>
              <dt>Опубликовано</dt>
              <dd>
                создано {r.stats.published.created ?? 0}, обновлено {r.stats.published.updated ?? 0}, подтверждено{' '}
                {r.stats.published.confirmed ?? 0}, скрыто {r.stats.published.hidden ?? 0}
                {r.published_at ? ` · ${dt(r.published_at)}` : ''}
              </dd>
            </>
          )}
        </dl>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button
            className="b"
            type="button"
            disabled={act.busy || r.status === 'published' || r.status === 'failed'}
            onClick={() => void act.run(() => post(`/admin/catalog/parser-runs/${id}/match`), 'Сопоставление обновлено').then(reload)}
          >
            Повторить сопоставление
          </button>
          <button
            className="b primary"
            type="button"
            disabled={act.busy || r.status === 'failed'}
            onClick={() => void act.run(() => post(`/admin/catalog/parser-runs/${id}/publish`, { skip_pending: false }), 'Опубликовано').then(reload)}
          >
            Опубликовать
          </button>
          {pending > 0 && (
            <button
              className="b"
              type="button"
              disabled={act.busy}
              onClick={() =>
                void act
                  .run(() => post(`/admin/catalog/parser-runs/${id}/publish`, { skip_pending: true }), 'Опубликовано без непроверенных')
                  .then(reload)
              }
            >
              Опубликовать без {pending} непроверенных
            </button>
          )}
        </div>
      </Box>

      <Box
        title="Сырые записи"
        extra={
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {FILTERS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        }
      >
        {r.records.length === 0 ? (
          <Empty />
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Артикул</th>
                  <th>Наименование</th>
                  <th>Сопоставлено с</th>
                  <th className="num">Было</th>
                  <th className="num">Стало</th>
                  <th className="num">Δ</th>
                  <th>Статус</th>
                  <th>Проверка</th>
                </tr>
              </thead>
              <tbody>
                {r.records.map((x) => (
                  <tr key={x.id}>
                    <td>{x.sku ?? '—'}</td>
                    <td>
                      {x.name || <span className="muted">—</span>}
                      {x.error && <div style={{ color: '#b42318' }}>{x.error}</div>}
                    </td>
                    <td>{x.matched_item_name ?? '—'}</td>
                    <td className="num">{sum(x.old_price)}</td>
                    <td className="num">{sum(x.price)}</td>
                    <td className="num">
                      {x.change_pct !== null && Math.abs(x.change_pct) > 15 ? <Tag color="red">{pct(x.change_pct)}</Tag> : pct(x.change_pct)}
                    </td>
                    <td>
                      {MATCH_LABEL[x.match_status] ?? x.match_status}
                      {x.published_at && <div className="muted">опубл. {dt(x.published_at)}</div>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {x.review_status === 'pending' && !x.published_at ? (
                        <>
                          <button
                            className="b primary"
                            type="button"
                            disabled={act.busy}
                            onClick={() => void act.run(() => post(`/admin/catalog/raw-records/${x.id}/review`, { action: 'approve' })).then(reload)}
                          >
                            Подтвердить
                          </button>{' '}
                          <button
                            className="b danger"
                            type="button"
                            disabled={act.busy}
                            onClick={() => void act.run(() => post(`/admin/catalog/raw-records/${x.id}/review`, { action: 'reject' })).then(reload)}
                          >
                            Отклонить
                          </button>
                        </>
                      ) : (
                        <span className="muted">{REVIEW_LABEL[x.review_status] ?? x.review_status}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Box>

      <Box title={`Исчезли из прайса (${r.missing.length})`}>
        {r.missing.length === 0 ? (
          <Empty />
        ) : (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              При публикации будут помечены «нет в наличии»; в смете — «аналог» или «под запрос».
            </p>
            <table>
              <tbody>
                {r.missing.map((m) => (
                  <tr key={m.id}>
                    <td>{m.sku}</td>
                    <td>{m.name}</td>
                    <td className="num">{sum(m.price)}</td>
                    <td>{dt(m.price_date, false)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Box>
    </>
  );
}
