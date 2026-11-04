'use client';

import { Fragment, useState } from 'react';
import { Box, Loading, Msg, Pager, Tag } from '@/components/admin/ui';
import { api, patch, post, qs } from '@/lib/admin/api';
import { dt, ITEM_TYPE_LABEL, ITEM_TYPES, sum } from '@/lib/admin/format';
import { useAction, useApi } from '@/lib/admin/useApi';

interface Item {
  id: string;
  sku: string;
  type: string;
  name: string;
  core_key: string | null;
  decor: string | null;
  thickness_mm: number | null;
  price: number;
  unit: string;
  price_date: string;
  price_source: string;
  price_stale: boolean;
  available: boolean;
}
interface History {
  id: string;
  old_price: number | null;
  new_price: number;
  source: string;
  changed_by: string | null;
  created_at: string;
}

const LIMIT = 100;
const EMPTY_NEW = { sku: '', name: '', type: 'sheet', price: '', unit: 'лист', decor: '', thickness_mm: '', core_key: '' };

export default function CatalogPage() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [stale, setStale] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useApi<{ items: Item[]; total: number }>(
    `/admin/catalog/items${qs({ q: query, type, stale: stale || null, limit: LIMIT, offset })}`,
  );
  const act = useAction();
  const [editing, setEditing] = useState<{ id: string; price: string } | null>(null);
  const [history, setHistory] = useState<{ id: string; rows: History[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(EMPTY_NEW);

  async function savePrice() {
    if (!editing) return;
    const ok = await act.run(() => patch(`/admin/catalog/items/${editing.id}`, { price: Number(editing.price) }), 'Цена сохранена');
    if (ok) {
      setEditing(null);
      reload();
    }
  }

  return (
    <>
      <h1>Каталог</h1>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setQuery(q);
        }}
      >
        <input placeholder="Наименование, артикул, декор" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={type} onChange={(e) => (setOffset(0), setType(e.target.value))}>
          <option value="">Все типы</option>
          {ITEM_TYPES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={stale} onChange={(e) => (setOffset(0), setStale(e.target.value))}>
          <option value="">Любая дата цены</option>
          <option value="true">Цена устарела (&gt; 14 дней)</option>
          <option value="false">Свежие цены</option>
        </select>
        <button className="b" type="submit">
          Найти
        </button>
        <button className="b primary" type="button" onClick={() => setAdding(!adding)}>
          + Позиция
        </button>
      </form>
      <Msg message={act.message} />
      {adding && (
        <Box title="Новая позиция (вручную)">
          <div className="toolbar">
            <input placeholder="Артикул" value={draft.sku} onChange={(e) => setDraft({ ...draft, sku: e.target.value })} />
            <input placeholder="Наименование" style={{ minWidth: 260 }} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
              {ITEM_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input placeholder="Цена, сум" type="number" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
            <input placeholder="Ед." style={{ width: 70 }} value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />
            <input placeholder="Декор" value={draft.decor} onChange={(e) => setDraft({ ...draft, decor: e.target.value })} />
            <input placeholder="Толщина, мм" type="number" style={{ width: 110 }} value={draft.thickness_mm} onChange={(e) => setDraft({ ...draft, thickness_mm: e.target.value })} />
            <input placeholder="core_key (id в ядре)" value={draft.core_key} onChange={(e) => setDraft({ ...draft, core_key: e.target.value })} />
            <button
              className="b primary"
              type="button"
              disabled={act.busy || !draft.sku || !draft.name || !Number(draft.price)}
              onClick={async () => {
                const ok = await act.run(
                  () =>
                    post('/admin/catalog/items', {
                      sku: draft.sku,
                      name: draft.name,
                      type: draft.type,
                      price: Number(draft.price),
                      unit: draft.unit || 'шт',
                      decor: draft.decor || null,
                      thickness_mm: draft.thickness_mm ? Number(draft.thickness_mm) : null,
                      core_key: draft.core_key || null,
                    }),
                  'Позиция добавлена',
                );
                if (ok) {
                  setDraft(EMPTY_NEW);
                  setAdding(false);
                  reload();
                }
              }}
            >
              Сохранить
            </button>
          </div>
        </Box>
      )}
      <Loading error={error} loading={loading && !data} />
      {data && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Артикул</th>
                <th>Наименование</th>
                <th>Тип</th>
                <th className="num">Цена</th>
                <th>Дата и источник цены</th>
                <th>Наличие</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <Fragment key={i.id}>
                  <tr>
                    <td>{i.sku}</td>
                    <td>
                      {i.name}
                      <div className="muted">
                        {[i.decor, i.thickness_mm ? `${i.thickness_mm} мм` : null, i.core_key ? `ядро: ${i.core_key}` : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </td>
                    <td>{ITEM_TYPE_LABEL[i.type] ?? i.type}</td>
                    <td className="num">
                      {editing?.id === i.id ? (
                        <span style={{ display: 'inline-flex', gap: 4 }}>
                          <input
                            type="number"
                            value={editing.price}
                            style={{ width: 110 }}
                            autoFocus
                            onChange={(e) => setEditing({ id: i.id, price: e.target.value })}
                            onKeyDown={(e) => e.key === 'Enter' && void savePrice()}
                          />
                          <button className="b primary" type="button" disabled={act.busy || !Number(editing.price)} onClick={() => void savePrice()}>
                            ✓
                          </button>
                          <button className="b" type="button" onClick={() => setEditing(null)}>
                            ✕
                          </button>
                        </span>
                      ) : (
                        <>
                          {sum(i.price)} <span className="muted">/ {i.unit}</span>
                        </>
                      )}
                    </td>
                    <td>
                      {dt(i.price_date, false)} · {i.price_source} {i.price_stale && <Tag color="yellow">устарела</Tag>}
                    </td>
                    <td>
                      <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        <input
                          type="checkbox"
                          checked={i.available}
                          onChange={(e) =>
                            void act.run(() => patch(`/admin/catalog/items/${i.id}`, { available: e.target.checked }), 'Сохранено').then(reload)
                          }
                        />
                        {i.available ? 'есть' : 'нет'}
                      </label>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="b" type="button" onClick={() => setEditing({ id: i.id, price: String(i.price) })}>
                        Цена
                      </button>{' '}
                      <button
                        className="b"
                        type="button"
                        onClick={async () => {
                          if (history?.id === i.id) return setHistory(null);
                          await act.run(async () =>
                            setHistory({ id: i.id, rows: await api<History[]>(`/admin/catalog/items/${i.id}/history`) }),
                          );
                        }}
                      >
                        История
                      </button>
                    </td>
                  </tr>
                  {history?.id === i.id && (
                    <tr>
                      <td colSpan={7} style={{ background: '#fafbfb' }}>
                        {history.rows.length === 0
                          ? 'Нет истории'
                          : history.rows.map((h) => (
                              <div key={h.id}>
                                {dt(h.created_at)}: {h.old_price === null ? '—' : sum(h.old_price)} → {sum(h.new_price)}{' '}
                                <span className="muted">
                                  ({h.source}
                                  {h.changed_by ? `, ${h.changed_by}` : ''})
                                </span>
                              </div>
                            ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <Pager total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
        </div>
      )}
    </>
  );
}
