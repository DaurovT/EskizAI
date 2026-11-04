'use client';

/** Поставщики (§4, §4a): список, создание с первым владельцем, маршруты категорий заказа. */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { TempPassword } from '@/components/staff/auth';
import { itemsOf } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';
import { CATEGORY_LABEL, type Supplier } from './shared';

export default function SuppliersPage() {
  const { data, error, loading, reload } = useApi<Supplier[] | { items: Supplier[] }>('/admin/suppliers');
  const [creating, setCreating] = useState(false);
  const rows = itemsOf(data);
  return (
    <>
      <h1>Поставщики</h1>
      <div className="toolbar">
        <button type="button" className="b primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Скрыть форму' : '+ Поставщик'}
        </button>
      </div>
      {creating && <CreateSupplier onCreated={reload} />}
      <Loading error={error} loading={loading && !data} />
      {data &&
        (rows.length === 0 ? (
          <Empty>Поставщиков пока нет</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Поставщик</th>
                  <th>Код</th>
                  <th className="num">Комиссия</th>
                  <th>Способ заказа</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className={s.active === false ? 'inactive' : ''}>
                    <td>
                      <Link href={`/admin/suppliers/${s.id}`}>{s.name}</Link>
                    </td>
                    <td>
                      <code>{s.code}</code>
                    </td>
                    <td className="num">{s.commission_percent != null ? `${s.commission_percent}%` : '—'}</td>
                    <td>{s.order_method ?? '—'}</td>
                    <td>
                      {s.active === false ? (
                        <>
                          <Tag color="red">заблокирован</Tag>
                          {s.blocked_reason && <div className="muted">{s.blocked_reason}</div>}
                        </>
                      ) : (
                        <Tag color="green">работает</Tag>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      <RoutesEditor suppliers={rows} />
    </>
  );
}

function CreateSupplier({ onCreated }: { onCreated: () => void }) {
  const client = useClient();
  const act = useAction();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [commission, setCommission] = useState('0');
  const [site, setSite] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);

  return (
    <Box title="Новый поставщик">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            // Первый владелец создаётся в том же запросе (SupplierIn.owner) → временный пароль в ответе
            const s = await client.post<Supplier & { owner?: { user?: { email: string }; temp_password: string } }>(
              '/admin/suppliers',
              {
                code: code.trim().toLowerCase(),
                name: name.trim(),
                commission_percent: Number(commission) || 0,
                site_url: site.trim() || null,
                ...(ownerEmail.trim()
                  ? { owner: { email: ownerEmail.trim().toLowerCase(), name: ownerName.trim() || name.trim() } }
                  : {}),
              },
            );
            if (s.owner) setTemp({ email: s.owner.user?.email ?? ownerEmail.trim(), password: s.owner.temp_password });
            setCode('');
            setName('');
            setOwnerEmail('');
            setOwnerName('');
            onCreated();
          }, 'Поставщик создан');
        }}
      >
        <div className="form-grid">
          <label>
            Код (латиница, a-z0-9_)
            <input value={code} onChange={(e) => setCode(e.target.value)} pattern="[a-z0-9_]{2,40}" required />
          </label>
          <label>
            Название
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Комиссия платформы, %
            <input type="number" min={0} max={100} step="0.1" value={commission} onChange={(e) => setCommission(e.target.value)} />
          </label>
          <label>
            Сайт
            <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://…" />
          </label>
        </div>
        <h3>Первый владелец кабинета (необязательно)</h3>
        <div className="form-grid">
          <label>
            Почта владельца
            <input type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
          </label>
          <label>
            Имя владельца
            <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </label>
          <div>
            <button className="b primary" type="submit" disabled={act.busy || !code.trim() || !name.trim()}>
              Создать
            </button>
          </div>
        </div>
        <Msg message={act.message} />
      </form>
      {temp && <TempPassword email={temp.email} password={temp.password} onClose={() => setTemp(null)} />}
    </Box>
  );
}

interface Route {
  category: string;
  supplier_id: string;
  active: boolean;
}

/** Маршруты категорий: тип строки состава заказа → поставщик. Нет маршрута — поставщик по умолчанию (EMAN). */
function RoutesEditor({ suppliers }: { suppliers: Supplier[] }) {
  const client = useClient();
  const { data, error, loading, reload } = useApi<{
    routes: Route[];
    categories?: string[];
    default_supplier?: { id: string; name: string } | null;
  }>('/admin/supplier-routes');
  const act = useAction();
  const [rows, setRows] = useState<Route[]>([]);
  const [custom, setCustom] = useState('');

  useEffect(() => {
    if (!data) return;
    const list = data.routes ?? [];
    setRows(list.map((r) => ({ category: r.category, supplier_id: r.supplier_id, active: r.active !== false })));
  }, [data]);

  const used = new Set(rows.map((r) => r.category));
  const known = Array.from(new Set([...(data?.categories ?? []), ...Object.keys(CATEGORY_LABEL)]));
  const free = known.filter((c) => !used.has(c));
  const first = suppliers[0]?.id ?? '';

  function add(category: string) {
    if (!category || used.has(category)) return;
    setRows([...rows, { category, supplier_id: first, active: true }]);
  }

  return (
    <Box title="Маршруты категорий заказа">
      <p className="muted">
        Строки состава заказа группируются по поставщику: по одному заказу на поставщика. Категории без маршрута уходят
        поставщику по умолчанию{data?.default_supplier ? ` (${data.default_supplier.name})` : ''}. Нестандарт — категория
        «nonstandard».
      </p>
      <Loading error={error} loading={loading && !data} />
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Категория</th>
              <th>Поставщик</th>
              <th>Активен</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.category}>
                <td>
                  {CATEGORY_LABEL[r.category] ?? r.category} <span className="muted">({r.category})</span>
                </td>
                <td>
                  <select
                    value={r.supplier_id}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, supplier_id: e.target.value } : x)))}
                  >
                    {!suppliers.some((s) => s.id === r.supplier_id) && <option value={r.supplier_id}>?</option>}
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.active}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, active: e.target.checked } : x)))}
                  />
                </td>
                <td>
                  <button type="button" className="b danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    Убрать
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Маршрутов нет — всё уходит поставщику по умолчанию
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="toolbar" style={{ marginTop: 10 }}>
        <select value="" onChange={(e) => add(e.target.value)} disabled={!suppliers.length}>
          <option value="">+ Категория…</option>
          {free.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c] ?? c} ({c})
            </option>
          ))}
        </select>
        <input placeholder="своя категория (a-z и _)" value={custom} onChange={(e) => setCustom(e.target.value.toLowerCase())} />
        <button
          type="button"
          className="b"
          disabled={!/^[a-z_]{2,40}$/.test(custom) || used.has(custom) || !suppliers.length}
          onClick={() => {
            add(custom);
            setCustom('');
          }}
        >
          Добавить
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="b" onClick={reload} disabled={act.busy}>
          Сбросить
        </button>
        <button
          type="button"
          className="b primary"
          disabled={act.busy}
          onClick={() => void act.run(() => client.put('/admin/supplier-routes', { routes: rows }), 'Маршруты сохранены').then(reload)}
        >
          Сохранить маршруты
        </button>
      </div>
      <Msg message={act.message} />
    </Box>
  );
}
