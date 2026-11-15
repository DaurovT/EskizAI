'use client';

import { useEffect, useRef } from 'react';
import { formatDay } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { Lang, ShareMaster } from '@/lib/share-types';
import { IconCheck, IconEdit, IconPhone, IconTelegram } from './icons';
import { telegramUrl } from './MasterCard';

interface Props {
  lang: Lang;
  master: ShareMaster;
  agreedAt: string | null;
  sending: boolean;
  error: boolean;
  onAgree: () => void;
  onWantChange: () => void;
  /** Высота панели — странице для нижнего отступа (контент не прячется под панель). */
  onHeight: (px: number) => void;
}

/**
 * Нижняя панель (всегда на экране): «Согласен, жду замер» + звонок / Telegram мастеру,
 * под ней — «Хочу изменить…». После согласия — «✓ Вы согласовали …» и те же контакты.
 */
export function ShareBar({ lang, master, agreedAt, sending, error, onAgree, onWantChange, onHeight }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onHeightRef.current(Math.ceil(el.getBoundingClientRect().height));
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} className="sbar">
      <div className="sbar-row">
        {agreedAt ? (
          <div className="sbar-done" role="status">
            <IconCheck size={20} sw={2.6} />
            <span className="ell">{t(lang, 'alreadyAgreed', { date: formatDay(agreedAt, lang) })}</span>
          </div>
        ) : (
          <button type="button" className="cta" disabled={sending} onClick={onAgree}>
            {sending ? t(lang, 'agreeSending') : t(lang, 'agree')}
          </button>
        )}
        {master.phone && (
          <a className="icb" href={`tel:${master.phone}`} aria-label={t(lang, 'callMaster')} title={t(lang, 'callMaster')}>
            <IconPhone size={22} />
          </a>
        )}
        {master.telegram && (
          <a
            className="icb"
            href={telegramUrl(master.telegram)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t(lang, 'writeTelegram')}
            title={t(lang, 'writeTelegram')}
          >
            <IconTelegram size={22} />
          </a>
        )}
      </div>
      {error && <p className="err">{t(lang, 'agreeError')}</p>}
      <button type="button" className="sbar-link" onClick={onWantChange}>
        <IconEdit size={16} />
        {t(lang, 'wantChangeLink')}
      </button>
    </div>
  );
}
