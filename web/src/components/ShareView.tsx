'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { isTelegramInApp } from '@/lib/env';
import { formatDay, formatSize } from '@/lib/format';
import { t, tl } from '@/lib/i18n';
import { track } from '@/lib/track';
import type { AgreeResponse, Lang, SharePayload } from '@/lib/share-types';
import { useLang } from './useLang';
import { ArLauncher, type ArDevForce } from './ArLauncher';
import { IconCheck } from './icons';
import { LangSwitch } from './LangSwitch';
import { ContactButtons, WorkshopLogo, workshopName } from './MasterCard';
import { PriceBlock } from './PriceBlock';
import { TelegramHint } from './TelegramHint';
import { Viewer3D } from './Viewer3D';

/** Подпись под названием цеха: город, иначе имя мастера (если оно отличается от цеха). */
function workshopSub(data: SharePayload, lang: Lang): string | null {
  const m = data.master;
  if (m.city) return m.city;
  if (m.workshop && m.name && m.name !== m.workshop) return t(lang, 'masterIs', { name: m.name });
  return null;
}

/** WEB-1: страница ссылки клиента /p/[token] (макет ClientPage). */
export function ShareView({ data, initialLang, dev }: { data: SharePayload; initialLang: Lang; dev?: ArDevForce }) {
  const router = useRouter();
  const [lang, setLang] = useLang(data.token, initialLang);
  const [inTelegram, setInTelegram] = useState(false);
  const [arFailed, setArFailed] = useState(false);
  const [agreeState, setAgreeState] = useState<'idle' | 'sending' | 'error'>('idle');
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
    <main className="ek">
      <header className="top">
        <WorkshopLogo master={data.master} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="rt ell" style={{ fontWeight: 600 }}>{workshopName(data.master)}</div>
          {sub && <div className="rs ell">{sub}</div>}
        </div>
        <LangSwitch lang={lang} onChange={setLang} />
      </header>

      <Viewer3D model={data.model} lang={lang} />

      <div className="body" style={{ paddingTop: 14 }}>
        <h1 className="title ttl-main">
          {title} {size}
        </h1>
        <PriceBlock estimate={data.estimate} priceDate={data.priceDate} lang={lang} />
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
          dev={dev}
        />
        {arFailed && <TelegramHint lang={lang} inTelegram={inTelegram} />}
      </div>

      <div className="foot">
        {data.agreedAt ? (
          <div className="done-bar">
            <IconCheck size={20} sw={2.6} />
            {t(lang, 'alreadyAgreed', { date: formatDay(data.agreedAt, lang) })}
          </div>
        ) : (
          <button type="button" className="cta" disabled={agreeState === 'sending'} onClick={agree}>
            {agreeState === 'sending' ? t(lang, 'agreeSending') : t(lang, 'agree')}
          </button>
        )}
        {agreeState === 'error' && <p className="err">{t(lang, 'agreeError')}</p>}
        <ContactButtons master={data.master} lang={lang} />
      </div>
    </main>
  );
}
