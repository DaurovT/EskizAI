'use client';

/** Прайс поставщика (§5.1 vendor.prices): поиск, ручная правка цены и наличия, загрузка прайса файлом с предпросмотром. */
import { useEffect, useState } from 'react';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { dt, ITEM_TYPES, ITEM_TYPE_LABEL, sum } from '@/lib/admin/format';
import { qs } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';
import { parseNum } from '@/lib/vendor/format';

interface Item {
  id: string;
  sku: string | null;
  type: string;
  name: string;
  price: number | null;
  unit: string;
  available: boolean;
  price_date?: string | null;
  price_stale?: boolean;
  decor?: string | null;
  thickness_mm?: number | null;
}

interface Page {
  items: Item[];
  total?: number;
  page?: number;
  pages?: number;
  limit?: number;
  page_size?: number;
}

function ItemRow({ it, onSaved }: { it: Item; onSaved: (it: Item) => void }) {
  const client = useClient();
  const act = useAction();
  const [price, setPrice] = useState(it.price != null ? String(it.price) : '');
  // Цена пришла с сервера (загрузка прайса, другая вкладка) — поле следует за ней
  useEffect(() => setPrice(it.price != null ? String(it.price) : ''), [it.price]);
  const p = parseNum(price);
  const dirty = p !== it.price && price !== '';
  const change = it.price && p ? Math.round(((p - it.price) / it.price) * 100) : null;

  const patch = (body: Partial<Item>, ok: string) =>
    act.run(async () => {
      const r = await client.patch<Item | undefined>(`/vendor/catalog/${it.id}`, body);
      onSaved({ ...it, ...body, ...(r ?? {}) });
    }, ok);

  return (
    <tr className={it.available ? '' : 'inactive'}>
      <td>{it.sku ?? '—'}</td>
      <td>
        {it.name}
        <div className="muted">
          {ITEM_TYPE_LABEL[it.type] ?? it.type}
          {it.price_date ? ` · цена от ${dt(it.price_date, false)}` : ''} {it.price_stale && <Tag color="yellow">устарела</Tag>}
        </div>
      </td>
      <td className="num edit-cell">
        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
          <input
            inputMode="numeric"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && dirty && p && p > 0) void patch({ price: Math.round(p) }, 'Цена сохранена');
            }}
          />
          {dirty && (
            <button type="button" className="b primary" disabled={act.busy || !p || p <= 0} onClick={() => void patch({ price: Math.round(p ?? 0) }, 'Цена сохранена')}>
              ✓
            </button>
          )}
        </div>
        <div className="muted">
          за {it.unit}
          {dirty && change !== null && <span className={Math.abs(change) > 15 ? 'big-change' : ''}> · {change > 0 ? '+' : ''}{change}%</span>}
        </div>
      </td>
      <td>
        <label className="chk">
          <input
            type="checkbox"
            checked={it.available}
            disabled={act.busy}
            onChange={(e) => void patch({ available: e.target.checked }, e.target.checked ? 'В наличии' : 'Нет в наличии')}
          />
          в наличии
        </label>
        {act.message?.kind === 'error' && <Msg message={act.message} />}
      </td>
    </tr>
  );
}

interface PreviewRow {
  sku?: string | null;
  name?: string | null;
  old_price?: number | null;
  new_price?: number | null;
  price?: number | null;
  change_percent?: number | null;
  change_pct?: number | null;
  available?: boolean | null;
  old_available?: boolean | null;
  error?: string | null;
}

interface Preview {
  preview_id: string;
  created: PreviewRow[] | number;
  changed: PreviewRow[] | number;
  missing: PreviewRow[] | number;
  big_changes: PreviewRow[] | number;
  errors?: (string | { row?: number; message?: string; sku?: string | null; name?: string | null; error?: string | null })[];
  unchanged?: number;
  expires_at?: string | null;
  total?: number;
}

function count(v: PreviewRow[] | number | undefined): number {
  return Array.isArray(v) ? v.length : (v ?? 0);
}

function pct(r: PreviewRow): number | null {
  if (r.change_pct != null) return r.change_pct;
  if (r.change_percent != null) return r.change_percent;
  if (r.old_price && r.new_price) return ((r.new_price - r.old_price) / r.old_price) * 100;
  return null;
}

function PreviewTable({
  rows,
  title,
  kind,
  missing = false,
}: {
  rows: PreviewRow[] | number;
  title: string;
  kind: 'new' | 'warn' | 'bad' | '';
  missing?: boolean;
}) {
  if (!Array.isArray(rows)) return null;
  if (!rows.length) return null;
  return (
    <details open={kind === 'bad'} style={{ marginBottom: 8 }}>
      <summary>
        {title}: {rows.length}
      </summary>
      <div className="scroll" style={{ maxHeight: 360, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Артикул</th>
              <th>Название</th>
              <th className="num">Было</th>
              <th className="num">Стало</th>
              <th className="num">Изм.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const c = pct(r);
              return (
                <tr key={`${r.sku ?? ''}-${i}`} className={kind}>
                  <td>{r.sku ?? '—'}</td>
                  <td>{r.name ?? '—'}</td>
                  <td className="num">{sum(missing ? r.price : r.old_price)}</td>
                  <td className="num">{missing ? '—' : sum(r.new_price ?? r.price)}</td>
                  <td className={`num ${c !== null && Math.abs(c) > 15 ? 'big-change' : ''}`}>
                    {c === null ? '—' : `${c > 0 ? '+' : ''}${c.toFixed(1)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Import({ onConfirmed }: { onConfirmed: () => void }) {
  const client = useClient();
  const act = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [hideMissing, setHideMissing] = useState(false);

  return (
    <Box title="Загрузить прайс файлом">
      <p className="muted">
        CSV или XLSX с колонками <code>sku;name;price;available</code>. Сначала — предпросмотр: новые позиции, изменённые цены,
        позиции, которых нет в файле, и изменения больше 15% (отдельно). Цены применяются только после подтверждения.
      </p>
      <div className="toolbar">
        <input
          type="file"
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
          }}
        />
        <label className="chk">
          <input type="checkbox" checked={hideMissing} onChange={(e) => setHideMissing(e.target.checked)} /> позиции, которых нет в
          файле, — «нет в наличии»
        </label>
        <button
          type="button"
          className="b"
          disabled={!file || act.busy}
          onClick={() =>
            void act.run(async () => {
              if (file)
                setPreview(await client.upload<Preview>('/vendor/catalog/import', file, { hide_missing: String(hideMissing) }));
            })
          }
        >
          Предпросмотр
        </button>
      </div>
      <Msg message={act.message} />
      {preview && (
        <>
          <div className="counters">
            <div className="box">
              <div className="kpi">{count(preview.created)}</div>
              <div className="muted">новых позиций</div>
            </div>
            <div className="box">
              <div className="kpi">{count(preview.changed)}</div>
              <div className="muted">изменится цена</div>
            </div>
            <div className="box">
              <div className={`kpi ${count(preview.big_changes) ? 'warn' : ''}`}>{count(preview.big_changes)}</div>
              <div className="muted">изменений больше 15%</div>
            </div>
            <div className="box">
              <div className="kpi">{count(preview.missing)}</div>
              <div className="muted">нет в файле</div>
            </div>
            {preview.unchanged !== undefined && (
              <div className="box">
                <div className="kpi">{preview.unchanged}</div>
                <div className="muted">без изменений</div>
              </div>
            )}
          </div>
          <PreviewTable rows={preview.big_changes} title="Изменения больше 15% — проверьте" kind="bad" />
          <PreviewTable rows={preview.changed} title="Изменённые цены" kind="warn" />
          <PreviewTable rows={preview.created} title="Новые позиции" kind="new" />
          <PreviewTable
            rows={preview.missing}
            title={hideMissing ? 'Нет в файле — станут «нет в наличии»' : 'Нет в файле (останутся как есть)'}
            kind=""
            missing
          />
          {(preview.errors ?? []).length > 0 && (
            <div className="msg warn">
              Строки с ошибками ({preview.errors!.length}):{' '}
              {preview.errors!
                .slice(0, 10)
                .map((e) =>
                  typeof e === 'string' ? e : `${e.row ? `стр. ${e.row}` : (e.sku ?? e.name ?? '?')}: ${e.message ?? e.error ?? ''}`,
                )
                .join('; ')}
            </div>
          )}
          <div className="toolbar">
            <button
              type="button"
              className="b primary"
              disabled={act.busy}
              onClick={() => {
                const big = count(preview.big_changes);
                if (big && !window.confirm(`В файле ${big} изменений цены больше 15%. Применить все?`)) return;
                void act
                  .run(() => client.post(`/vendor/catalog/import/${preview.preview_id}/confirm`), 'Прайс применён')
                  .then((ok) => {
                    if (ok) {
                      setPreview(null);
                      setFile(null);
                      onConfirmed();
                    }
                  });
              }}
            >
              Применить цены
            </button>
            <button type="button" className="b" onClick={() => setPreview(null)}>
              Отмена
            </button>
          </div>
        </>
      )}
    </Box>
  );
}

export default function VendorCatalog() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, loading, reload, setData } = useApi<Page | Item[]>(`/vendor/catalog${qs({ q: query, type, page })}`);
  const rows = Array.isArray(data) ? data : (data?.items ?? []);
  const meta = Array.isArray(data) ? null : data;
  const pages = meta?.pages ?? (meta?.total !== undefined ? Math.max(1, Math.ceil(meta.total / (meta.page_size ?? meta.limit ?? 100))) : 1);

  const saved = (it: Item) =>
    setData((d) => (d ? (Array.isArray(d) ? d.map((x) => (x.id === it.id ? it : x)) : { ...d, items: d.items.map((x) => (x.id === it.id ? it : x)) }) : d));

  return (
    <>
      <h1>Прайс</h1>
      <Import onConfirmed={reload} />
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(q);
        }}
      >
        <input placeholder="Артикул или название" value={q} onChange={(e) => setQ(e.target.value)} />
        <select
          value={type}
          onChange={(e) => {
            setPage(1);
            setType(e.target.value);
          }}
        >
          <option value="">Все типы</option>
          {ITEM_TYPES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button className="b" type="submit">
          Найти
        </button>
      </form>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (rows.length === 0 ? (
          <Empty>Позиций нет</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Артикул</th>
                  <th>Позиция</th>
                  <th className="num">Цена, сум</th>
                  <th>Наличие</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((it) => (
                  <ItemRow key={it.id} it={it} onSaved={saved} />
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {pages > 1 && (
        <div className="pager">
          <button className="b" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ←
          </button>
          <span className="muted">
            стр. {page} из {pages}
            {meta?.total !== undefined ? ` · всего ${meta.total}` : ''}
          </span>
          <button className="b" type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            →
          </button>
        </div>
      )}
    </>
  );
}
