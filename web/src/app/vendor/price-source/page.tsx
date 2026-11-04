'use client';

/**
 * Источник цен (§5.1, supplier_price_sources): обновление по ссылке на файл (CSV/XLSX/JSON) или по API
 * поставщика с ключом, по расписанию; «обновить сейчас»; журнал запусков; изменения > 15% ждут подтверждения.
 * Ключ хранится на сервере и не отдаётся — только «задан».
 */
import { Fragment, useEffect, useState } from 'react';
import { Box, Empty, Loading, Msg } from '@/components/admin/ui';
import { RunStatus, type Run } from '@/components/admin/RunStatus';
import { dt, sum } from '@/lib/admin/format';
import { itemsOf } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';

interface Source {
  kind?: 'file_url' | 'api';
  url?: string | null;
  format?: string | null;
  mapping?: Record<string, string> | null;
  schedule?: string | null;
  active?: boolean;
  secret_set?: boolean;
  has_secret?: boolean;
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
}

interface BigChange {
  record_id: string;
  sku: string | null;
  name: string | null;
  price: number | null;
  old_price: number | null;
  change_pct: number | null;
}

type SourceRun = Omit<Run, 'supplier' | 'full_snapshot' | 'created_by' | 'finished_at'> & {
  pending_review?: number;
  big_changes?: BigChange[] | number;
};

const SCHEDULES: [string, string][] = [
  ['daily', 'Раз в день'],
  ['hourly', 'Каждый час'],
  ['off', 'Только вручную'],
];

const MAP_FIELDS: [string, string][] = [
  ['sku', 'Артикул'],
  ['name', 'Название'],
  ['price', 'Цена'],
  ['available', 'Наличие'],
];

export default function PriceSource() {
  const client = useClient();
  const srcRaw = useApi<{ source: Source | null } | Source | null>('/vendor/price-source');
  const src = {
    ...srcRaw,
    data: srcRaw.data ? ('source' in srcRaw.data ? srcRaw.data.source : (srcRaw.data as Source)) : srcRaw.data,
  };
  const runs = useApi<SourceRun[] | { items: SourceRun[] }>('/vendor/price-source/runs');
  const act = useAction();
  const [form, setForm] = useState<Source>({ kind: 'file_url', format: 'csv', schedule: 'daily', active: true, mapping: {} });
  const [open, setOpen] = useState<string | null>(null);
  const [secret, setSecret] = useState('');

  useEffect(() => {
    if (src.data) setForm({ kind: 'file_url', format: 'csv', schedule: 'daily', active: true, ...src.data, mapping: src.data.mapping ?? {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcRaw.data]);

  const set = (patch: Partial<Source>) => setForm((f) => ({ ...f, ...patch }));
  const secretSet = Boolean(src.data?.secret_set ?? src.data?.has_secret);
  const httpsOk = !form.url || /^https:\/\//i.test(form.url);
  const runList = itemsOf(runs.data);

  return (
    <>
      <h1>Источник цен</h1>
      <Loading error={src.error} loading={src.loading && !src.data} />
      <Box title="Подключение">
        <div className="form-grid">
          <label>
            Тип
            <select value={form.kind} onChange={(e) => set({ kind: e.target.value as Source['kind'] })}>
              <option value="file_url">Ссылка на файл</option>
              <option value="api">API поставщика</option>
            </select>
          </label>
          <label>
            Формат
            <select value={form.format ?? 'csv'} onChange={(e) => set({ format: e.target.value })}>
              <option value="csv">CSV</option>
              <option value="xlsx">XLSX</option>
              <option value="json">JSON</option>
            </select>
          </label>
          <label>
            Расписание
            <select value={form.schedule ?? 'daily'} onChange={(e) => set({ schedule: e.target.value })}>
              {SCHEDULES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="chk" style={{ flexDirection: 'row' }}>
            <input type="checkbox" checked={form.active ?? true} onChange={(e) => set({ active: e.target.checked })} /> включён
          </label>
        </div>
        <label className="f">
          {form.kind === 'api' ? 'Адрес API (https://…)' : 'Ссылка на файл (https://…)'}
          <input value={form.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://" />
        </label>
        {!httpsOk && <div className="msg warn">Только https и публичные адреса.</div>}
        <label className="f" style={{ marginTop: 8 }}>
          Ключ доступа {secretSet ? '(задан — оставьте пустым, чтобы не менять)' : '(если нужен)'}
          <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </label>
        <h3>Сопоставление колонок</h3>
        <div className="form-grid">
          {MAP_FIELDS.map(([k, l]) => (
            <label key={k}>
              {l}
              <input
                placeholder={k}
                value={form.mapping?.[k] ?? ''}
                onChange={(e) => set({ mapping: { ...(form.mapping ?? {}), [k]: e.target.value } })}
              />
            </label>
          ))}
        </div>
        <Msg message={act.message} />
        <div className="toolbar">
          <button
            type="button"
            className="b primary"
            disabled={act.busy || !form.url || !httpsOk}
            onClick={() =>
              void act
                .run(
                  () =>
                    client.put('/vendor/price-source', {
                      kind: form.kind,
                      url: form.url,
                      format: form.format,
                      schedule: form.schedule,
                      active: form.active,
                      mapping: Object.fromEntries(Object.entries(form.mapping ?? {}).filter(([, v]) => v)),
                      ...(secret ? { secret } : {}),
                    }),
                  'Источник сохранён',
                )
                .then((ok) => {
                  if (ok) {
                    setSecret('');
                    src.reload();
                  }
                })
            }
          >
            Сохранить
          </button>
          <button
            type="button"
            className="b"
            disabled={act.busy || !src.data?.url}
            onClick={() => void act.run(() => client.post('/vendor/price-source/run'), 'Обновление запущено').then(() => runs.reload())}
          >
            Обновить сейчас
          </button>
          {src.data?.last_run_at && <span className="muted">последний запуск {dt(src.data.last_run_at)}</span>}
          {src.data?.last_status && <span className="muted">· {src.data.last_status}</span>}
        </div>
        {src.data?.last_error && <div className="msg error">Последняя ошибка: {src.data.last_error}</div>}
        {secretSet && (
          <button
            type="button"
            className="b danger"
            disabled={act.busy}
            onClick={() => {
              if (!window.confirm('Удалить ключ доступа источника?')) return;
              void act
                .run(
                  () =>
                    client.put('/vendor/price-source', {
                      kind: form.kind,
                      url: form.url,
                      format: form.format,
                      schedule: form.schedule,
                      active: form.active,
                      mapping: Object.fromEntries(Object.entries(form.mapping ?? {}).filter(([, v]) => v)),
                      secret: '',
                    }),
                  'Ключ удалён',
                )
                .then(() => srcRaw.reload());
            }}
          >
            Удалить ключ
          </button>
        )}
        <p className="muted">Изменения цены больше 15% ждут вашего подтверждения в журнале ниже, остальные применяются сразу.</p>
      </Box>
      <Box title="Журнал запусков" extra={<button type="button" className="b" onClick={runs.reload}>Обновить</button>}>
        <Loading error={runs.error} loading={runs.loading && !runs.data} />
        {runs.data &&
          (runList.length === 0 ? (
            <Empty>Запусков ещё не было</Empty>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Начат</th>
                    <th>Откуда</th>
                    <th>Статус</th>
                    <th className="num">Всего</th>
                    <th className="num">Новых</th>
                    <th className="num">Изменено</th>
                    <th className="num">&gt;15%</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {runList.map((r) => {
                    const bigList = Array.isArray(r.big_changes) ? r.big_changes : [];
                    const big = r.pending_review ?? (Array.isArray(r.big_changes) ? r.big_changes.length : (r.big_changes ?? 0));
                    const needs = big > 0 && r.source === 'price_source';
                    return (
                      <Fragment key={r.id}>
                        <tr className={needs ? 'warn' : ''}>
                          <td>{dt(r.started_at)}</td>
                          <td>
                            {r.source === 'vendor_file' ? 'файл' : 'источник'}
                            {r.file_name && <div className="muted">{r.file_name}</div>}
                          </td>
                          <td>
                            <RunStatus status={r.status} />
                            {r.error && <div className="muted">{r.error}</div>}
                          </td>
                          <td className="num">{r.stats?.total ?? '—'}</td>
                          <td className="num">{r.stats?.new ?? '—'}</td>
                          <td className="num">{r.stats?.changed ?? '—'}</td>
                          <td className={`num ${big ? 'big-change' : ''}`}>
                            {bigList.length > 0 ? (
                              <button type="button" className="b" onClick={() => setOpen(open === r.id ? null : r.id)}>
                                {big}
                              </button>
                            ) : (
                              big
                            )}
                          </td>
                          <td>
                            {needs && (
                              <button
                                type="button"
                                className="b primary"
                                disabled={act.busy}
                                onClick={() => {
                                  if (!window.confirm(`Применить ${big} изменений цены больше 15%?`)) return;
                                  void act
                                    .run(() => client.post(`/vendor/price-source/runs/${r.id}/confirm`), 'Изменения применены')
                                    .then(() => runs.reload());
                                }}
                              >
                                Подтвердить &gt;15%
                              </button>
                            )}
                          </td>
                        </tr>
                        {open === r.id && (
                          <tr>
                            <td colSpan={8}>
                              <table>
                                <tbody>
                                  {bigList.map((b) => (
                                    <tr key={b.record_id}>
                                      <td>{b.sku ?? '—'}</td>
                                      <td>{b.name ?? '—'}</td>
                                      <td className="num">
                                        <span className="diff-old">{sum(b.old_price)}</span>
                                        {sum(b.price)}
                                      </td>
                                      <td className="num big-change">
                                        {b.change_pct == null ? '—' : `${b.change_pct > 0 ? '+' : ''}${b.change_pct.toFixed(1)}%`}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
      </Box>
    </>
  );
}
