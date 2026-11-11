'use client';

/**
 * Шапка админки: поиск по всей платформе (Cmd/Ctrl+K), «требует внимания» со значком,
 * сотрудник и выход, баннер режима обслуживания. Тревоги грузятся раз в минуту и при возврате на вкладку —
 * один запрос на шапку, меню и сводку (контекст AlertsProvider).
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { adminClient } from '@/lib/admin/api';
import { type AlertsResponse, type SearchResponse } from '@/lib/admin/insights';
import { ApiError, qs, roleLabel } from '@/lib/staff/client';
import { useSession } from '@/lib/staff/hooks';

interface AlertsState {
  data: AlertsResponse | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

const AlertsCtx = createContext<AlertsState>({ data: null, error: null, loading: false, reload: () => {} });

export function useAlerts(): AlertsState {
  return useContext(AlertsCtx);
}

const POLL_MS = 60_000;

export function AlertsProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    adminClient
      .api<AlertsResponse>('/admin/insights/alerts')
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [tick]);

  useEffect(() => {
    const t = setInterval(reload, POLL_MS);
    const onFocus = () => document.visibilityState === 'visible' && reload();
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [reload]);

  const value = useMemo(() => ({ data, error, loading, reload }), [data, error, loading, reload]);
  return <AlertsCtx.Provider value={value}>{children}</AlertsCtx.Provider>;
}

/** Пункт меню со значком числа тревог. */
export function NavLabel({ text }: { text: string }) {
  const { data } = useAlerts();
  const n = data?.count ?? 0;
  const critical = data?.items.some((a) => a.severity === 'critical');
  return (
    <>
      {text}
      {n > 0 && (
        <span className={`nav-badge ${critical ? 'crit' : ''}`} title="Требует внимания">
          {n}
        </span>
      )}
    </>
  );
}

function MaintenanceBanner() {
  const { data } = useAlerts();
  const m = data?.maintenance;
  if (!m?.on) return null;
  return (
    <div className="maint-banner" role="status">
      <b>Режим обслуживания включён.</b> Мастера не могут создавать и менять проекты
      {m.until ? ` (до ${m.until.replace('T', ' ').slice(0, 16)})` : ''}.{' '}
      <Link href="/admin/settings">Настройки →</Link>
    </div>
  );
}

function AlertsMenu({ onClose }: { onClose: () => void }) {
  const { data, error, loading } = useAlerts();
  return (
    <div className="pop alerts-pop" role="dialog" aria-label="Требует внимания">
      <div className="pop-head">
        <b>Требует внимания</b>
        <Link href="/admin" onClick={onClose}>
          Сводка →
        </Link>
      </div>
      {error && <div className="msg error">{error}</div>}
      {!data && loading && <div className="muted pad">Загрузка…</div>}
      {data && data.items.length === 0 && <div className="all-clear pad">Всё спокойно — срочных дел нет</div>}
      {data?.items.map((a) => (
        <Link key={a.key} href={a.href} className={`pop-row sev-${a.severity}`} onClick={onClose}>
          <span className="sev-dot" aria-hidden />
          <span className="grow">
            {a.title}
            {a.detail && <span className="muted small"> · {a.detail}</span>}
          </span>
          <b>{a.count}</b>
        </Link>
      ))}
    </div>
  );
}

function initials(name: string): string {
  return (
    name
      .replace(/[^\p{L}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join('') || '•'
  );
}

function UserMenu({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const router = useRouter();
  if (!session) return null;
  const { me, legacy } = session;
  return (
    <div className="pop user-pop" role="menu">
      <div className="pad">
        <b>{me.name}</b>
        <div className="muted small">
          {roleLabel(me.role)}
          {me.email ? ` · ${me.email}` : ''}
        </div>
      </div>
      {!legacy && (
        <>
          <Link className="pop-row" href="/admin/security" onClick={onClose}>
            Безопасность и сессии
          </Link>
          <Link className="pop-row" href="/admin/password" onClick={onClose}>
            Сменить пароль
          </Link>
        </>
      )}
      <button
        type="button"
        className="pop-row danger"
        onClick={() => {
          onClose();
          void adminClient.logout().then(() => router.replace('/admin/login'));
        }}
      >
        Выйти
      </button>
    </div>
  );
}

/** Закрытие всплывающего окна по клику мимо и Esc. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function SearchPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 && !/\d{3}/.test(term)) {
      setRes(null);
      setError(null);
      return;
    }
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      adminClient
        .api<SearchResponse>(`/admin/insights/search${qs({ q: term })}`)
        .then((r) => {
          if (!alive) return;
          setRes(r);
          setError(null);
          setSel(0);
        })
        .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : String(e)))
        .finally(() => alive && setBusy(false));
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  const flat = useMemo(() => res?.groups.flatMap((g) => g.items) ?? [], [res]);

  function go(href: string) {
    onClose();
    router.push(href);
  }

  let idx = -1;
  return (
    <div className="modal-back palette-back" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Поиск">
        <input
          ref={input}
          value={q}
          placeholder="Телефон, цех, мастер, № заказа, проект, сотрудник, поставщик"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(flat.length - 1, s + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === 'Enter' && flat[sel]) go(flat[sel].href);
          }}
          aria-label="Поиск по платформе"
        />
        <div className="palette-body">
          {error && <div className="msg error">{error}</div>}
          {!res && !error && (
            <div className="muted pad">
              Введите хотя бы 2 буквы или 3 цифры. Цифры ищутся в телефонах и номерах заказов.
              <div className="small" style={{ marginTop: 6 }}>
                ↑↓ — выбор · Enter — открыть · Esc — закрыть
              </div>
            </div>
          )}
          {res && res.total === 0 && !busy && <div className="muted pad">Ничего не нашлось по «{res.q}»</div>}
          {res?.groups.map((g) => (
            <div key={g.key} className="palette-group">
              <div className="palette-gt">{g.title}</div>
              {g.items.map((it) => {
                idx += 1;
                const i = idx;
                return (
                  <button
                    key={`${g.key}-${it.id}`}
                    type="button"
                    className={`palette-row ${i === sel ? 'on' : ''}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => go(it.href)}
                  >
                    <span>{it.title}</span>
                    {it.sub && <span className="muted small">{it.sub}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {busy && <div className="muted pad small">Ищем…</div>}
        </div>
      </div>
    </div>
  );
}

function Topbar() {
  const session = useSession();
  const { data } = useAlerts();
  const pathname = usePathname();
  const [search, setSearch] = useState(false);
  const [menu, setMenu] = useState<'alerts' | 'user' | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const ref = useDismiss(menu !== null, close);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(true);
      } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSearch(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => setMenu(null), [pathname]);

  if (!session) return null;
  const n = data?.count ?? 0;
  const critical = data?.items.some((a) => a.severity === 'critical');
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <>
      <header className="topbar" ref={ref}>
        <button type="button" className="search-trigger" onClick={() => setSearch(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <span className="grow">Поиск: телефон, цех, заказ, проект…</span>
          <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>
        </button>
        <div className="topbar-right">
          <div className="pop-wrap">
            <button
              type="button"
              className={`icon-btn ${n ? 'has' : ''}`}
              aria-label={`Требует внимания: ${n}`}
              onClick={() => setMenu(menu === 'alerts' ? null : 'alerts')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
              {n > 0 && <span className={`nav-badge ${critical ? 'crit' : ''}`}>{n}</span>}
            </button>
            {menu === 'alerts' && <AlertsMenu onClose={close} />}
          </div>
          <div className="pop-wrap">
            <button type="button" className="user-chip" onClick={() => setMenu(menu === 'user' ? null : 'user')}>
              <span className="avatar">{initials(session.me.name)}</span>
              <span className="user-txt">
                <b>{session.me.name}</b>
                <span className="muted small">{roleLabel(session.me.role)}</span>
              </span>
            </button>
            {menu === 'user' && <UserMenu onClose={close} />}
          </div>
        </div>
      </header>
      <MaintenanceBanner />
      {search && <SearchPalette onClose={() => setSearch(false)} />}
    </>
  );
}

export const adminChrome = {
  wrap: (children: ReactNode) => <AlertsProvider>{children}</AlertsProvider>,
  topbar: <Topbar />,
  navUser: false,
};

