'use client';

import { LANGS, t } from '@/lib/i18n';
import type { Lang } from '@/lib/share-types';

export function LangSwitch({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  return (
    <div className="lang" role="group" aria-label="Язык / Til">
      {LANGS.map((l) => (
        <button key={l} type="button" aria-pressed={l === lang} onClick={() => onChange(l)}>
          {t(l, 'langName')}
        </button>
      ))}
    </div>
  );
}
