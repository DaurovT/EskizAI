'use client';

/**
 * Тарифы и лимиты (ADM-12, §4a): лимиты расходов на ИИ и SMS, режим обслуживания и аварийные выключатели.
 * GET /admin/limits → {values, descriptions, today}; PUT — плоский объект только с ключами из values.
 * GET /admin/maintenance → {values}; PUT — плоский объект ключей + reason (обязательна).
 */
import { useEffect, useState } from 'react';
import { Box, Loading, Msg, Tag } from '@/components/admin/ui';
import { useReason } from '@/components/staff/reason';
import { dt, usd } from '@/lib/admin/format';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';

interface LimitsResp {
  values: Record<string, number | null>;
  descriptions: Record<string, string>;
  today?: { ai_usd?: number };
}

interface MaintenanceValues {
  maintenance_on: boolean;
  maintenance_until: string;
  maintenance_message_ru: string;
  maintenance_message_uz: string;
  ai_enabled: boolean;
  registration_enabled: boolean;
}

export default function LimitsPage() {
  return (
    <>
      <h1>Тарифы и лимиты</h1>
      <MaintenanceBox />
      <LimitsBox />
      <p className="muted">
        Цены пакетов, Pro и файлов, бюджет ИИ на проект — в разделе «Настройки».
      </p>
    </>
  );
}

function LimitsBox() {
  const client = useClient();
  const { data, error, loading, reload } = useApi<LimitsResp>('/admin/limits');
  const act = useAction();
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data) return;
    setForm(Object.fromEntries(Object.entries(data.values).map(([k, v]) => [k, v == null ? '' : String(v)])));
  }, [data]);

  if (!data) return <Loading error={error} loading={loading} />;
  const changed = Object.keys(form).filter((k) => String(data.values[k] ?? '') !== form[k]);
  const invalid = changed.some((k) => form[k]?.trim() === '' || Number.isNaN(Number(form[k]?.replace(',', '.'))));

  return (
    <Box
      title="Лимиты расходов"
      extra={data.today?.ai_usd != null ? <span className="muted">ИИ сегодня: {usd(data.today.ai_usd, 2)}</span> : undefined}
    >
      <p className="muted">0 — без лимита. Изменения пишутся в журнал действий.</p>
      <div className="form-grid">
        {Object.keys(data.values).map((k) => (
          <label key={k} title={k}>
            {data.descriptions[k] ?? k}
            <input inputMode="decimal" value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      <button
        type="button"
        className="b primary"
        disabled={act.busy || changed.length === 0 || invalid}
        onClick={() =>
          void act
            .run(
              () => client.put('/admin/limits', Object.fromEntries(changed.map((k) => [k, Number(form[k]!.replace(',', '.'))]))),
              'Лимиты сохранены',
            )
            .then((ok) => ok && reload())
        }
      >
        Сохранить {changed.length ? `(${changed.length})` : ''}
      </button>
      <Msg message={act.message} />
    </Box>
  );
}

/** ISO с часовым поясом → значение для <input type="datetime-local"> по Ташкенту. */
function toLocal(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 5 * 3600 * 1000).toISOString().slice(0, 16);
}

function MaintenanceBox() {
  const client = useClient();
  const { data, error, loading, reload } = useApi<{ values: MaintenanceValues }>('/admin/maintenance');
  const act = useAction();
  const [reasonDialog, askReason] = useReason();
  const [ru, setRu] = useState('');
  const [uz, setUz] = useState('');
  const [until, setUntil] = useState('');

  useEffect(() => {
    if (!data) return;
    setRu(data.values.maintenance_message_ru ?? '');
    setUz(data.values.maintenance_message_uz ?? '');
    setUntil(toLocal(data.values.maintenance_until ?? ''));
  }, [data]);

  if (!data) return <Loading error={error} loading={loading} />;
  const v = data.values;

  async function save(patch: Partial<MaintenanceValues>, title: string, danger = true) {
    const reason = await askReason(title, { confirm: 'Применить', danger });
    if (!reason) return;
    const body: Record<string, unknown> = {
      maintenance_message_ru: ru.trim(),
      maintenance_message_uz: uz.trim(),
      maintenance_until: until ? `${until}:00+05:00` : '',
      ...patch,
      reason,
    };
    const ok = await act.run(() => client.put('/admin/maintenance', body), 'Сохранено');
    if (ok) reload();
  }

  return (
    <Box title="Режим обслуживания и аварийные выключатели">
      {reasonDialog}
      <p>
        Обслуживание: {v.maintenance_on ? <Tag color="red">ВКЛЮЧЕНО</Tag> : <Tag color="green">выключено</Tag>}
        {v.maintenance_on && v.maintenance_until && <span className="muted"> до {dt(v.maintenance_until)}</span>} · ИИ:{' '}
        {v.ai_enabled ? <Tag color="green">работает</Tag> : <Tag color="red">выключен</Tag>} · регистрация цехов:{' '}
        {v.registration_enabled ? <Tag color="green">открыта</Tag> : <Tag color="red">закрыта</Tag>}
      </p>
      <p className="muted">При обслуживании создание и правка проектов недоступны, мастера видят текст ниже.</p>
      <div className="form-grid">
        <label>
          Текст для приложения (рус.)
          <textarea rows={2} value={ru} onChange={(e) => setRu(e.target.value)} />
        </label>
        <label>
          Текст для приложения (узб.)
          <textarea rows={2} value={uz} onChange={(e) => setUz(e.target.value)} />
        </label>
        <label>
          Техработы до (Ташкент)
          <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
      </div>
      <div className="toolbar">
        <button
          type="button"
          className={`b ${v.maintenance_on ? 'primary' : 'danger'}`}
          disabled={act.busy}
          onClick={() =>
            void save(
              { maintenance_on: !v.maintenance_on },
              v.maintenance_on ? 'Выключить режим обслуживания' : 'Включить режим обслуживания',
              !v.maintenance_on,
            )
          }
        >
          {v.maintenance_on ? 'Выключить обслуживание' : 'Включить обслуживание'}
        </button>
        <button
          type="button"
          className={`b ${v.ai_enabled ? 'danger' : ''}`}
          disabled={act.busy}
          onClick={() => void save({ ai_enabled: !v.ai_enabled }, v.ai_enabled ? 'Выключить ИИ для всех цехов' : 'Включить ИИ', v.ai_enabled)}
        >
          {v.ai_enabled ? 'Выключить ИИ' : 'Включить ИИ'}
        </button>
        <button
          type="button"
          className={`b ${v.registration_enabled ? 'danger' : ''}`}
          disabled={act.busy}
          onClick={() =>
            void save(
              { registration_enabled: !v.registration_enabled },
              v.registration_enabled ? 'Закрыть регистрацию новых цехов' : 'Открыть регистрацию новых цехов',
              v.registration_enabled,
            )
          }
        >
          {v.registration_enabled ? 'Закрыть регистрацию' : 'Открыть регистрацию'}
        </button>
        <button type="button" className="b" disabled={act.busy} onClick={() => void save({}, 'Сохранить тексты и срок', false)}>
          Сохранить тексты
        </button>
      </div>
      <Msg message={act.message} />
    </Box>
  );
}
