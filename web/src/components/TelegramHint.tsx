'use client';

import { useState } from 'react';
import { isAndroid, isIOS, openInExternalBrowser } from '@/lib/env';
import { t } from '@/lib/i18n';
import type { Lang } from '@/lib/share-types';
import { IconInfo } from './icons';

/**
 * AR не запустился (часто — во встроенном браузере Telegram): подсказка
 * «откройте в браузере» в стиле плашки .ban.est.
 */
export function TelegramHint({ lang, inTelegram }: { lang: Lang; inTelegram: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = !inTelegram ? '' : isIOS() ? t(lang, 'tgHintIos') : isAndroid() ? t(lang, 'tgHintAndroid') : t(lang, 'tgHint');
  return (
    <div className="ban est" role="note">
      <span style={{ flex: 'none', marginTop: 1 }}>
        <IconInfo />
      </span>
      <div className="bd" style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ fontWeight: 600 }}>{t(lang, 'arFailed')}</strong>
        {text && <> {text}</>}
        {copied && <div style={{ marginTop: 4 }}>{t(lang, 'linkCopied')}</div>}
      </div>
      {inTelegram && (
        <button
          type="button"
          className="ba"
          onClick={async () => {
            const r = await openInExternalBrowser();
            if (r === 'copied') setCopied(true);
          }}
        >
          {t(lang, 'openInBrowser')}
        </button>
      )}
    </div>
  );
}
