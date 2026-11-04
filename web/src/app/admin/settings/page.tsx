'use client';

import { useEffect, useState } from 'react';
import { Box, Loading, Msg } from '@/components/admin/ui';
import { patch } from '@/lib/admin/api';
import { useAction, useApi } from '@/lib/admin/useApi';

interface SettingsOut {
  values: Record<string, number | string | boolean>;
  descriptions: Record<string, string>;
}

const EDITABLE = ['ai_budget_usd', 'ai_warn_ratio'];
// Версия приложения и техработы (SCR-45)
const APP_TEXT = ['app_min_version', 'app_latest_version', 'app_store_url_ios', 'app_store_url_android'];
const APP_AREA = ['app_release_notes_ru', 'app_release_notes_uz'];
const MAINT_TEXT = ['maintenance_until', 'maintenance_message_ru', 'maintenance_message_uz'];
const APP_KEYS = [...APP_TEXT, ...APP_AREA, ...MAINT_TEXT];

export default function SettingsPage() {
  const { data, error, loading, setData } = useApi<SettingsOut>('/admin/settings');
  const act = useAction();
  const app = useAction();
  const [form, setForm] = useState<Record<string, string>>({});
  const [appForm, setAppForm] = useState<Record<string, string>>({});
  const [maintenance, setMaintenance] = useState(false);

  useEffect(() => {
    if (!data) return;
    setForm(Object.fromEntries(EDITABLE.map((k) => [k, String(data.values[k] ?? '')])));
    setAppForm(Object.fromEntries(APP_KEYS.map((k) => [k, String(data.values[k] ?? '')])));
    setMaintenance(Boolean(data.values.maintenance_on));
  }, [data]);

  const field = (k: string, area = false) => (
    <div key={k} style={{ display: 'contents' }}>
      <dt>{data?.descriptions[k] ?? k}</dt>
      <dd>
        {area ? (
          <textarea rows={3} style={{ width: '100%' }} value={appForm[k] ?? ''}
            onChange={(e) => setAppForm({ ...appForm, [k]: e.target.value })} />
        ) : (
          <input type="text" style={{ width: '100%' }} value={appForm[k] ?? ''}
            onChange={(e) => setAppForm({ ...appForm, [k]: e.target.value })} />
        )}
      </dd>
    </div>
  );

  if (!data) return <Loading error={error} loading={loading} />;

  return (
    <>
      <h1>Настройки</h1>
      <Box title="Бюджет ИИ на проект (раздел 6 PRD)">
        <p className="muted" style={{ marginTop: 0 }}>
          При достижении порога мастер видит предупреждение; после превышения следующая ИИ-правка просит подтверждение и
          списывает ещё один проект из лимита. Изменения пишутся в журнал действий.
        </p>
        <dl className="kv">
          {EDITABLE.map((k) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{data.descriptions[k] ?? k}</dt>
              <dd>
                <input
                  type="number"
                  step={k === 'ai_warn_ratio' ? '0.05' : '0.01'}
                  value={form[k] ?? ''}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                />
              </dd>
            </div>
          ))}
          <dt>{data.descriptions.free_projects_per_month ?? 'Бесплатных проектов в месяц'}</dt>
          <dd>{data.values.free_projects_per_month}</dd>
        </dl>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button
            className="b primary"
            type="button"
            disabled={act.busy}
            onClick={() =>
              void act.run(async () => {
                const body = Object.fromEntries(EDITABLE.map((k) => [k, Number(form[k])]));
                const res = await patch<{ values: SettingsOut['values'] }>('/admin/settings', body);
                setData({ ...data, values: res.values });
              }, 'Сохранено')
            }
          >
            Сохранить
          </button>
        </div>
        <Msg message={act.message} />
      </Box>
      <Box title="Версия приложения и техработы">
        <p className="muted" style={{ marginTop: 0 }}>
          Версия ниже минимальной — экран «Обновите приложение» без кнопки «Позже». Ниже последней — «Вышла новая
          версия» (показывается один раз). Во время техработ создание и правка проектов недоступны, ссылки клиентам
          работают.
        </p>
        <dl className="kv">
          {APP_TEXT.map((k) => field(k))}
          {APP_AREA.map((k) => field(k, true))}
          <dt>{data.descriptions.maintenance_on ?? 'Техработы'}</dt>
          <dd>
            <label>
              <input type="checkbox" checked={maintenance} onChange={(e) => setMaintenance(e.target.checked)} /> Идут
              технические работы
            </label>
          </dd>
          {MAINT_TEXT.map((k) => field(k))}
        </dl>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button
            className="b primary"
            type="button"
            disabled={app.busy}
            onClick={() =>
              void app.run(async () => {
                const body = { ...Object.fromEntries(APP_KEYS.map((k) => [k, appForm[k] ?? ''])), maintenance_on: maintenance };
                const res = await patch<{ values: SettingsOut['values'] }>('/admin/settings', body);
                setData({ ...data, values: res.values });
              }, 'Сохранено')
            }
          >
            Сохранить
          </button>
        </div>
        <Msg message={app.message} />
      </Box>
    </>
  );
}
