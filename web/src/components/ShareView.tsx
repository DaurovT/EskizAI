'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { isTelegramInApp } from '@/lib/env';
import { formatSize } from '@/lib/format';
import { t, tl } from '@/lib/i18n';
import { track } from '@/lib/track';
import type { AgreeResponse, Lang, SharePayload } from '@/lib/share-types';
import { useLang } from './useLang';
import { ArLauncher, type ArDevForce } from './ArLauncher';
import { ChangeSheet } from './ChangeSheet';
import { CompositionCard } from './CompositionCard';
import { EskizMark } from './icons';
import { LangSwitch } from './LangSwitch';
import { WorkshopLogo, workshopName } from './MasterCard';
import { NextSteps } from './NextSteps';
import { PriceBlock } from './PriceBlock';
import { ShareBar } from './ShareBar';
import { TelegramHint } from './TelegramHint';
import { Viewer3D } from './Viewer3D';

/** Подпись под названием цеха: город, иначе имя мастера (если оно отличается от цеха). */
function workshopSub(data: SharePayload, lang: Lang): string | null {
  const m = data.master;
  if (m.city) return m.city;
  if (m.workshop && m.name && m.name !== m.workshop) return t(lang, 'masterIs', { name: m.name });
  return null;
}

/**
 * WEB-1: страница ссылки клиента /p/[token].
 * Сверху вниз: шапка цеха → 3D во всю ширину → название и размер → цена → AR → «Что в изделии» →
 * «Что дальше». Внизу всегда на экране — «Согласен, жду замер», контакты мастера и «Хочу изменить…».
 */
export function ShareView({ data, initialLang, dev }: { data: SharePayload; initialLang: Lang; dev?: ArDevForce }) {
  const router = useRouter();
  const [lang, setLang] = useLang(data.token, initialLang);
  const [inTelegram, setInTelegram] = useState(false);
  const [arFailed, setArFailed] = useState(false);
  const [agreeState, setAgreeState] = useState<'idle' | 'sending' | 'error'>('idle');
  const [changeOpen, setChangeOpen] = useState(false);
  const [barH, setBarH] = useState(0);
  const opened = useRef(false);

  useEffect(() => {
    setInTelegram(isTelegramInApp());
    if (!opened.current) {
      opened.current = true;
      track(data.token, 'opened', { telegram: isTelegramInApp(), lang: initialLang });
    }
  }, [data.token, initialLang]);

  const title = tl(lang, data.project.title);
  const size = formatSize(data.project.sizeMm);
  const sub = workshopSub(data, lang);

  const agree = async () => {
    setAgreeState('sending');
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(data.token)}/agree`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as AgreeResponse;
      track(data.token, 'agreed', { at: body.agreedAt });
      router.push(`/p/${encodeURIComponent(data.token)}/agreed?lang=${lang}`);
    } catch {
      setAgreeState('error');
    }
  };

  return (
    <main className="ek share" style={{ '--barh': `${barH || 128}px` } as CSSProperties}>
      <header className="top">
        <WorkshopLogo master={data.master} />
        <div className="top-tx">
          <div className="top-n ell">{workshopName(data.master)}</div>
          {sub && <div className="top-s ell">{sub}</div>}
        </div>
        <LangSwitch lang={lang} onChange={setLang} />
      </header>

      <Viewer3D model={data.model} lang={lang} />

      <div className="body share-body">
        <div className="intro">
          <h1 className="ttl-main">{title}</h1>
          <div className="size-chip mono">
            {size}&nbsp;{t(lang, 'mm')}
          </div>
        </div>

        <PriceBlock estimate={data.estimate} priceDate={data.priceDate} expiresAt={data.expiresAt} lang={lang} />

        <ArLauncher
          token={data.token}
          glb={data.glb}
          title={title}
          sizeMm={data.project.sizeMm}
          lang={lang}
          inTelegram={inTelegram}
          agreed={Boolean(data.agreedAt)}
          onAgree={agree}
          onFailed={() => setArFailed(true)}
          onWantChange={() => setChangeOpen(true)}
          dev={dev}
        />
        {arFailed && <TelegramHint lang={lang} inTelegram={inTelegram} />}

        <CompositionCard model={data.model} lang={lang} />

        <NextSteps lang={lang} agreedAt={data.agreedAt} />

        <p className="made">
          <EskizMark size={16} />
          {t(lang, 'madeIn')}
        </p>
      </div>

      <ShareBar
        lang={lang}
        master={data.master}
        agreedAt={data.agreedAt}
        sending={agreeState === 'sending'}
        error={agreeState === 'error'}
        onAgree={agree}
        onWantChange={() => setChangeOpen(true)}
        onHeight={setBarH}
      />

      <ChangeSheet token={data.token} lang={lang} open={changeOpen} onClose={() => setChangeOpen(false)} />
    </main>
  );
}
