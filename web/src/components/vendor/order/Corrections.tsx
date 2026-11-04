'use client';

/**
 * Исправление заказа конструктором (§5.2): правка строк состава, исправленные файлы, комментарий.
 * Если сумма или состав изменились — мастер подтверждает в приложении (заказ ждёт в awaiting_approval).
 * POST /vendor/orders/{id}/corrections — multipart: lines_after (JSON), comment, files.
 */
import { useMemo, useState } from 'react';
import { Empty, Msg, Tag } from '@/components/admin/ui';
import { dt, sum } from '@/lib/admin/format';
import { useAction, useClient } from '@/lib/staff/hooks';
import { CORRECTION_STATUS_LABEL, parseNum } from '@/lib/vendor/format';
import type { Correction, Line, VOrder } from './types';

interface Draft {
  key: string;
  name: string;
  unit: string;
  qty: string;
  price: string;
  sku?: string | null;
  isNew?: boolean;
}

function toDraft(l: Line): Draft {
  return { key: l.key, name: l.name, unit: l.unit, qty: String(l.qty), price: String(l.price), sku: l.sku };
}

export function CorrectionsList({ items }: { items: Correction[] }) {
  const client = useClient();
  const act = useAction();
  if (!items.length) return <Empty>Исправлений не было</Empty>;
  return (
    <>
      <Msg message={act.message} />
      {items.map((c) => {
        const before = new Map((c.lines_before ?? []).map((l) => [l.key, l]));
        const after = c.lines_after ?? [];
        const removed = (c.lines_before ?? []).filter((l) => !after.some((a) => a.key === l.key));
        return (
          <div key={c.id} style={{ borderTop: '1px solid var(--a-line)', paddingTop: 8, marginTop: 8 }}>
            <div>
              <Tag color={c.status === 'approved' || c.status === 'applied' ? 'green' : c.status === 'declined' ? 'red' : 'yellow'}>
                {CORRECTION_STATUS_LABEL[c.status] ?? c.status}
              </Tag>{' '}
              {dt(c.created_at)} {c.author_name && <span className="muted">· {c.author_name}</span>}
              {c.total_before != null && c.total_after != null && (
                <span>
                  {' '}
                  · <span className="diff-old">{sum(c.total_before)}</span>
                  <b>{sum(c.total_after)}</b>
                </span>
              )}
            </div>
            {c.comment && <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>{c.comment}</p>}
            {(c.decision_comment ?? c.master_comment) && (
              <p className="muted" style={{ margin: '6px 0' }}>
                Мастер: {c.decision_comment ?? c.master_comment}
              </p>
            )}
            {(after.length > 0 || removed.length > 0) && (
              <div className="scroll">
                <table>
                  <tbody>
                    {after
                      .filter((l) => {
                        const b = before.get(l.key);
                        return !b || b.qty !== l.qty || b.price !== l.price || b.name !== l.name;
                      })
                      .map((l) => {
                        const b = before.get(l.key);
                        return (
                          <tr key={l.key} className={b ? 'warn' : 'new'}>
                            <td>
                              {b && b.name !== l.name && <span className="diff-old">{b.name}</span>}
                              {l.name}
                            </td>
                            <td className="num">
                              {b && b.qty !== l.qty && <span className="diff-old">{b.qty}</span>}
                              {l.qty} {l.unit}
                            </td>
                            <td className="num">
                              {b && b.price !== l.price && <span className="diff-old">{sum(b.price)}</span>}
                              {sum(l.price)}
                            </td>
                          </tr>
                        );
                      })}
                    {removed.map((l) => (
                      <tr key={l.key} className="bad">
                        <td>
                          <span className="diff-old">{l.name}</span> удалена
                        </td>
                        <td className="num">{l.qty}</td>
                        <td className="num">{sum(l.price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(c.files ?? []).length > 0 && (
              <div className="toolbar" style={{ marginTop: 6 }}>
                {(c.files ?? []).map((f, i) => (
                  <button
                    key={f.id ?? i}
                    type="button"
                    className="b"
                    disabled={!f.url}
                    onClick={() => f.url && void act.run(() => client.download(f.url!, f.name ?? 'file'))}
                  >
                    📎 {f.name ?? 'файл'}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export function CorrectionEditor({ o, onDone, onCancel }: { o: VOrder; onDone: () => void; onCancel: () => void }) {
  const client = useClient();
  const act = useAction();
  const [rows, setRows] = useState<Draft[]>(() => (o.lines ?? []).map(toDraft));
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const before = useMemo(() => (o.lines ?? []).reduce((s, l) => s + l.total, 0), [o.lines]);
  const parsed = rows.map((r) => ({ ...r, q: parseNum(r.qty), p: parseNum(r.price) }));
  const invalid = parsed.some((r) => r.q === null || r.p === null || r.q < 0 || r.p < 0 || !r.name.trim());
  const after = parsed.reduce((s, r) => s + Math.round((r.q ?? 0) * (r.p ?? 0)), 0);

  const set = (i: number, patch: Partial<Draft>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function submit() {
    const lines_after: Line[] = parsed.map((r) => ({
      key: r.key,
      name: r.name.trim(),
      unit: r.unit,
      qty: r.q ?? 0,
      price: r.p ?? 0,
      total: Math.round((r.q ?? 0) * (r.p ?? 0)),
      ...(r.sku ? { sku: r.sku } : {}),
    }));
    const form = new FormData();
    form.append('lines_after', JSON.stringify(lines_after));
    form.append('comment', comment.trim());
    files.forEach((f) => form.append('files', f));
    await client.api(`/vendor/orders/${o.id}/corrections`, { method: 'POST', body: form });
  }

  return (
    <>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Позиция</th>
              <th className="num">Кол-во</th>
              <th>Ед.</th>
              <th className="num">Цена</th>
              <th className="num">Сумма</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {parsed.map((r, i) => (
              <tr key={r.key} className={r.isNew ? 'new' : ''}>
                <td className="edit-cell">
                  <input className="wide" value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
                </td>
                <td className="num edit-cell">
                  <input inputMode="decimal" value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} />
                </td>
                <td className="edit-cell">
                  <input className="xs" value={r.unit} onChange={(e) => set(i, { unit: e.target.value })} />
                </td>
                <td className="num edit-cell">
                  <input inputMode="numeric" value={r.price} onChange={(e) => set(i, { price: e.target.value })} />
                </td>
                <td className="num">{r.q !== null && r.p !== null ? sum(Math.round(r.q * r.p)) : '—'}</td>
                <td>
                  <button type="button" className="b danger" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="b"
          onClick={() =>
            setRows((rs) => [...rs, { key: `new_${Date.now()}`, name: '', unit: 'шт', qty: '1', price: '0', isNew: true }])
          }
        >
          + Строка
        </button>
        <span>
          Итого: {after !== before && <span className="diff-old">{sum(before)}</span>}
          <b>{sum(after)}</b>
          {after !== before && <span className="muted"> · мастер должен подтвердить изменение</span>}
        </span>
      </div>
      <label className="f">
        Комментарий мастеру (что и почему изменено)
        <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <label className="f">
          Исправленные файлы (раскрой, ЧПУ)
          <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        </label>
      </div>
      <Msg message={act.message} />
      <div className="toolbar">
        <button
          type="button"
          className="b primary"
          disabled={act.busy || invalid || comment.trim().length < 3}
          onClick={() => void act.run(submit, 'Исправление отправлено').then((ok) => ok && onDone())}
        >
          Отправить исправление
        </button>
        <button type="button" className="b" onClick={onCancel}>
          Отмена
        </button>
        {invalid && <span className="muted">Проверьте строки: название, количество и цена — числа ≥ 0</span>}
      </div>
    </>
  );
}
