'use client';

/** ADM-09: заявка «нестандарт» — назначение конструктору EMAN, цена и срок, статус, доработанные файлы. */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { api, download, patch } from '@/lib/admin/api';
import { dt, sum } from '@/lib/admin/format';
import { useAction, useApi } from '@/lib/admin/useApi';
import { NS_STATUSES, nsColor, type NsRow } from '../shared';

interface Card extends NsRow {
  workshop_id: string;
  differences: string[];
  manager_note: string | null;
  designer_comment: string | null;
  photos: { id: string; url: string }[];
  files: { id: string; name: string; size: number; uploaded_at: string; admin_url: string }[];
  estimated_at: string | null;
  accepted_at: string | null;
  done_at: string | null;
}

export default function NonstandardCard() {
  const { id } = useParams<{ id: string }>();
  const { data: r, error, loading, reload } = useApi<Card>(`/admin/nonstandard/${id}`);
  const act = useAction();
  const [assignee, setAssignee] = useState('');
  const [price, setPrice] = useState('');
  const [days, setDays] = useState('');
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (!r) return;
    setAssignee(r.assignee ?? '');
    setPrice(r.price != null ? String(r.price) : '');
    setDays(r.lead_days != null ? String(r.lead_days) : '');
    setNote(r.manager_note ?? '');
    setComment(r.designer_comment ?? '');
  }, [r]);

  if (!r) return <Loading error={error} loading={loading} />;
  const closed = r.status === 'done' || r.status === 'cancelled';

  const save = (status?: string) =>
    act.run(async () => {
      await patch(`/admin/nonstandard/${id}`, {
        assignee: assignee || null,
        price: price ? Number(price.replace(/\s/g, '')) : null,
        lead_days: days ? Number(days) : null,
        manager_note: note || null,
        designer_comment: comment || null,
        ...(status ? { status } : {}),
      });
      reload();
    }, status ? 'Статус изменён' : 'Сохранено');

  const upload = () =>
    act.run(async () => {
      if (!file) return;
      const form = new FormData();
      form.append('file', file);
      await api(`/admin/nonstandard/${id}/files`, { method: 'POST', body: form });
      setFile(null);
      reload();
    }, 'Файл прикреплён');

  return (
    <>
      <p className="muted"><Link href="/admin/nonstandard">← Нестандарт</Link></p>
      <h1>
        Заявка №{r.number ?? '—'} · {r.project_title ?? 'проект'} <Tag color={nsColor(r.status)}>{r.status_label}</Tag>
      </h1>
      <p className="muted">
        {r.workshop_name ?? '—'} · создана {dt(r.created_at)}
        {r.path === 'self' ? ' · мастер дорабатывает сам' : ' · конструкторам EMAN'}
        {' · '}<Link href={`/admin/projects/${r.project_id}`}>проект</Link>
      </p>
      <Msg message={act.message} />
      <Box title="Что нужно">
        <p style={{ whiteSpace: 'pre-wrap' }}>{r.description}</p>
        {r.differences.length > 0 && (
          <>
            <b>Отличия от ближайшего варианта</b>
            <ul>{r.differences.map((d) => <li key={d}>{d}</li>)}</ul>
          </>
        )}
        {r.photos.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {r.photos.map((p) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={p.id} src={p.url.startsWith('http') ? p.url : `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'}${p.url}`} alt="" style={{ height: 120, borderRadius: 6 }} />
            ))}
          </div>
        )}
      </Box>
      <Box title="Оценка и назначение">
        <div className="kv" style={{ alignItems: "center" }}>
          <span>Конструктор</span><input value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={closed} />
          <span>Цена, сум</span><input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} disabled={closed} />
          <span>Срок, дней</span><input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} disabled={closed} />
          <span>Комментарий конструктора (видит мастер)</span><textarea value={comment} onChange={(e) => setComment(e.target.value)} disabled={closed} />
          <span>Заметка менеджера</span><textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <p className="muted">Цена и срок в отправленной заявке переводят её в «Оценена» — мастер получит push и примет цену в приложении.</p>
        <div className="toolbar">
          <button className="b primary" disabled={act.busy} onClick={() => save()}>Сохранить</button>
          {NS_STATUSES.filter(([v]) => v !== r.status).map(([v, l]) => (
            <button key={v} className="b" disabled={act.busy || closed} onClick={() => save(v)}>{l}</button>
          ))}
        </div>
        <p className="muted">
          Оценена: {dt(r.estimated_at)} · принята мастером: {dt(r.accepted_at)} · готово: {dt(r.done_at)}
          {r.price != null ? ` · ${sum(r.price)}` : ''}
        </p>
      </Box>
      <Box title="Доработанные файлы">
        {r.files.length === 0 ? <Empty>Файлов пока нет</Empty> : (
          <table>
            <tbody>
              {r.files.map((f) => (
                <tr key={f.id}>
                  <td><button className="b" onClick={() => download(f.admin_url, f.name)}>{f.name}</button></td>
                  <td className="num">{Math.round(f.size / 1024)} КБ</td>
                  <td>{dt(f.uploaded_at)}</td>
                  <td>
                    <button className="b danger" disabled={act.busy} onClick={() => act.run(async () => {
                      await api(`/admin/nonstandard/${id}/files/${f.id}`, { method: 'DELETE' });
                      reload();
                    }, 'Файл удалён')}>Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="toolbar">
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button className="b" disabled={!file || act.busy} onClick={upload}>Прикрепить</button>
        </div>
        <p className="muted">Файлы появятся у мастера в заявке (SCR-34). Отметьте «Готово», когда всё прикреплено.</p>
      </Box>
    </>
  );
}
