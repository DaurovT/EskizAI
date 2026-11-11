'use client';

/**
 * Общие куски рабочих экранов суперадмина: фильтры в адресе страницы (ссылку можно отправить коллеге,
 * «Назад» возвращает к тому же списку), сортируемые заголовки, плитки с цифрами, переключатели,
 * диалог действия с обязательной причиной.
 */
import '@/app/admin/ops.css';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type Params = Record<string, string>;

/** Состояние фильтров в ?query: значения по умолчанию в адрес не пишутся. */
export function useUrlState<T extends Params>(defaults: T): [T, (patch: Partial<T>) => void, () => void] {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const key = sp.toString();
  const state = useMemo(() => {
    const out = { ...defaults };
    for (const k of Object.keys(defaults)) {
      const v = sp.get(k);
      if (v !== null) (out as Params)[k] = v;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const write = useCallback(
    (next: Params) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) if (v !== '' && v !== defaults[k]) q.set(k, v);
      const s = q.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathname, router],
  );
  const set = useCallback(
    (patch: Partial<T>) => {
      // смена любого фильтра (кроме страницы) — на первую страницу
      const resetPage = !('offset' in patch) && 'offset' in defaults ? { offset: defaults.offset } : {};
      write({ ...state, ...resetPage, ...(patch as Params) });
    },
    [state, write, defaults],
  );
  const reset = useCallback(() => write({ ...defaults }), [write, defaults]);
  return [state, set, reset];
}

/** Поле поиска: ввод сразу, запрос — через 350 мс тишины. */
export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setText(value), [value]);
  return (
    <input
      type="search"
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => onChange(v.trim()), 350);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (timer.current) clearTimeout(timer.current);
          onChange(text.trim());
        }
      }}
    />
  );
}

export function Pills<V extends string>({ value, options, onChange, label }: { value: V; options: [V, ReactNode][]; onChange: (v: V) => void; label?: string }) {
  return (
    <div className="ops-pills" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function SortTh({
  k,
  label,
  sort,
  order,
  onSort,
  num,
  firstDesc = true,
  title,
}: {
  k: string;
  label: ReactNode;
  sort: string;
  order: string;
  onSort: (k: string, order: 'asc' | 'desc') => void;
  num?: boolean;
  firstDesc?: boolean;
  title?: string;
}) {
  const on = sort === k;
  const arrow = on ? (order === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <th className={`ops-sort ${num ? 'num' : ''} ${on ? 'on' : ''}`} aria-sort={on ? (order === 'asc' ? 'ascending' : 'descending') : 'none'} title={title}>
      <button type="button" onClick={() => onSort(k, on ? (order === 'asc' ? 'desc' : 'asc') : firstDesc ? 'desc' : 'asc')}>
        {label}
        {arrow}
      </button>
    </th>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
  onClick,
  on,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'bad' | 'warn';
  onClick?: () => void;
  on?: boolean;
}) {
  const body = (
    <>
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {hint && <div className="h">{hint}</div>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={`ops-stat ${tone ?? ''} ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={on}>
        {body}
      </button>
    );
  }
  return <div className={`ops-stat ${tone ?? ''}`}>{body}</div>;
}

/** Модальное окно: закрывается по Esc и клику мимо. */
export function Dialog({ title, onClose, children, wide = true }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className={`modal ${wide ? 'ops-dialog' : ''}`} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Поле обязательной причины (от 3 символов) — уходит в журнал действий. */
export function ReasonField({ value, onChange, autoFocus = true, label }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; label?: string }) {
  return (
    <label className="f">
      {label ?? 'Причина (обязательно, попадёт в журнал действий)'}
      <textarea rows={2} value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export const reasonOk = (r: string) => r.trim().length >= 3;

/** «45 мин», «7 ч», «2 дн 4 ч». */
export function hoursLabel(h: number | null | undefined): string {
  if (h === null || h === undefined) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} мин`;
  if (h < 48) return `${Math.round(h)} ч`;
  const d = Math.floor(h / 24);
  const r = Math.round(h - d * 24);
  return r ? `${d} дн ${r} ч` : `${d} дн`;
}

/** «сегодня», «вчера», «5 дн назад», «3 мес назад». */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const h = (Date.now() - new Date(iso).getTime()) / 3600_000;
  if (h < 1) return 'только что';
  if (h < 24) return `${Math.round(h)} ч назад`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'вчера';
  if (d < 60) return `${d} дн назад`;
  return `${Math.round(d / 30)} мес назад`;
}

export const PLAN_LABEL: Record<string, string> = { free: 'Бесплатный', pack: 'Пакет', pro: 'Pro' };

export const WAITING_LABEL: Record<string, string> = {
  supplier: 'ждёт поставщика',
  master: 'ждёт мастера',
  platform: 'ждёт платформу',
};

/** Число из поля ввода суммы: «1 200 000» → 1200000; пусто или мусор — null. */
export function parseSum(s: string): number | null {
  const v = s.replace(/[\s  ]/g, '').replace(',', '.');
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
