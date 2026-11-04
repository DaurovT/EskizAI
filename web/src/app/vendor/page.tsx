'use client';

import Link from 'next/link';
import { Box, Loading } from '@/components/admin/ui';
import type { VendorDashboard } from '@/components/vendor/VendorShell';
import { num } from '@/lib/admin/format';
import { useApi, useCan, useSession } from '@/lib/staff/hooks';

interface Tile {
  key: string;
  label: string;
  href: string;
  perm: string[];
  warn?: boolean;
}

const TILES: Tile[] = [
  { key: 'queue', label: 'Очередь: новые заказы без конструктора', href: '/vendor/orders?scope=queue', perm: ['vendor.orders.work'], warn: true },
  { key: 'mine', label: 'Мои заказы в работе', href: '/vendor/orders?scope=mine', perm: ['vendor.orders.work'] },
  { key: 'unread_messages', label: 'Непрочитанные сообщения мастеров', href: '/vendor/orders?scope=mine', perm: ['vendor.chat'], warn: true },
  { key: 'awaiting_payment', label: 'Приняты, ждут оплаты', href: '/vendor/orders?status=accepted', perm: ['vendor.orders.work'] },
  { key: 'in_production', label: 'В производстве', href: '/vendor/orders?status=cutting', perm: ['vendor.orders.work'] },
  { key: 'returns_open', label: 'Открытые рекламации', href: '/vendor/returns?status=open', perm: ['vendor.returns'], warn: true },
  { key: 'refunds_awaiting', label: 'Возвраты ждут подтверждения суммы', href: '/vendor/returns?status=awaiting_owner', perm: ['vendor.refunds.approve'], warn: true },
  { key: 'nonstandard', label: 'Нестандарт: новые и в работе', href: '/vendor/nonstandard', perm: ['vendor.nonstandard'] },
  { key: 'price_requests', label: 'Позиции без цены', href: '/vendor/quotes', perm: ['vendor.quotes'], warn: true },
  { key: 'price_review', label: 'Обновления прайса ждут подтверждения', href: '/vendor/price-source', perm: ['vendor.prices'], warn: true },
];

/** Служебные числа сводки, не плитки. */
const NOT_TILES = new Set(['queue_oldest_hours']);

export default function VendorHome() {
  const session = useSession();
  const can = useCan();
  const { data, error, loading } = useApi<VendorDashboard>('/vendor/dashboard');
  const known = new Set([...TILES.map((t) => t.key), ...NOT_TILES]);
  const extra = data
    ? Object.entries(data).filter(([k, v]) => !known.has(k) && typeof v === 'number')
    : [];

  return (
    <>
      <h1>
        {session?.me.org.supplier_name ?? 'Кабинет поставщика'}
        <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>
          {' '}
          · здравствуйте, {session?.me.name}
        </span>
      </h1>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <div className="counters">
          {TILES.filter((t) => data[t.key] !== undefined && can(...t.perm)).map((t) => {
            const v = Number(data[t.key] ?? 0);
            return (
              <Link key={t.key} href={t.href} className="box tile">
                <div className={`kpi ${t.warn && v > 0 ? 'warn' : ''}`}>{num(v)}</div>
                <div className="muted">
                  {t.label}
                  {t.key === 'queue' && v > 0 && typeof data.queue_oldest_hours === 'number' && (
                    <> · старейший ждёт {Math.round(data.queue_oldest_hours)} ч</>
                  )}
                </div>
              </Link>
            );
          })}
          {extra.map(([k, v]) => (
            <div key={k} className="box">
              <div className="kpi">{num(v as number)}</div>
              <div className="muted">{k}</div>
            </div>
          ))}
        </div>
      )}
      <div className="grid">
        {can('vendor.orders.work') && (
          <Box title="Заказы">
            <p className="muted">Возьмите заказ из очереди, проверьте замеры и состав, примите со счётом или верните мастеру.</p>
            <Link href="/vendor/orders?scope=queue">Очередь →</Link>
          </Box>
        )}
        {can('vendor.analytics') && (
          <Box title="Аналитика">
            <p className="muted">Оборот, заказы по дням, топ цехов, работа конструкторов.</p>
            <Link href="/vendor/analytics">Открыть →</Link>
          </Box>
        )}
        {can('vendor.finance') && (
          <Box title="Взаиморасчёты">
            <p className="muted">Комиссия платформе, выплаты, долг, акт сверки.</p>
            <Link href="/vendor/finance">Открыть →</Link>
          </Box>
        )}
      </div>
    </>
  );
}
