'use client';

import type { ReactNode } from 'react';

export function Msg({ message }: { message: { kind: 'ok' | 'error' | 'warn'; text: string } | null }) {
  if (!message) return null;
  return <div className={`msg ${message.kind}`}>{message.text}</div>;
}

export function Loading({ error, loading }: { error: string | null; loading: boolean }) {
  if (error) return <div className="msg error">{error}</div>;
  if (loading) return <div className="muted">Загрузка…</div>;
  return null;
}

export function Box({ title, children, extra }: { title?: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="box">
      {(title || extra) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          {title && <h2>{title}</h2>}
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

export function Tag({ children, color }: { children: ReactNode; color?: 'green' | 'red' | 'yellow' }) {
  return <span className={`tag ${color ?? ''}`}>{children}</span>;
}

export function Pager({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  if (total <= limit) return <div className="pager muted">Всего: {total}</div>;
  return (
    <div className="pager">
      <button className="b" type="button" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        ←
      </button>
      <span className="muted">
        {offset + 1}–{Math.min(total, offset + limit)} из {total}
      </span>
      <button className="b" type="button" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        →
      </button>
    </div>
  );
}

export function Empty({ children = 'Пусто' }: { children?: ReactNode }) {
  return <div className="muted" style={{ padding: '8px 0' }}>{children}</div>;
}
