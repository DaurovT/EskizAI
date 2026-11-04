import { NextResponse, type NextRequest } from 'next/server';

/**
 * Разделение одного Next.js по хостам (docs/staff_vendor_contract.md §7):
 * - ADMIN_HOST (admin.eskizai.uz)  — админка платформы: «/» → /admin, /p и /vendor — 404;
 * - VENDOR_HOST (vendor.eskizai.uz) — кабинет поставщика: «/» → /vendor, /p и /admin — 404;
 * - остальные хосты (app.eskizai.uz) — только ссылка клиента /p/*: /admin и /vendor — 404.
 * На своём хосте пути кабинета работают и без префикса (/orders → /vendor/orders), и с ним
 * (ссылки внутри приложения ведут на /vendor/…, /admin/…).
 * Локально (next dev или localhost / адрес в локальной сети) доступно всё: /admin, /vendor, /p.
 * Переменные можно задать списком через запятую. Читаются при запросе (на сервере, не при сборке).
 */

type Area = 'admin' | 'vendor' | 'client';

function hosts(value: string | undefined, fallback: string): string[] {
  return (value || fallback)
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/:\d+$/, ''))
    .filter(Boolean);
}

function isLocalHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function sectionOf(path: string): Area | null {
  if (path === '/admin' || path.startsWith('/admin/')) return 'admin';
  if (path === '/vendor' || path.startsWith('/vendor/')) return 'vendor';
  if (path.startsWith('/p/') || path.startsWith('/api/share/')) return 'client';
  return null;
}

function notFound(req: NextRequest): NextResponse {
  // Несуществующий маршрут → стандартная страница 404 со статусом 404
  return NextResponse.rewrite(new URL('/__not_found', req.url), { status: 404 });
}

export function middleware(req: NextRequest): NextResponse {
  const host = (req.headers.get('host') ?? req.nextUrl.hostname).toLowerCase().replace(/:\d+$/, '');
  const path = req.nextUrl.pathname;
  const section = sectionOf(path);

  const area: Area | null = hosts(process.env.ADMIN_HOST, 'admin.eskizai.uz').includes(host)
    ? 'admin'
    : hosts(process.env.VENDOR_HOST, 'vendor.eskizai.uz').includes(host)
      ? 'vendor'
      : null;

  if (area) {
    if (section === area) return NextResponse.next();
    if (section) return notFound(req);
    // Корень и короткие пути кабинета: / → /vendor, /orders → /vendor/orders
    const url = req.nextUrl.clone();
    url.pathname = path === '/' ? `/${area}` : `/${area}${path}`;
    return NextResponse.rewrite(url);
  }

  // Хост клиента (app.eskizai.uz): кабинеты закрыты, кроме локальной разработки
  const local = process.env.NODE_ENV !== 'production' || isLocalHost(host);
  if (!local && (section === 'admin' || section === 'vendor')) return notFound(req);
  return NextResponse.next();
}

export const config = {
  // Всё, кроме статики Next и файлов с расширением (favicon.png, модели в /public)
  matcher: ['/((?!_next/|.*\\.[A-Za-z0-9]+$).*)'],
};
