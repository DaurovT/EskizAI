'use client';

/** Настройки организации поставщика (§5.1 vendor.settings): реквизиты, контакты, склад и самовывоз, срок, оплата. */
import { useEffect, useState } from 'react';
import { Box, Loading, Msg } from '@/components/admin/ui';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';

interface VendorSettings {
  id: string;
  code: string;
  name: string;
  site_url: string | null;
  settings: Record<string, unknown>;
  commission_percent?: number;
}

type Kind = 'text' | 'number' | 'textarea' | 'date';

/** Ключи — ровно те, что принимает PATCH /vendor/settings (неизвестные → 422). */
const GROUPS: { title: string; fields: [string, string, Kind][] }[] = [
  {
    title: 'Реквизиты и договор',
    fields: [
      ['legal_name', 'Юридическое название', 'text'],
      ['inn', 'ИНН', 'text'],
      ['bank', 'Банк', 'text'],
      ['account', 'Расчётный счёт', 'text'],
      ['mfo', 'МФО', 'text'],
      ['contract_number', 'Номер договора с платформой', 'text'],
      ['contract_date', 'Дата договора', 'date'],
    ],
  },
  {
    title: 'Контакты',
    fields: [
      ['phone', 'Телефон', 'text'],
      ['email', 'Почта', 'text'],
      ['contacts', 'Контактные лица и прочее', 'textarea'],
    ],
  },
  {
    title: 'Склад, производство, оплата',
    fields: [
      ['warehouse_address', 'Адрес склада', 'text'],
      ['pickup_address', 'Адрес самовывоза', 'text'],
      ['default_lead_days', 'Срок производства по умолчанию, дней', 'number'],
      ['payment_url', 'Ссылка на оплату по умолчанию (Click / Payme)', 'text'],
      ['payment_text', 'Текст к ссылке на оплату (видит мастер)', 'textarea'],
    ],
  },
];

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export default function VendorSettingsPage() {
  const client = useClient();
  const { data, error, loading, reload } = useApi<VendorSettings>('/vendor/settings');
  const act = useAction();
  const [name, setName] = useState('');
  const [site, setSite] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data) return;
    setName(data.name ?? '');
    setSite(data.site_url ?? '');
    const v: Record<string, string> = {};
    for (const g of GROUPS) for (const [k] of g.fields) v[k] = str(data.settings?.[k]);
    setValues(v);
  }, [data]);

  const lead = values.default_lead_days?.trim() ?? '';
  const leadBad = lead !== '' && !(/^\d+$/.test(lead) && Number(lead) <= 365);

  function body() {
    const settings: Record<string, unknown> = {};
    for (const g of GROUPS)
      for (const [k, , t] of g.fields) {
        const raw = values[k]?.trim() ?? '';
        settings[k] = raw === '' ? null : t === 'number' ? Number(raw) : raw;
      }
    return { name: name.trim(), site_url: site.trim(), settings };
  }

  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));

  return (
    <>
      <h1>Настройки организации</h1>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <>
          <Box title="Организация">
            <div className="form-grid">
              <label>
                Название (видят мастера)
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                Сайт
                <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://" />
              </label>
            </div>
            <div className="muted">
              Код: {data.code}
              {data.commission_percent != null && ` · комиссия платформы: ${data.commission_percent}% (меняет платформа)`}
            </div>
          </Box>
          {GROUPS.map((g) => (
            <Box key={g.title} title={g.title}>
              <div className="form-grid">
                {g.fields.map(([k, l, t]) => (
                  <label key={k} style={t === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
                    {l}
                    {t === 'textarea' ? (
                      <textarea rows={3} value={values[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
                    ) : (
                      <input
                        type={t === 'date' ? 'date' : 'text'}
                        inputMode={t === 'number' ? 'numeric' : undefined}
                        value={values[k] ?? ''}
                        onChange={(e) => set(k, e.target.value)}
                      />
                    )}
                  </label>
                ))}
              </div>
            </Box>
          ))}
          {leadBad && <div className="msg warn">Срок производства — целое число дней от 0 до 365</div>}
          <Msg message={act.message} />
          <button
            type="button"
            className="b primary"
            disabled={act.busy || !name.trim() || leadBad}
            onClick={() => void act.run(() => client.patch('/vendor/settings', body()), 'Сохранено').then((ok) => ok && reload())}
          >
            Сохранить
          </button>
        </>
      )}
    </>
  );
}
