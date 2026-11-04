'use client';

import dynamic from 'next/dynamic';
import type { ViewerModel } from '@mebel/viewer';
import { t } from '@/lib/i18n';
import type { Lang } from '@/lib/share-types';

const Inner = dynamic(() => import('./Viewer3DInner'), {
  ssr: false,
  loading: () => null,
});

/** Сцена 3D (макет WEB-1: бежевая плашка 270 px, кнопки «Открыть двери» и «Размеры»). */
export function Viewer3D({ model, lang }: { model: ViewerModel; lang: Lang }) {
  return (
    <div className="stage" role="img" aria-label="3D">
      <noscript>
        <div className="stage-status">{t(lang, 'no3d')}</div>
      </noscript>
      <Inner model={model} lang={lang} />
    </div>
  );
}
