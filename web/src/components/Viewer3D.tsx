'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerModel } from '@mebel/viewer';
import { t } from '@/lib/i18n';
import type { Lang } from '@/lib/share-types';
import { IconClose } from './icons';

const Inner = dynamic(() => import('./Viewer3DInner'), {
  ssr: false,
  loading: () => <div className="stage-load" aria-hidden="true" />,
});

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };

function fullscreenElement(): Element | null {
  const d = document as FsDoc;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/**
 * 3D-герой страницы клиента: во всю ширину, ~55vh. «⤢» — на весь экран: Fullscreen API,
 * а где его нет (iPhone, часть встроенных браузеров) — фиксированный слой поверх страницы.
 */
export function Viewer3D({ model, lang }: { model: ViewerModel; lang: Lang }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState(false);
  const native = useRef(false);

  const exit = useCallback(() => {
    const d = document as FsDoc;
    if (native.current && fullscreenElement()) {
      if (d.exitFullscreen) void d.exitFullscreen().catch(() => {});
      else d.webkitExitFullscreen?.();
    }
    native.current = false;
    setFs(false);
  }, []);

  const enter = useCallback(async () => {
    const el = ref.current as FsEl | null;
    if (!el) return;
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen({ navigationUI: 'hide' });
        native.current = true;
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
        native.current = Boolean(fullscreenElement());
      }
    } catch {
      native.current = false; // Telegram и др. могут отказать — тогда CSS-слой
    }
    setFs(true);
  }, []);

  // Esc / системный «назад» из настоящего полноэкранного режима
  useEffect(() => {
    const onChange = () => {
      if (native.current && !fullscreenElement()) {
        native.current = false;
        setFs(false);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  // CSS-слой: страница под ним не скроллится, Esc закрывает
  useEffect(() => {
    if (!fs) return;
    const root = document.documentElement;
    root.classList.add('ek-lock');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exit();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      root.classList.remove('ek-lock');
      window.removeEventListener('keydown', onKey);
    };
  }, [fs, exit]);

  return (
    <div ref={ref} className={fs ? 'stage hero fs' : 'stage hero'} role="region" aria-label="3D">
      <noscript>
        <div className="stage-status">{t(lang, 'no3d')}</div>
      </noscript>
      <Inner model={model} lang={lang} fullscreen={fs} onFullscreen={fs ? exit : enter} />
      {fs && (
        <button type="button" className="fs-close" aria-label={t(lang, 'close')} onClick={exit}>
          <IconClose />
        </button>
      )}
    </div>
  );
}
