'use client';

/** Рассылки (ADM-13): push и уведомления в приложении всем мастерам или сегменту, на ru/uz. */
import { useState } from 'react';
import { Box, Empty, Loading, Msg } from '@/components/admin/ui';
import { dt, num } from '@/lib/admin/format';
import { itemsOf } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';

/** GET /admin/broadcasts — из журнала действий: {id, head_ru, text_ru, head_uz, text_uz, segment, recipients, actor_name, created_at}. */
interface Broadcast {
  id: string;
  head_ru?: string;
  text_ru?: string;
  head_uz?: string;
  text_uz?: string;
  segment?: { city?: string | null; plan?: string | null; active_days?: number | null; roles?: string[] } | null;
  recipients?: number | null;
  actor_name?: string | null;
  created_at: string;
}

const ROLE: Record<string, string> = { owner: 'владельцы', employee: 'сотрудники' };

function segmentText(s: Broadcast['segment']): string {
  const parts: string[] = [];
  if (s?.city) parts.push(`город: ${s.city}`);
  if (s?.plan) parts.push(`тариф: ${s.plan}`);
  if (s?.active_days) parts.push(`активны за ${s.active_days} дн.`);
  const roles = (s?.roles ?? ['owner']).map((r) => ROLE[r] ?? r).join(' и ');
  return `${roles}${parts.length ? `; ${parts.join(', ')}` : ' — все'}`;
}

export default function BroadcastsPage() {
  const client = useClient();
  const { data, error, loading, reload } = useApi<Broadcast[] | { items: Broadcast[] }>('/admin/broadcasts');
  const act = useAction();
  const [titleRu, setTitleRu] = useState('');
  const [bodyRu, setBodyRu] = useState('');
  const [titleUz, setTitleUz] = useState('');
  const [bodyUz, setBodyUz] = useState('');
  const [city, setCity] = useState('');
  const [plan, setPlan] = useState('');
  const [activeDays, setActiveDays] = useState('');
  const [owners, setOwners] = useState(true);
  const [employees, setEmployees] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const rows = itemsOf(data);

  function segment() {
    return {
      city: city.trim() || null,
      plan: plan || null,
      active_days: Number(activeDays) || null,
      roles: [...(owners ? ['owner'] : []), ...(employees ? ['employee'] : [])],
    };
  }

  function body(dryRun: boolean) {
    return {
      title_ru: titleRu.trim(),
      body_ru: bodyRu.trim(),
      title_uz: titleUz.trim() || null,
      body_uz: bodyUz.trim() || null,
      segment: segment(),
      dry_run: dryRun,
    };
  }

  function count() {
    void act.run(async () => {
      const r = await client.post<{ recipients: number }>('/admin/broadcasts', body(true));
      setPreview(r.recipients);
    });
  }

  function send() {
    if (!window.confirm(`Отправить рассылку (${segmentText(segment())})${preview != null ? ` — ${preview} получателей` : ''}?`)) return;
    void act
      .run(async () => {
        const r = await client.post<{ recipients: number; sent: number }>('/admin/broadcasts', body(false));
        act.setMessage({ kind: 'ok', text: `Отправлено: ${r.sent} из ${r.recipients}` });
      })
      .then((ok) => {
        if (!ok) return;
        setTitleRu('');
        setBodyRu('');
        setTitleUz('');
        setBodyUz('');
        setPreview(null);
        reload();
      });
  }

  return (
    <>
      <h1>Рассылки</h1>
      <Box title="Новая рассылка">
        <div className="form-grid">
          <label>
            Заголовок (рус.)
            <input value={titleRu} onChange={(e) => setTitleRu(e.target.value)} maxLength={100} />
          </label>
          <label>
            Заголовок (узб.)
            <input value={titleUz} onChange={(e) => setTitleUz(e.target.value)} maxLength={100} />
          </label>
        </div>
        <div className="form-grid">
          <label>
            Текст (рус.)
            <textarea rows={3} value={bodyRu} onChange={(e) => setBodyRu(e.target.value)} maxLength={400} />
          </label>
          <label>
            Текст (узб.)
            <textarea rows={3} value={bodyUz} onChange={(e) => setBodyUz(e.target.value)} maxLength={400} />
          </label>
        </div>
        <h3>Кому</h3>
        <div className="form-grid">
          <label>
            Город
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="все" />
          </label>
          <label>
            Тариф
            <select value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="">все</option>
              <option value="free">free</option>
              <option value="pack">pack</option>
              <option value="pro">pro</option>
            </select>
          </label>
          <label>
            Активны за N дней
            <input inputMode="numeric" value={activeDays} onChange={(e) => setActiveDays(e.target.value)} placeholder="любые (1–365)" />
          </label>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <label className="chk">
              <input type="checkbox" checked={owners} onChange={(e) => setOwners(e.target.checked)} /> владельцы цехов
            </label>
            <label className="chk">
              <input type="checkbox" checked={employees} onChange={(e) => setEmployees(e.target.checked)} /> сотрудники
            </label>
          </div>
        </div>
        <p className="muted">Уходит push и уведомление в приложении; без узбекского текста — русский.</p>
        <div className="toolbar">
          <button type="button" className="b" disabled={act.busy || !titleRu.trim() || !bodyRu.trim() || (!owners && !employees)} onClick={count}>
            Посчитать получателей
          </button>
          {preview != null && <b>{preview} получателей</b>}
          <button
            type="button"
            className="b primary"
            disabled={act.busy || !titleRu.trim() || !bodyRu.trim() || (!owners && !employees)}
            onClick={send}
          >
            Отправить
          </button>
        </div>
        <Msg message={act.message} />
      </Box>
      <Box title="История рассылок">
        <Loading error={error} loading={loading && !data} />
        {data &&
          (rows.length === 0 ? (
            <Empty>Рассылок ещё не было</Empty>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Когда</th>
                    <th>Заголовок</th>
                    <th>Кому</th>
                    <th className="num">Получателей</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.id}>
                      <td>
                        {dt(b.created_at)}
                        {b.actor_name && <div className="muted">{b.actor_name}</div>}
                      </td>
                      <td>
                        <b>{b.head_ru ?? '—'}</b>
                        {b.text_ru && <div className="muted">{b.text_ru}</div>}
                      </td>
                      <td>{segmentText(b.segment)}</td>
                      <td className="num">{num(b.recipients ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Box>
    </>
  );
}
