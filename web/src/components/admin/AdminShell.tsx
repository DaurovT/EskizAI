'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { API_URL, getToken, setToken } from '@/lib/admin/api';

const NAV: { href: string; label: string; sub?: boolean }[] = [
  { href: '/admin', label: 'Дашборд' },
  { href: '/admin/workshops', label: 'Цеха' },
  { href: '/admin/projects', label: 'Проекты' },
  { href: '/admin/orders', label: 'Заказы' },
  { href: '/admin/catalog', label: 'Каталог' },
  { href: '/admin/catalog/runs', label: 'Парсер прайса', sub: true },
  { href: '/admin/catalog/review', label: 'Проверка цен', sub: true },
  { href: '/admin/ai', label: 'ИИ-журнал' },
  { href: '/admin/settings', label: 'Настройки' },
];

function isActive(path: string, href: string): boolean {
  if (href === '/admin') return path === '/admin';
  if (href === '/admin/catalog') return path === '/admin/catalog';
  return path === href || path.startsWith(`${href}/`);
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? '/admin';
  const router = useRouter();
  const isLogin = path.startsWith('/admin/login');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isLogin) {
      setReady(true);
      return;
    }
    if (!getToken()) {
      router.replace('/admin/login');
      return;
    }
    setReady(true);
  }, [isLogin, router, path]);

  if (isLogin) return <>{children}</>;
  if (!ready) return <div className="adm" />;

  return (
    <div className="adm">
      <nav className="adm-nav">
        <div className="brand">Мебель · админка</div>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={`${n.sub ? 'sub ' : ''}${isActive(path, n.href) ? 'active' : ''}`}>
            {n.label}
          </Link>
        ))}
        <button
          type="button"
          className="logout"
          onClick={() => {
            setToken(null);
            router.replace('/admin/login');
          }}
        >
          Выйти
        </button>
        <div className="muted" style={{ padding: '12px 18px', fontSize: 11, color: '#8fa39c' }}>
          API: {API_URL}
        </div>
      </nav>
      <main className="adm-main">{children}</main>
    </div>
  );
}
