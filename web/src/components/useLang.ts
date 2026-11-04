'use client';

import { useCallback, useEffect, useState } from 'react';
import { isLang } from '@/lib/i18n';
import type { Lang } from '@/lib/share-types';

const key = (token: string) => `share-lang:${token}`;

/** Язык страницы: из ссылки (?lang= или язык мастера), выбор клиента запоминаем в браузере. */
export function useLang(token: string, initial: Lang): [Lang, (l: Lang) => void] {
  const [lang, setLangState] = useState<Lang>(initial);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(key(token));
      if (isLang(saved) && saved !== initial) setLangState(saved);
    } catch {
      /* приватный режим и т. п. */
    }
  }, [token, initial]);

  useEffect(() => {
    document.documentElement.lang = lang === 'uz' ? 'uz-Latn' : 'ru';
  }, [lang]);

  const setLang = useCallback(
    (l: Lang) => {
      setLangState(l);
      try {
        window.localStorage.setItem(key(token), l);
      } catch {
        /* ignore */
      }
    },
    [token],
  );
  return [lang, setLang];
}
