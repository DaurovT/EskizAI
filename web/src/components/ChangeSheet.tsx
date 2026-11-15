'use client';

import { useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { FEEDBACK_MAX_CHARS, type Lang } from '@/lib/share-types';
import { IconCheck } from './icons';

type State = 'idle' | 'sending' | 'sent' | 'error' | 'too_many';

/** Высота экранной клавиатуры (iOS/Android): шторка поднимается над ней. */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !vv) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);
  return inset;
}

/** «Хочу изменить…» → шторка с полем (до 1000 знаков) → POST /api/share/{token}/feedback → push мастеру. */
export function ChangeSheet({ token, lang, open, onClose }: { token: string; lang: Lang; open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<State>('idle');
  const area = useRef<HTMLTextAreaElement>(null);
  const kb = useKeyboardInset(open);

  useEffect(() => {
    if (!open) return;
    if (state === 'sent') {
      setState('idle');
      setText('');
    }
    const id = window.setTimeout(() => area.current?.focus(), 320); // после анимации шторки
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const trimmed = text.trim();

  const send = async () => {
    if (!trimmed || state === 'sending') return;
    setState('sending');
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(token)}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
      if (res.status === 429) return setState('too_many');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState('sent');
    } catch {
      setState('error');
    }
  };

  return (
    <>
      <div className="scrim" role="presentation" onClick={onClose} />
      <div className="bs" role="dialog" aria-modal="true" aria-labelledby="ch-title" style={kb ? { bottom: kb } : undefined}>
        <div className="hdl">
          <i />
        </div>
        {state === 'sent' ? (
          <>
            <div className="ok-ic">
              <IconCheck size={26} sw={2.6} />
            </div>
            <h2 id="ch-title" className="title">
              {t(lang, 'changeSentTitle')}
            </h2>
            <p className="cap lead">{t(lang, 'changeSentText')}</p>
            <button type="button" className="cta" style={{ marginTop: 8 }} onClick={onClose}>
              {t(lang, 'done')}
            </button>
          </>
        ) : (
          <>
            <h2 id="ch-title" className="title">
              {t(lang, 'changeTitle')}
            </h2>
            <p className="cap lead">{t(lang, 'changeLead')}</p>
            <div className="ta-wrap">
              <textarea
                ref={area}
                className="ta"
                rows={4}
                maxLength={FEEDBACK_MAX_CHARS}
                value={text}
                placeholder={t(lang, 'changePlaceholder')}
                aria-label={t(lang, 'changeTitle')}
                onChange={(e) => {
                  setText(e.target.value);
                  if (state === 'error' || state === 'too_many') setState('idle');
                }}
              />
              <span className="ta-count" aria-hidden="true">
                {text.length} / {FEEDBACK_MAX_CHARS}
              </span>
            </div>
            {state === 'error' && <p className="err">{t(lang, 'changeError')}</p>}
            {state === 'too_many' && <p className="err">{t(lang, 'changeTooMany')}</p>}
            <button type="button" className="cta" disabled={!trimmed || state === 'sending'} onClick={send}>
              {state === 'sending' ? t(lang, 'agreeSending') : t(lang, 'changeSend')}
            </button>
            <button type="button" className="txt" onClick={onClose}>
              {t(lang, 'cancel')}
            </button>
          </>
        )}
      </div>
    </>
  );
}
