'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { StaffShell, type NavItem } from '@/components/staff/StaffShell';
import { useSession } from '@/lib/staff/hooks';
import { vendorClient } from '@/lib/vendor/api';

export interface VendorDashboard {
  queue?: number;
  mine?: number;
  unread_messages?: number;
  returns?: number;
  returns_awaiting_owner?: number;
  nonstandard?: number;
  price_requests?: number;
  [k: string]: unknown;
}

/** Счётчик непрочитанных сообщений мастеров (раз в минуту, только видимая вкладка). */
function Unread() {
  const session = useSession();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!session || session.me.must_change_password) return;
    let alive = true;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      vendorClient
        .api<VendorDashboard>('/vendor/dashboard')
        .then((d) => alive && setN(Number(d?.unread_messages ?? 0)))
        .catch(() => undefined);
    };
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [session]);
  return n > 0 ? <span className="badge" title="Непрочитанные сообщения">{n}</span> : null;
}

/** Меню кабинета поставщика; права — §1/§5 контракта (vendor_owner — всё, vendor_designer — работа с заказами). */
const NAV: NavItem[] = [
  { href: '/vendor', label: 'Сводка', exact: true },
  {
    href: '/vendor/orders',
    label: (
      <>
        Заказы
        <Unread />
      </>
    ),
    perm: ['vendor.orders.work', 'vendor.orders.all'],
  },
  { href: '/vendor/returns', label: 'Возвраты', perm: ['vendor.returns', 'vendor.refunds.approve'] },
  { href: '/vendor/nonstandard', label: 'Нестандарт', perm: ['vendor.nonstandard'] },
  { href: '/vendor/quotes', label: 'Позиции без цены', perm: ['vendor.quotes'] },
  { href: '/vendor/catalog', label: 'Прайс', perm: ['vendor.prices'] },
  { href: '/vendor/price-source', label: 'Источник цен', sub: true, perm: ['vendor.prices'] },
  { href: '/vendor/finance', label: 'Взаиморасчёты', perm: ['vendor.finance'] },
  { href: '/vendor/analytics', label: 'Аналитика', perm: ['vendor.analytics'] },
  { href: '/vendor/staff', label: 'Сотрудники', perm: ['vendor.staff'] },
  { href: '/vendor/settings', label: 'Настройки', perm: ['vendor.settings'] },
  { href: '/vendor/security', label: 'Безопасность' },
  { href: '/vendor/password', label: 'Сменить пароль' },
];

const identity = (h: string) => h;
const loginHref = () => '/vendor/login';

export function VendorShell({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? '/vendor';
  // На домене кабинета адрес может быть без префикса (/orders): приводим к /vendor/…
  const rel = path === '/vendor' || path.startsWith('/vendor/') ? path : path === '/' ? '/vendor' : `/vendor${path}`;
  return (
    <StaffShell
      client={vendorClient}
      brand={(me) => `Eskiz AI · ${me.org.supplier_name ?? 'поставщик'}`}
      nav={NAV}
      rel={rel}
      isPublic={rel.startsWith('/vendor/login')}
      linkFor={identity}
      loginHref={loginHref}
      wrongOrg={(me) => (me.org.kind !== 'supplier' ? 'Это учётная запись платформы — войдите в админку.' : null)}
    >
      {children}
    </StaffShell>
  );
}
