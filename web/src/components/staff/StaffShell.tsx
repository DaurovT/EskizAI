'use client';

/**
 * Каркас кабинета сотрудника (админка платформы и кабинет поставщика): проверка входа,
 * профиль из GET /staff/me, обязательная смена временного пароля, меню по правам,
 * «Нет доступа» на страницах без права.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, can, needsMfaSetup, roleLabel, type StaffClient, type StaffMe } from '@/lib/staff/client';
import { ClientProvider, SessionProvider, type Session } from '@/lib/staff/hooks';
import { ChangePasswordForm } from './auth';
import { MfaSetup } from './security';

export interface NavItem {
  /** Путь относительно кабинета (для админки — полный /admin/…, для поставщика — /orders и т. п.). */
  href: string;
  label: ReactNode;
  sub?: boolean;
  /** Любое из прав; пусто — доступно всем вошедшим. */
  perm?: string[];
  /** Совпадение только по точному пути (главная, раздел с подразделами). */
  exact?: boolean;
  /** Не показывать в меню (но права проверять). */
  hidden?: boolean;
  /** Только для входа по почте (не для старого токена). */
  staffOnly?: boolean;
  /** Заголовок группы в меню: печатается перед первым видимым пунктом группы. */
  group?: string;
}

/** Обвязка кабинета поверх меню и страниц (админка: шапка с поиском, тревоги, баннер техработ). */
export interface ShellChrome {
  /** Обёртка всего каркаса (провайдеры контекста) — внутри сессии и клиента API. */
  wrap?: (children: ReactNode) => ReactNode;
  /** Шапка над содержимым страницы. */
  topbar?: ReactNode;
  /** Показывать ли имя, роль и «Выйти» в меню (если они есть в шапке — false). */
  navUser?: boolean;
}

function matches(rel: string, item: NavItem): boolean {
  if (item.exact) return rel === item.href;
  return rel === item.href || rel.startsWith(`${item.href}/`);
}

export function StaffShell({
  client,
  brand,
  nav,
  rel,
  isPublic,
  linkFor,
  loginHref,
  wrongOrg,
  legacyMe,
  footer,
  chrome,
  children,
}: {
  client: StaffClient;
  brand: (me: StaffMe) => ReactNode;
  nav: NavItem[];
  /** Текущий путь относительно кабинета. */
  rel: string;
  /** Страница входа — без проверки сессии. */
  isPublic: boolean;
  linkFor: (href: string) => string;
  loginHref: () => string;
  /** Учётная запись не этого кабинета → текст ошибки. */
  wrongOrg: (me: StaffMe) => string | null;
  /** Профиль для входа по старому токену (только админка). */
  legacyMe?: StaffMe;
  footer?: ReactNode;
  chrome?: ShellChrome;
  children: ReactNode;
}) {
  const router = useRouter();
  const [session, setSession] = useState<{ me: StaffMe; legacy: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (isPublic) return;
    const mode = client.mode();
    if (!mode) {
      router.replace(loginHref());
      return;
    }
    if (mode === 'legacy' && legacyMe) {
      setSession({ me: legacyMe, legacy: true });
      return;
    }
    const cached = client.cachedMe();
    if (cached && !wrongOrg(cached)) setSession({ me: cached, legacy: false });
    let alive = true;
    client
      .me()
      .then((me) => {
        if (!alive) return;
        const problem = wrongOrg(me);
        if (problem) {
          void client.logout().then(() => router.replace(loginHref()));
          return;
        }
        setError(null);
        setSession({ me, legacy: false });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // password_change_required: клиент сам ведёт на экран смены пароля, профиль — из кэша
        if (e instanceof ApiError && e.code === 'password_change_required' && cached) {
          setSession({ me: { ...cached, must_change_password: true }, legacy: false });
          return;
        }
        if (!cached) setError(e instanceof ApiError ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPublic, tick, client]);

  const perms = session?.me.permissions ?? [];
  const legacy = session?.legacy ?? false;
  const visible = useMemo(
    () => nav.filter((n) => !n.hidden && !(n.staffOnly && legacy) && (!n.perm?.length || can(perms, ...n.perm))),
    [nav, perms, legacy],
  );
  const current = useMemo(
    () => [...nav].sort((a, b) => b.href.length - a.href.length).find((n) => matches(rel, n)) ?? null,
    [nav, rel],
  );
  const allowed = !current || !current.perm?.length || can(perms, ...current.perm);
  const home = nav[0];
  const fallback = visible.find((n) => n.href !== home?.href);

  // Главная без права (например, дашборд только у суперадмина) → первый доступный раздел
  useEffect(() => {
    if (session && !allowed && current && current === home && fallback) router.replace(linkFor(fallback.href));
  }, [session, allowed, current, home, fallback, router, linkFor]);

  async function logout() {
    await client.logout();
    router.replace(loginHref());
  }

  const content = <ClientProvider client={client}>{children}</ClientProvider>;
  if (isPublic) return content;

  if (!session) {
    return (
      <div className="adm">
        <div />
        <main className="adm-main">{error ? <div className="msg error">{error}</div> : null}</main>
      </div>
    );
  }

  const value: Session = { ...session, reload };

  if (session.me.must_change_password && !session.legacy) {
    return (
      <div className="adm-login">
        <div className="card">
          <h1>Смена пароля</h1>
          <div className="muted">
            {session.me.name} · {session.me.email}
          </div>
          <ChangePasswordForm
            client={client}
            forced
            onDone={() => {
              reload();
              router.replace(linkFor(home?.href ?? '/'));
            }}
            onLogout={() => void logout()}
          />
        </div>
      </div>
    );
  }

  if (!session.legacy && needsMfaSetup(session.me)) {
    return (
      <div className="adm-login">
        <div className="card adm" style={{ display: 'flex', minHeight: 0 }}>
          <h1>Двухфакторный вход</h1>
          <div className="muted">
            Для роли «{roleLabel(session.me.role)}» вход по коду из приложения обязателен. Без него работа в кабинете
            недоступна.
          </div>
          <MfaSetup client={client} onEnabled={reload} />
          <button type="button" className="b" onClick={() => void logout()}>
            Выйти
          </button>
        </div>
      </div>
    );
  }

  const navUser = chrome?.navUser ?? true;
  const shell = (
    <div className="adm">
      <nav className="adm-nav">
        <div className="brand">{brand(session.me)}</div>
        {navUser && (
          <div className="who">
            <b>{session.me.name}</b>
            {roleLabel(session.me.role)}
            {session.me.org.kind === 'supplier' && session.me.org.supplier_name ? ` · ${session.me.org.supplier_name}` : ''}
          </div>
        )}
        {visible.map((n, i) => (
          <NavEntry
            key={n.href}
            item={n}
            groupTitle={n.group && n.group !== visible[i - 1]?.group ? n.group : null}
            href={linkFor(n.href)}
            active={current?.href === n.href}
          />
        ))}
        {navUser && (
          <button type="button" className="logout" onClick={() => void logout()}>
            Выйти
          </button>
        )}
        {footer}
      </nav>
      <main className="adm-main">
        {chrome?.topbar}
        {allowed ? (
          content
        ) : (
          <div className="denied">
            <h1>Нет доступа</h1>
            <p className="muted">У вашей роли ({roleLabel(session.me.role)}) нет прав на этот раздел.</p>
            {fallback && <Link href={linkFor(fallback.href)}>Перейти: {fallback.label} →</Link>}
          </div>
        )}
      </main>
    </div>
  );

  return (
    <SessionProvider value={value}>
      <ClientProvider client={client}>{chrome?.wrap ? chrome.wrap(shell) : shell}</ClientProvider>
    </SessionProvider>
  );
}

function NavEntry({
  item,
  groupTitle,
  href,
  active,
}: {
  item: NavItem;
  groupTitle: string | null;
  href: string;
  active: boolean;
}) {
  return (
    <>
      {groupTitle && <div className="grp">{groupTitle}</div>}
      <Link href={href} className={`${item.sub ? 'sub ' : ''}${active ? 'active' : ''}`}>
        {item.label}
      </Link>
    </>
  );
}
