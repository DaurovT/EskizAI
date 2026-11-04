'use client';

import { usePathname } from 'next/navigation';
import { StaffShell, type NavItem } from '@/components/staff/StaffShell';
import { adminClient, API_URL } from '@/lib/admin/api';
import type { StaffMe } from '@/lib/staff/client';

/** Меню админки; perm — любое из прав (docs/staff_vendor_contract.md §1), «*» у суперадмина — всё. */
const NAV: NavItem[] = [
  { href: '/admin', label: 'Сводка', exact: true }, // любой сотрудник платформы (блок «период» — с правом finance)
  { href: '/admin/workshops', label: 'Цеха', perm: ['workshops.view', 'workshops.grant'] },
  { href: '/admin/projects', label: 'Проекты', perm: ['projects.view'] },
  { href: '/admin/orders', label: 'Заказы', perm: ['orders.manage'] },
  { href: '/admin/disputes', label: 'Споры', perm: ['disputes'] },
  { href: '/admin/nonstandard', label: 'Нестандарт', perm: ['nonstandard.manage'] },
  { href: '/admin/catalog', label: 'Каталог', exact: true, perm: ['catalog.manage'] },
  { href: '/admin/catalog/runs', label: 'Парсер прайса', sub: true, perm: ['catalog.manage'] },
  { href: '/admin/catalog/review', label: 'Проверка цен', sub: true, perm: ['catalog.manage'] },
  { href: '/admin/suppliers', label: 'Поставщики', perm: ['suppliers.manage'] },
  { href: '/admin/finance', label: 'Финансы', perm: ['finance'] },
  { href: '/admin/limits', label: 'Тарифы и лимиты', perm: ['tariffs'] },
  { href: '/admin/ai', label: 'ИИ-журнал', perm: ['ai.log'] },
  { href: '/admin/broadcasts', label: 'Рассылки', perm: ['broadcasts'] },
  { href: '/admin/staff', label: 'Сотрудники', perm: ['staff.manage'] },
  { href: '/admin/audit', label: 'Журнал действий', perm: ['audit.view'] },
  { href: '/admin/settings', label: 'Настройки', perm: ['settings'] },
  { href: '/admin/security', label: 'Безопасность', staffOnly: true },
  { href: '/admin/password', label: 'Сменить пароль', staffOnly: true },
];

/** Вход по старому общему токену = суперадмин (переходный период). */
const LEGACY_ME: StaffMe = {
  id: 'admin-token',
  email: '',
  name: 'Общий токен админки',
  role: 'superadmin',
  org: { kind: 'platform' },
  permissions: ['*'],
  must_change_password: false,
};

const identity = (h: string) => h;
const loginHref = () => '/admin/login';

export function AdminShell({ children }: { children: React.ReactNode }) {
  const raw = usePathname() ?? '/admin';
  // На домене админки адрес может быть без префикса (/orders): приводим к /admin/…
  const path = raw === '/admin' || raw.startsWith('/admin/') ? raw : raw === '/' ? '/admin' : `/admin${raw}`;
  return (
    <StaffShell
      client={adminClient}
      brand={() => 'Eskiz AI · админка'}
      nav={NAV}
      rel={path}
      isPublic={path.startsWith('/admin/login')}
      linkFor={identity}
      loginHref={loginHref}
      wrongOrg={(me) =>
        me.org.kind === 'supplier' ? 'Это учётная запись поставщика — войдите в кабинет поставщика.' : null
      }
      legacyMe={LEGACY_ME}
      footer={
        <div className="muted" style={{ padding: '12px 18px', fontSize: 11, color: '#8fa39c' }}>
          API: {API_URL}
        </div>
      }
    >
      {children}
    </StaffShell>
  );
}
