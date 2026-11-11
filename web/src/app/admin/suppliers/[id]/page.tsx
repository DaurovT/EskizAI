'use client';

/** Карточка поставщика (§4a): реквизиты, комиссия по категориям с датой начала, взаиморасчёты, показатели, блокировка. */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Box, Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { TempPassword } from '@/components/staff/auth';
import { useReason } from '@/components/staff/reason';
import { dt, sum, sumShort } from '@/lib/admin/format';
import { itemsOf, roleLabel } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';
import { hoursLabel, Stat } from '@/components/admin/ops';
import { CATEGORY_LABEL, fmtValue, PERFORMANCE_LABEL, SETTINGS_FIELDS, type Supplier } from '../shared';

type Tab = 'requisites' | 'commission' | 'routes' | 'settlements' | 'performance' | 'staff';

const TABS: [Tab, string][] = [
  ['requisites', 'Реквизиты и договор'],
  ['commission', 'Комиссия'],
  ['routes', 'Маршруты'],
  ['settlements', 'Взаиморасчёты'],
  ['performance', 'Показатели'],
  ['staff', 'Сотрудники'],
];

/** Дата из <input type="date"> → ISO по Ташкенту (API требует часовой пояс). */
function tashkent(day: string, endOfDay = false): string {
  return `${day}T${endOfDay ? '23:59:59' : '00:00:00'}+05:00`;
}

export default function SupplierCard() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const card = useApi<Supplier>(`/admin/suppliers/${id}`);
  // Запасной путь: отдельной карточки может не быть — берём из списка
  const list = useApi<Supplier[] | { items: Supplier[] }>(card.error ? '/admin/suppliers' : null);
  const s = card.data ?? itemsOf(list.data).find((x) => x.id === id) ?? null;
  const reload = card.error ? list.reload : card.reload;
  const [tab, setTab] = useState<Tab>('requisites');
  const act = useAction();
  const [reasonDialog, askReason] = useReason();

  if (!s) {
    const err = card.error && (list.error ?? (list.data ? card.error : null));
    return <Loading error={err || null} loading />;
  }

  async function toggleBlock(sup: Supplier) {
    const blocking = sup.active !== false;
    const reason = await askReason(blocking ? `Заблокировать поставщика ${sup.name}` : `Разблокировать ${sup.name}`, {
      hint: blocking ? 'Новые заказы пойдут по маршруту запасного поставщика или в очередь платформы.' : undefined,
      confirm: blocking ? 'Заблокировать' : 'Разблокировать',
      danger: blocking,
    });
    if (!reason) return;
    await act.run(() => client.post(`/admin/suppliers/${sup.id}/block`, { blocked: blocking, reason }), 'Сохранено').then(reload);
  }

  return (
    <>
      {reasonDialog}
      <p className="muted">
        <Link href="/admin/suppliers">← Поставщики</Link>
      </p>
      <h1>
        {s.name} <code style={{ fontSize: 14 }}>{s.code}</code>{' '}
        {s.active === false ? <Tag color="red">заблокирован</Tag> : <Tag color="green">работает</Tag>}
      </h1>
      {s.active === false && s.blocked_reason && <div className="msg warn">Причина блокировки: {s.blocked_reason}</div>}
      <div className="toolbar">
        <button
          type="button"
          className={`b ${s.active === false ? '' : 'danger'}`}
          disabled={act.busy}
          onClick={() => void toggleBlock(s)}
        >
          {s.active === false ? 'Разблокировать' : 'Заблокировать'}
        </button>
        <Link href={`/admin/orders?supplier_id=${s.id}`}>Заказы поставщика →</Link>
      </div>
      <Msg message={act.message} />
      <HeaderStats supplierId={s.id} onTab={setTab} />
      <div className="tabs">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'requisites' && <Requisites supplier={s} onSaved={reload} />}
      {tab === 'commission' && <Commission supplier={s} onSaved={reload} />}
      {tab === 'routes' && <SupplierRoutes supplier={s} />}
      {tab === 'settlements' && <Settlements supplierId={s.id} />}
      {tab === 'performance' && <Performance supplier={s} />}
      {tab === 'staff' && <SupplierStaff supplier={s} onChanged={reload} />}
    </>
  );
}

function Requisites({ supplier, onSaved }: { supplier: Supplier; onSaved: () => void }) {
  const client = useClient();
  const act = useAction();
  const [name, setName] = useState(supplier.name);
  const [site, setSite] = useState(supplier.site_url ?? '');
  const [method, setMethod] = useState(supplier.order_method ?? 'manual_csv');
  const [settings, setSettings] = useState<Record<string, string>>({});

  useEffect(() => {
    const src = { ...(supplier.contacts ?? {}), ...(supplier.settings ?? {}) } as Record<string, unknown>;
    setSettings(Object.fromEntries(SETTINGS_FIELDS.map(([k]) => [k, src[k] == null ? '' : String(src[k])])));
  }, [supplier]);

  return (
    <Box title="Реквизиты, контакты, договор">
      <div className="form-grid">
        <label>
          Название
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Сайт
          <input value={site} onChange={(e) => setSite(e.target.value)} />
        </label>
        <label>
          Способ передачи заказа
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="manual_csv">вручную (CSV)</option>
            <option value="cabinet">кабинет поставщика</option>
            <option value="api">API</option>
            {!['manual_csv', 'cabinet', 'api'].includes(method) && <option value={method}>{method}</option>}
          </select>
        </label>
        {SETTINGS_FIELDS.map(([k, label, type]) => (
          <label key={k}>
            {label}
            <input
              type={type ?? 'text'}
              value={settings[k] ?? ''}
              onChange={(e) => setSettings({ ...settings, [k]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <button
        type="button"
        className="b primary"
        disabled={act.busy || !name.trim()}
        onClick={() =>
          void act
            .run(() => {
              const clean: Record<string, unknown> = { ...(supplier.settings ?? {}) };
              for (const [k, , type] of SETTINGS_FIELDS) {
                const v = settings[k]?.trim() ?? '';
                clean[k] = v === '' ? null : type === 'number' ? Number(v) : v;
              }
              return client.patch(`/admin/suppliers/${supplier.id}`, {
                name: name.trim(),
                site_url: site.trim() || null,
                order_method: method,
                settings: clean,
              });
            }, 'Сохранено')
            .then((ok) => ok && onSaved())
        }
      >
        Сохранить
      </button>
      <Msg message={act.message} />
    </Box>
  );
}

interface CommissionRow {
  id: string;
  category: string | null;
  rate_percent: number;
  rate_bp?: number;
  effective_from: string;
  reason?: string | null;
  created_at?: string | null;
}

function Commission({ supplier, onSaved }: { supplier: Supplier; onSaved: () => void }) {
  const client = useClient();
  const { data, error, loading, reload } = useApi<{ default_percent: number; items: CommissionRow[] }>(
    `/admin/suppliers/${supplier.id}/commission`,
  );
  const act = useAction();
  const [reasonDialog, askReason] = useReason();
  const [category, setCategory] = useState('');
  const [percent, setPercent] = useState('');
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const rows = data?.items ?? [];

  async function save() {
    const p = Number(percent.replace(',', '.'));
    const reason = await askReason(
      `Комиссия ${category ? `«${CATEGORY_LABEL[category] ?? category}»` : 'общая'}: ${p}% с ${from}`,
      { hint: 'Заказы, оформленные до этой даты, считаются по старой ставке.', confirm: 'Сохранить ставку' },
    );
    if (!reason) return;
    const ok = await act.run(
      () =>
        client.post(`/admin/suppliers/${supplier.id}/commission`, {
          rate_percent: p,
          category: category || null,
          effective_from: tashkent(from),
          reason,
        }),
      'Ставка сохранена',
    );
    if (ok) {
      setPercent('');
      reload();
      onSaved();
    }
  }

  return (
    <Box title="Ставка комиссии платформы">
      {reasonDialog}
      <p className="muted">
        Действующая общая ставка:{' '}
        <b>{data ? `${data.default_percent}%` : supplier.commission_percent != null ? `${supplier.commission_percent}%` : '—'}</b>.
        Ставка по категории важнее общей. Новая общая ставка с сегодняшнего дня сразу становится ставкой по умолчанию;
        с будущей даты — помечается «запланирована». Заказы, оформленные раньше, считаются по старой ставке.
      </p>
      <Loading error={error} loading={loading && !data} />
      {data &&
        (rows.length === 0 ? (
          <Empty>История ставок пуста — действует ставка по умолчанию</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Категория</th>
                  <th className="num">Ставка</th>
                  <th>Действует с</th>
                  <th>Причина</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = rateState(r, rows);
                  return (
                  <tr key={r.id} className={st === 'old' ? 'inactive' : ''}>
                    <td>
                      {r.category ? (CATEGORY_LABEL[r.category] ?? r.category) : 'все категории'}{' '}
                      {st === 'active' && <Tag color="green">действует</Tag>}
                      {st === 'scheduled' && <Tag color="yellow">запланирована</Tag>}
                    </td>
                    <td className="num">{r.rate_percent}%</td>
                    <td>{dt(r.effective_from)}</td>
                    <td>
                      {r.reason ?? '—'}
                      {r.created_at && <div className="muted">{dt(r.created_at)}</div>}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      <h3>Новая ставка</h3>
      <div className="form-grid">
        <label>
          Категория
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">все категории (общая)</option>
            {Object.entries(CATEGORY_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ставка, %
          <input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} />
        </label>
        <label>
          Действует с
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <div>
          <button
            type="button"
            className="b primary"
            disabled={act.busy || percent === '' || Number.isNaN(Number(percent.replace(',', '.'))) || !from}
            onClick={() => void save()}
          >
            Сохранить ставку
          </button>
        </div>
      </div>
      <Msg message={act.message} />
    </Box>
  );
}

interface Settlement {
  id: string;
  period_from?: string | null;
  period_to?: string | null;
  amount: number;
  paid_at?: string | null;
  comment?: string | null;
  created_by?: string | null;
  created_at?: string | null;
}

function Settlements({ supplierId }: { supplierId: string }) {
  const client = useClient();
  const { data, error, loading, reload } = useApi<Settlement[]>(`/admin/suppliers/${supplierId}/settlements`);
  const act = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const [periodFrom, setPeriodFrom] = useState('');
  const [periodTo, setPeriodTo] = useState('');
  const [amount, setAmount] = useState('');
  const [paidAt, setPaidAt] = useState(today);
  const [comment, setComment] = useState('');
  const rows = itemsOf(data);
  const fin = useApi<{ suppliers: { balance?: { due: number; settled: number; debt: number } }[] }>(
    `/admin/finance?supplier_id=${supplierId}`,
  );
  const bal = fin.data?.suppliers[0]?.balance;

  return (
    <>
      {bal && (
        <div className="ops-stats">
          <Stat label="Комиссия к оплате (всё время)" value={sumShort(bal.due)} hint="начислено минус сторно" />
          <Stat label="Выплачено поставщиком" value={sumShort(bal.settled)} />
          <Stat label="Долг на сегодня" value={sumShort(bal.debt)} tone={bal.debt > 0 ? 'warn' : undefined} />
        </div>
      )}
      <Box title="Выплаты поставщика платформе" extra={<Link href={`/admin/finance?supplier_id=${supplierId}`}>Взаиморасчёты за период →</Link>}>
        <Loading error={error} loading={loading && !data} />
        {data &&
          (rows.length === 0 ? (
            <Empty>Выплат пока нет</Empty>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Период</th>
                    <th className="num">Сумма</th>
                    <th>Комментарий</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{dt(r.paid_at ?? r.created_at, false)}</td>
                      <td>
                        {r.period_from || r.period_to ? `${dt(r.period_from, false)} – ${dt(r.period_to, false)}` : '—'}
                      </td>
                      <td className="num">{sum(r.amount)}</td>
                      <td>{r.comment ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Box>
      <Box title="Внести выплату">
        <div className="form-grid">
          <label>
            Период с
            <input type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} />
          </label>
          <label>
            Период по
            <input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} />
          </label>
          <label>
            Сумма, сум
            <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label>
            Дата оплаты
            <input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </label>
          <label>
            Комментарий (платёжка №…)
            <input value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          <div>
            <button
              type="button"
              className="b primary"
              disabled={act.busy || !Number(amount.replace(/\s/g, ''))}
              onClick={() =>
                void act
                  .run(
                    () =>
                      client.post(`/admin/suppliers/${supplierId}/settlements`, {
                        period_from: periodFrom ? tashkent(periodFrom) : null,
                        period_to: periodTo ? tashkent(periodTo, true) : null,
                        amount: Number(amount.replace(/\s/g, '')),
                        paid_at: paidAt ? tashkent(paidAt, true) : null,
                        comment: comment.trim() || null,
                      }),
                    'Выплата внесена',
                  )
                  .then((ok) => {
                    if (!ok) return;
                    setAmount('');
                    setComment('');
                    reload();
                    fin.reload();
                  })
              }
            >
              Внести
            </button>
          </div>
        </div>
        <Msg message={act.message} />
      </Box>
    </>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function Performance({ supplier }: { supplier: Supplier }) {
  const perf = supplier.metrics;
  if (!perf || Object.keys(perf).length === 0) {
    return (
      <Box>
        <Empty>Показателей пока нет — появятся, когда у поставщика будут заказы.</Empty>
      </Box>
    );
  }
  return (
    <Box title="Показатели поставщика">
      <dl className="kv">
        {Object.entries(perf).map(([k, v]) => (
          <FragmentKV key={k} k={PERFORMANCE_LABEL[k] ?? k} v={fmtValue(k, v)} />
        ))}
      </dl>
    </Box>
  );
}

/** Сотрудники поставщика + создание владельца (POST /admin/suppliers/{id}/owner → временный пароль). */
function SupplierStaff({ supplier, onChanged }: { supplier: Supplier; onChanged: () => void }) {
  const client = useClient();
  const act = useAction();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const staff = supplier.staff ?? [];
  return (
    <Box title="Сотрудники поставщика" extra={<Link href={`/admin/staff?supplier_id=${supplier.id}`}>Управлять (роль, пароль, сессии) →</Link>}>
      <p className="muted" style={{ marginTop: 0 }}>
        Владельцев поставщика заводит и меняет только платформа. Конструкторов владелец добавляет сам в своём кабинете.
      </p>
      {staff.length === 0 ? (
        <Empty>Сотрудников нет — создайте владельца, он заведёт конструкторов сам</Empty>
      ) : (
        <table>
          <tbody>
            {staff.map((u) => (
              <tr key={u.id} className={u.is_active ? '' : 'inactive'}>
                <td>
                  <b>{u.name}</b>
                  <div className="muted">{u.email}</div>
                </td>
                <td>{roleLabel(u.role)}</td>
                <td>{u.is_active ? <Tag color="green">активен</Tag> : <Tag color="red">отключён</Tag>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Новый владелец (vendor_owner)</h3>
      <div className="form-grid">
        <label>
          Почта
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Имя
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div>
          <button
            type="button"
            className="b primary"
            disabled={act.busy || !email.trim() || !name.trim()}
            onClick={() =>
              void act.run(async () => {
                const r = await client.post<{ user?: { email: string }; temp_password: string }>(
                  `/admin/suppliers/${supplier.id}/owner`,
                  { email: email.trim().toLowerCase(), name: name.trim() },
                );
                setTemp({ email: r.user?.email ?? email.trim(), password: r.temp_password });
                setEmail('');
                setName('');
                onChanged();
              })
            }
          >
            Создать
          </button>
        </div>
      </div>
      <Msg message={act.message} />
      {temp && <TempPassword email={temp.email} password={temp.password} onClose={() => setTemp(null)} />}
    </Box>
  );
}

/** Какая ставка действует: последняя по дате начала (не в будущем) для своей категории. */
function rateState(r: CommissionRow, all: CommissionRow[]): 'active' | 'scheduled' | 'old' {
  const now = Date.now();
  if (new Date(r.effective_from).getTime() > now) return 'scheduled';
  const current = all
    .filter((x) => x.category === r.category && new Date(x.effective_from).getTime() <= now)
    .sort((a, b) => new Date(b.effective_from).getTime() - new Date(a.effective_from).getTime() || (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0];
  return current?.id === r.id ? 'active' : 'old';
}

interface PerfRow {
  id: string;
  current_rate_percent: number;
  queue: number;
  overdue: number;
  in_work: number;
  median_accept_hours: number | null;
  return_rate: number | null;
  turnover: number;
  commission: { due: number };
  debt: number;
}

/** Цифры поставщика в шапке карточки (текущий месяц). */
function HeaderStats({ supplierId, onTab }: { supplierId: string; onTab: (t: Tab) => void }) {
  const { data } = useApi<{ items: PerfRow[]; overdue_hours: number }>('/admin/suppliers/performance');
  const p = data?.items.find((x) => x.id === supplierId);
  if (!p) return null;
  return (
    <div className="ops-stats">
      <Stat label="Ставка комиссии" value={`${p.current_rate_percent}%`} onClick={() => onTab('commission')} />
      <Stat label="Очередь" value={p.queue} hint={p.overdue ? `просрочено ${p.overdue}` : `в работе ${p.in_work}`} tone={p.overdue ? 'bad' : undefined} />
      <Stat label="Принятие (медиана)" value={hoursLabel(p.median_accept_hours)} hint="за месяц" />
      <Stat label="Возвраты" value={p.return_rate == null ? '—' : `${Math.round(p.return_rate * 100)}%`} hint="за месяц" />
      <Stat label="Оборот за месяц" value={sumShort(p.turnover)} hint={`комиссия ${sum(p.commission.due)}`} />
      <Stat label="Долг платформе" value={sumShort(p.debt)} tone={p.debt > 0 ? 'warn' : undefined} onClick={() => onTab('settlements')} />
    </div>
  );
}

interface RouteRow {
  category: string;
  supplier_id: string;
  supplier_name: string;
  active: boolean;
}

/** Маршруты этого поставщика: какие категории строк заказа уходят к нему. Сохраняется весь набор маршрутов. */
function SupplierRoutes({ supplier }: { supplier: Supplier }) {
  const client = useClient();
  const act = useAction();
  const { data, error, loading, reload } = useApi<{
    routes: RouteRow[];
    categories: string[];
    default_supplier: { id: string; name: string } | null;
  }>('/admin/supplier-routes');
  const [picked, setPicked] = useState<Set<string> | null>(null);
  if (!data) return <Loading error={error} loading={loading} />;
  const mine = new Set(data.routes.filter((r) => r.supplier_id === supplier.id && r.active).map((r) => r.category));
  const sel = picked ?? mine;
  const cats = Array.from(new Set([...data.categories, ...Object.keys(CATEGORY_LABEL), ...data.routes.map((r) => r.category)]));
  const isDefault = data.default_supplier?.id === supplier.id;
  const changed = cats.some((c) => sel.has(c) !== mine.has(c));

  async function save() {
    const moving = cats.filter((c) => sel.has(c) && !mine.has(c) && data!.routes.some((r) => r.category === c && r.supplier_id !== supplier.id));
    if (moving.length && !window.confirm(`Категории ${moving.map((c) => CATEGORY_LABEL[c] ?? c).join(', ')} сейчас ведут к другому поставщику — перенести к ${supplier.name}?`)) return;
    const keep = data!.routes.filter((r) => r.supplier_id !== supplier.id && !sel.has(r.category));
    const routes = [
      ...keep.map((r) => ({ category: r.category, supplier_id: r.supplier_id, active: r.active })),
      ...cats.filter((c) => sel.has(c)).map((c) => ({ category: c, supplier_id: supplier.id, active: true })),
    ];
    const ok = await act.run(() => client.put('/admin/supplier-routes', { routes }), 'Маршруты сохранены');
    if (ok) {
      setPicked(null);
      reload();
    }
  }

  return (
    <Box title="Какие категории заказа уходят этому поставщику">
      <p className="muted" style={{ marginTop: 0 }}>
        Строки состава заказа группируются по поставщику: по одному заказу на поставщика.{' '}
        {isDefault
          ? `${supplier.name} — поставщик по умолчанию: к нему уходит всё, для чего нет маршрута.`
          : `Категории без маршрута уходят поставщику по умолчанию${data.default_supplier ? ` (${data.default_supplier.name})` : ''}.`}{' '}
        Все маршруты сразу — в списке поставщиков.
      </p>
      <div className="scroll">
        <table className="ops-table">
          <tbody>
            {cats.map((c) => {
              const other = data.routes.find((r) => r.category === c && r.supplier_id !== supplier.id);
              return (
                <tr key={c}>
                  <td style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      checked={sel.has(c)}
                      aria-label={CATEGORY_LABEL[c] ?? c}
                      onChange={(e) => {
                        const n = new Set(sel);
                        if (e.target.checked) n.add(c);
                        else n.delete(c);
                        setPicked(n);
                      }}
                    />
                  </td>
                  <td>
                    {CATEGORY_LABEL[c] ?? c} <span className="muted">({c})</span>
                  </td>
                  <td className="muted">
                    {sel.has(c)
                      ? other && !mine.has(c)
                        ? `перейдёт от ${other.supplier_name}`
                        : 'сюда'
                      : other
                        ? `→ ${other.supplier_name}`
                        : `→ по умолчанию${data.default_supplier ? ` (${data.default_supplier.name})` : ''}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="toolbar" style={{ marginTop: 10 }}>
        <button type="button" className="b" disabled={!changed} onClick={() => setPicked(null)}>
          Отменить изменения
        </button>
        <button type="button" className="b primary" disabled={!changed || act.busy} onClick={() => void save()}>
          Сохранить маршруты
        </button>
      </div>
      <Msg message={act.message} />
    </Box>
  );
}
