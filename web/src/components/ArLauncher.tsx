'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isAndroid, isIOS } from '@/lib/env';
import { formatSize } from '@/lib/format';
import { t } from '@/lib/i18n';
import { track } from '@/lib/track';
import type { Lang, ShareGlb } from '@/lib/share-types';
import { IconCamera, IconCube, IconInfo } from './icons';

/** Нужная нам часть API <model-viewer>. */
interface ModelViewerEl extends HTMLElement {
  readonly canActivateAR: boolean;
  readonly loaded: boolean;
  loading: string;
  activateAR(): Promise<void>;
}

/** Шаги шторки WEB-4: перед AR → загрузка → (системный AR) → после AR. */
export type ArStep = 'intro' | 'loading' | 'after';

/** Только для проверки вёрстки (dev): принудительное состояние. */
export interface ArDevForce {
  available?: boolean;
  step?: ArStep;
}

interface Props {
  token: string;
  glb: ShareGlb;
  title: string;
  sizeMm: [number, number, number];
  lang: Lang;
  inTelegram: boolean;
  agreed: boolean;
  /** «Согласен, жду замер» из шторки после AR. */
  onAgree: () => void;
  /** AR не запустился — показать «Открыть в браузере». */
  onFailed: () => void;
  dev?: ArDevForce;
}

/** Сколько ждать, что AR открылся (страница ушла в фон), прежде чем считать попытку неудачной. */
const LAUNCH_TIMEOUT_MS = 4000;
const MB = 1024 * 1024;

const mb = (bytes: number) => (bytes / MB).toFixed(1).replace('.0', '').replace('.', ',');

interface Progress {
  done: number;
  total: number | null;
  etaS: number | null;
}

/**
 * Кнопка «Примерить у себя дома (AR)» и шторка WEB-4. AR запускает <model-viewer>
 * (webxr / Scene Viewer / Quick Look; USDZ для iOS — готовый с сервера, glb.closedUsdz). Если AR на
 * устройстве нет — вместо кнопки плашка «Телефон не поддерживает примерку» (Misc).
 */
export function ArLauncher({ token, glb, title, sizeMm, lang, inTelegram, agreed, onAgree, onFailed, dev }: Props) {
  const [available, setAvailable] = useState<boolean | null>(dev?.available ?? null);
  const [mobile, setMobile] = useState(false);
  const [step, setStep] = useState<ArStep | null>(dev?.step ?? null);
  const [modelBytes, setModelBytes] = useState<number | null>(dev?.step ? 8 * MB : null);
  const [progress, setProgress] = useState<Progress | null>(
    dev?.step === 'loading' ? { done: 5.1 * MB, total: 8 * MB, etaS: 3 } : null,
  );
  const [ready, setReady] = useState(false);
  const pendingRef = useRef(false);
  const mvRef = useRef<ModelViewerEl | null>(null);
  const parkRef = useRef<HTMLDivElement>(null);
  // active — клиент нажал «Открыть камеру»; launched — AR открылся (страница ушла в фон или WebXR-сессия).
  const attemptRef = useRef<{ active: boolean; launched: boolean; timer: number | null }>({
    active: false,
    launched: false,
    timer: null,
  });
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  const forced = dev?.available !== undefined;

  useEffect(() => setMobile(isIOS() || isAndroid()), []);

  // model-viewer подключаем не сразу: сначала пусть загрузится 3D. Модель он не качает,
  // пока не попросим (loading="lazy" + «парковка» за экраном).
  useEffect(() => {
    let cancelled = false;
    const attempt = attemptRef.current;

    const fail = (reason: string) => {
      if (attempt.timer) window.clearTimeout(attempt.timer);
      attempt.timer = null;
      track(token, 'ar_failed', { reason });
      onFailedRef.current();
    };

    const start = window.setTimeout(async () => {
      try {
        await import('@google/model-viewer');
      } catch (e) {
        console.warn('model-viewer failed to load', e);
        if (!cancelled && !forced) setAvailable(false);
        return;
      }
      if (cancelled || !parkRef.current) return;
      const mv = document.createElement('model-viewer') as ModelViewerEl;
      mv.setAttribute('ar', '');
      mv.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
      // Реальный масштаб: клиент не может растянуть шкаф пальцами.
      mv.setAttribute('ar-scale', 'fixed');
      // Навесное (верхние шкафы, полка) — на стену; решает ядро (glb.placement).
      mv.setAttribute('ar-placement', glb.placement === 'wall' ? 'wall' : 'floor');
      mv.setAttribute('loading', 'lazy');
      mv.setAttribute('interaction-prompt', 'none');
      mv.setAttribute('alt', '3D');
      // USDZ собирает сервер (текстуры декоров, размещение) — в браузере не собираем.
      if (glb.closedUsdz) mv.setAttribute('ios-src', glb.closedUsdz);
      const slot = document.createElement('span');
      slot.setAttribute('slot', 'ar-button');
      slot.style.display = 'none';
      mv.appendChild(slot);
      mv.setAttribute('src', glb.closed);

      const check = () => {
        if (!cancelled && !forced) setAvailable(mv.canActivateAR);
      };
      mv.addEventListener('load', () => {
        setReady(true);
        check();
      });
      mv.addEventListener('ar-status', (e) => {
        const status = (e as CustomEvent<{ status: string }>).detail?.status;
        if (status === 'session-started') attempt.launched = true;
        else if (status === 'failed') fail('ar_status_failed');
        else if (status === 'not-presenting' && attempt.active && attempt.launched) {
          attempt.active = false;
          setStep('after');
        }
        check();
      });
      parkRef.current.appendChild(mv);
      mvRef.current = mv;
      // Выбор режима AR в model-viewer асинхронный — проверяем пару раз.
      window.setTimeout(check, 300);
      window.setTimeout(check, 1500);
    }, 800);

    // AR открылся в другом приложении → страница уходит в фон; вернулись — «Как шкаф в комнате?».
    const onVisibility = () => {
      if (!attempt.active) return;
      if (document.visibilityState === 'hidden') attempt.launched = true;
      else if (attempt.launched) {
        if (attempt.timer) window.clearTimeout(attempt.timer);
        attempt.timer = null;
        attempt.active = false;
        setStep('after');
      }
    };
    const onHide = () => {
      if (attempt.active) attempt.launched = true;
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);

    return () => {
      cancelled = true;
      window.clearTimeout(start);
      if (attempt.timer) window.clearTimeout(attempt.timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      mvRef.current?.remove();
      mvRef.current = null;
    };
  }, [token, glb.closed, glb.closedUsdz, glb.placement, forced]);

  // «Нет AR» — событие в аналитику ссылки (один раз).
  const reportedRef = useRef(false);
  useEffect(() => {
    if (available === false && !forced && !reportedRef.current) {
      reportedRef.current = true;
      track(token, 'ar_failed', { reason: 'unsupported' });
    }
  }, [available, forced, token]);

  // Размер модели для подписи «Модель 8 МБ» — HEAD без скачивания.
  useEffect(() => {
    if (step !== 'intro' || modelBytes !== null) return;
    let cancelled = false;
    fetch(glb.closed, { method: 'HEAD' })
      .then((r) => {
        const n = Number(r.headers.get('content-length'));
        if (!cancelled && n > 0) setModelBytes(n);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [step, modelBytes, glb.closed]);

  const launch = useCallback(() => {
    const mv = mvRef.current;
    if (!mv) return;
    const attempt = attemptRef.current;
    attempt.active = true;
    attempt.launched = false;
    if (attempt.timer) window.clearTimeout(attempt.timer);
    track(token, 'ar_started', { telegram: inTelegram });
    // activateAR — синхронно в обработчике тапа, иначе Scene Viewer / Quick Look не откроются.
    mv.activateAR().catch((e: unknown) => {
      console.warn('activateAR failed', e);
      track(token, 'ar_failed', { reason: 'activate_error' });
      onFailedRef.current();
    });
    attempt.timer = window.setTimeout(() => {
      attempt.timer = null;
      if (!attempt.launched && document.visibilityState === 'visible') {
        attempt.active = false;
        track(token, 'ar_failed', { reason: 'no_launch_timeout', telegram: inTelegram });
        setStep(null);
        onFailedRef.current();
      }
    }, LAUNCH_TIMEOUT_MS);
  }, [token, inTelegram]);

  // Шаг «Готовим модель»: качаем GLB с прогрессом (прогревает кэш), затем model-viewer грузит его.
  useEffect(() => {
    if (step !== 'loading' || dev?.step === 'loading') return;
    const mv = mvRef.current;
    const ctrl = new AbortController();
    const t0 = performance.now();
    (async () => {
      try {
        const res = await fetch(glb.closed, { signal: ctrl.signal });
        const total = Number(res.headers.get('content-length')) || null;
        if (total) setModelBytes(total);
        const reader = res.body?.getReader();
        let done = 0;
        if (reader) {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            done += r.value.byteLength;
            const speed = done / Math.max(1, performance.now() - t0); // байт/мс
            const etaS = total ? Math.max(1, Math.round((total - done) / speed / 1000)) : null;
            setProgress({ done, total, etaS });
          }
        }
      } catch {
        if (ctrl.signal.aborted) return;
      }
      if (mv) mv.loading = 'eager';
    })();
    return () => ctrl.abort();
  }, [step, glb.closed, dev?.step]);

  // Модель готова и клиент уже просил «Открыть, когда загрузится».
  useEffect(() => {
    if (ready && step === 'loading' && pendingRef.current) {
      pendingRef.current = false;
      launch();
    }
  }, [ready, step, launch]);

  const openCamera = () => {
    // Android (Scene Viewer) качает модель сам — сразу запускаем.
    if (ready || isAndroid()) {
      launch();
      return;
    }
    setProgress({ done: 0, total: modelBytes, etaS: null });
    setStep('loading');
  };

  const close = () => {
    pendingRef.current = false;
    setStep(null);
  };

  const size = formatSize(sizeMm);
  const showButton = available === true || (available === null && mobile);
  const pct = progress?.total ? Math.min(100, (progress.done / progress.total) * 100) : 0;

  return (
    <>
      <div ref={parkRef} className="ar-park" aria-hidden="true" />
      {showButton && (
        <button type="button" className="ar" onClick={() => setStep('intro')}>
          <IconCube />
          {t(lang, 'arButton')}
        </button>
      )}
      {available === false && (
        <div className="ban info" role="note">
          <span style={{ flex: 'none', marginTop: 1 }}>
            <IconInfo />
          </span>
          <div className="bd">{t(lang, 'noAr')}</div>
        </div>
      )}

      {step && (
        <>
          <div className="scrim" role="presentation" onClick={close} />
          <div className="bs" role="dialog" aria-modal="true" aria-label={t(lang, step === 'after' ? 'arAfterTitle' : 'arTitle')}>
            <div className="hdl">
              <i />
            </div>

            {step === 'intro' && (
              <>
                <h2 className="title">{t(lang, 'arTitle')}</h2>
                <p className="cap lead">{t(lang, 'arLead', { title, size })}</p>
                {(['arStep1', 'arStep2', 'arStep3'] as const).map((k, i) => (
                  <div className="step" key={k}>
                    <span className="sn">{i + 1}</span>
                    <span>{t(lang, k)}</span>
                  </div>
                ))}
                <button type="button" className="cta" style={{ marginTop: 4 }} onClick={openCamera}>
                  <IconCamera />
                  {t(lang, 'arOpenCamera')}
                </button>
                <p className="cap" style={{ textAlign: 'center' }}>
                  {modelBytes ? t(lang, 'arModelSize', { mb: mb(modelBytes) }) : t(lang, 'arWifi')}
                </p>
              </>
            )}

            {step === 'loading' && (
              <>
                <h2 className="title">{t(lang, 'arLoadingTitle')}</h2>
                <p className="cap lead">{t(lang, 'arLoadingLead')}</p>
                <div className="bar" style={{ marginTop: 6 }}>
                  <i style={{ width: `${ready ? 100 : pct}%` }} />
                </div>
                <div className="cap" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>
                    {progress?.total
                      ? t(lang, 'arProgress', { done: mb(progress.done), total: mb(progress.total) })
                      : `${mb(progress?.done ?? 0)} ${lang === 'uz' ? 'MB' : 'МБ'}`}
                  </span>
                  {!ready && progress?.etaS ? <span>{t(lang, 'arEta', { s: String(progress.etaS) })}</span> : null}
                </div>
                <button
                  type="button"
                  className="cta"
                  onClick={() => {
                    if (ready) launch();
                    else pendingRef.current = true;
                  }}
                >
                  {t(lang, ready ? 'arOpenNow' : 'arOpenWhenReady')}
                </button>
                <button type="button" className="txt" onClick={close}>
                  {t(lang, 'cancel')}
                </button>
              </>
            )}

            {step === 'after' && (
              <>
                <div className="ok-ic">
                  <IconCube size={26} sw={2.1} />
                </div>
                <h2 className="title">{t(lang, 'arAfterTitle')}</h2>
                <p className="cap lead">{t(lang, 'arAfterLead')}</p>
                {!agreed && (
                  <button
                    type="button"
                    className="cta"
                    onClick={() => {
                      close();
                      onAgree();
                    }}
                  >
                    {t(lang, 'agree')}
                  </button>
                )}
                <button type="button" className="soft" onClick={close}>
                  {t(lang, 'wantChange')}
                </button>
                <button type="button" className="txt" onClick={launch}>
                  {t(lang, 'arAgain')}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
