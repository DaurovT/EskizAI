'use client';

/**
 * Обязательная причина для опасных действий (§4a): блокировка, ручное начисление, отмена оплаченного
 * заказа, решение спора, смена комиссии, вход «глазами мастера», сброс 2FA. Без причины API отвечает 422.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';

interface Pending {
  title: string;
  hint?: string;
  confirm: string;
  danger: boolean;
  resolve: (reason: string | null) => void;
}

export function useReason(): [ReactNode, (title: string, opts?: { hint?: string; confirm?: string; danger?: boolean }) => Promise<string | null>] {
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const ask = useCallback(
    (title: string, opts: { hint?: string; confirm?: string; danger?: boolean } = {}) =>
      new Promise<string | null>((resolve) => {
        setText('');
        setPending({ title, hint: opts.hint, confirm: opts.confirm ?? 'Подтвердить', danger: opts.danger ?? true, resolve });
        setTimeout(() => ref.current?.focus(), 0);
      }),
    [],
  );

  const close = (value: string | null) => {
    pending?.resolve(value);
    setPending(null);
  };

  const ok = text.trim().length >= 3;
  const dialog = pending ? (
    <div className="modal-back" onClick={() => close(null)}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) close(text.trim());
        }}
      >
        <h2>{pending.title}</h2>
        {pending.hint && <div className="muted">{pending.hint}</div>}
        <label className="f">
          Причина (обязательно, попадёт в журнал действий)
          <textarea ref={ref} rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="toolbar" style={{ justifyContent: 'flex-end', marginBottom: 0 }}>
          <button type="button" className="b" onClick={() => close(null)}>
            Отмена
          </button>
          <button type="submit" className={`b ${pending.danger ? 'danger' : 'primary'}`} disabled={!ok}>
            {pending.confirm}
          </button>
        </div>
      </form>
    </div>
  ) : null;

  return [dialog, ask];
}
