'use client';

/** Заявка «нестандарт» у поставщика: оценка цены и срока, назначение конструктора, статус, доработанные файлы. */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import type { StaffUser } from '@/components/staff/StaffManager';
import { Photos } from '@/components/vendor/order/Facts';
import { NS_STATUSES, nsColor, type NsRow } from '@/app/admin/nonstandard/shared';
import { dt, sum } from '@/lib/admin/format';
import { itemsOf } from '@/lib/staff/client';
import { useAction, useApi, useCan, useClient, useSession } from '@/lib/staff/hooks';
import { parseNum } from '@/lib/vendor/format';

interface Card extends NsRow {
  assignee_id?: string | null;
  assignee_name?: string | null;
  term_days?: number | null;
  differences?: string[];
  designer_comment?: string | null;
  comment?: string | null;
  photos?: { id?: string; url: string }[];
  files?: { id: string; name: string; size?: number; uploaded_at?: string; url?: string; vendor_url?: string }[];
  estimated_at?: string | null;
  accepted_at?: string | null;
  done_at?: string | null;
}

export default function VendorNonstandardCard() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const session = useSession();
  const can = useCan();
  const { data: r, error, loading, reload } = useApi<Card>(`/vendor/nonstandard/${id}`);
  const staff = useApi<StaffUser[] | { items: StaffUser[] }>(can('vendor.staff') ? '/staff/users' : null);
  const act = useAction();
  const [price, setPrice] = useState('');
  const [days, setDays] = useState('');
  const [comment, setComment] = useState('');
  const [assignee, setAssignee] = useState('');
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (!r) return;
    setPrice(r.price != null ? String(r.price) : '');
    setDays(String(r.term_days ?? r.lead_days ?? ''));
    setComment(r.comment ?? r.designer_comment ?? '');
    setAssignee(r.assignee_id ?? '');
  }, [r]);

  if (!r) return <Loading error={error} loading={loading} />;
  const closed = r.status === 'done' || r.status === 'cancelled';
  const me = session?.me;

  const save = (extra: Record<string, unknown> = {}, ok = 'Сохранено') =>
    act.run(async () => {
      await client.patch(`/vendor/nonstandard/${id}`, {
        price: parseNum(price),
        term_days: parseNum(days),
        comment: comment.trim() || null,
        ...extra,
      });
      reload();
    }, ok);

  return (
    <>
      <p className="muted">
        <Link href="/vendor/nonstandard">← Нестандарт</Link>
      </p>
      <h1>
        Заявка №{r.number ?? '—'} · {r.project_title ?? 'проект'} <Tag color={nsColor(r.status)}>{r.status_label}</Tag>
      </h1>
      <p className="muted">
        {r.workshop_name ?? '—'} · создана {dt(r.created_at)}
      </p>
      <Msg message={act.message} />
      <Box title="Что нужно">
        <p style={{ whiteSpace: 'pre-wrap' }}>{r.description}</p>
        {(r.differences ?? []).length > 0 && (
          <>
            <b>Отличия от ближайшего варианта</b>
            <ul>
              {(r.differences ?? []).map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </>
        )}
        <Photos items={r.photos} />
      </Box>
      <Box title="Оценка и работа">
        <div className="toolbar">
          Конструктор: <b>{r.assignee_name ?? r.assignee ?? 'не назначен'}</b>
          {me && r.assignee_id !== me.id && !closed && (
            <button type="button" className="b" disabled={act.busy} onClick={() => void save({ assignee_id: me.id }, 'Заявка ваша')}>
              Взять себе
            </button>
          )}
          {itemsOf(staff.data).length > 0 && !closed && (
            <>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">— назначить —</option>
                {itemsOf(staff.data)
                  .filter((u) => u.is_active)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="b"
                disabled={act.busy || !assignee || assignee === r.assignee_id}
                onClick={() => void save({ assignee_id: assignee }, 'Назначено')}
              >
                Назначить
              </button>
            </>
          )}
        </div>
        <div className="form-grid">
          <label>
            Цена, сум
            <input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} disabled={closed} />
          </label>
          <label>
            Срок, дней
            <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} disabled={closed} />
          </label>
        </div>
        <label className="f">
          Комментарий (видит мастер)
          <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} disabled={closed} />
        </label>
        <p className="muted">Цена и срок в отправленной заявке переводят её в «Оценена» — мастер получит push и примет цену в приложении.</p>
        <div className="toolbar">
          <button type="button" className="b primary" disabled={act.busy || closed} onClick={() => void save()}>
            Сохранить
          </button>
          {NS_STATUSES.filter(([v]) => v !== r.status && v !== 'sent').map(([v, l]) => (
            <button
              key={v}
              type="button"
              className={`b ${v === 'cancelled' ? 'danger' : ''}`}
              disabled={act.busy || closed}
              onClick={() => {
                if (v === 'cancelled' && !window.confirm('Отменить заявку?')) return;
                void save({ status: v }, `Статус: ${l}`);
              }}
            >
              → {l}
            </button>
          ))}
        </div>
        <p className="muted">
          Оценена: {dt(r.estimated_at)} · принята мастером: {dt(r.accepted_at)} · готово: {dt(r.done_at)}
          {r.price != null ? ` · ${sum(r.price)}` : ''}
        </p>
      </Box>
      <Box title="Доработанные файлы">
        {(r.files ?? []).length === 0 ? (
          <Empty>Файлов пока нет</Empty>
        ) : (
          <table>
            <tbody>
              {(r.files ?? []).map((f) => (
                <tr key={f.id}>
                  <td>
                    <button
                      type="button"
                      className="b"
                      onClick={() =>
                        void act.run(() => client.download(f.vendor_url ?? (f.url?.startsWith('/vendor/') ? f.url : `/vendor/nonstandard/${id}/files/${f.id}`), f.name))
                      }
                    >
                      {f.name}
                    </button>
                  </td>
                  <td className="num">{f.size ? `${Math.round(f.size / 1024)} КБ` : ''}</td>
                  <td>{dt(f.uploaded_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="toolbar" style={{ marginTop: 8 }}>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button
            type="button"
            className="b"
            disabled={!file || act.busy}
            onClick={() =>
              void act.run(async () => {
                if (!file) return;
                await client.upload(`/vendor/nonstandard/${id}/files`, file);
                setFile(null);
                reload();
              }, 'Файл прикреплён')
            }
          >
            Прикрепить
          </button>
        </div>
        <p className="muted">Файлы появятся у мастера в заявке. Отметьте «Готово», когда всё прикреплено.</p>
      </Box>
    </>
  );
}
