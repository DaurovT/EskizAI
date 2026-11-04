/** i18n без зависимостей: словари ru / uz (латиница), переключатель в профиле, язык хранится в телефоне. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Lang } from '../api/types';
import { ru, type Dict, type DictKey } from './ru';
import { uz } from './uz';

export const DICTS: Record<Lang, Dict> = { ru, uz };
export type { DictKey };

export function translate(lang: Lang, key: DictKey, params?: Record<string, string | number>): string {
  let s: string = DICTS[lang][key] ?? ru[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Ключ из строки API (status, action code и т. п.); если ключа нет — запасной текст. */
export function translateDynamic(lang: Lang, key: string, fallback: string): string {
  return key in ru ? translate(lang, key as DictKey) : fallback;
}

interface I18n {
  lang: Lang;
  setLang(l: Lang): void;
  t(key: DictKey, params?: Record<string, string | number>): string;
  td(key: string, fallback: string): string;
}

const Ctx = createContext<I18n | null>(null);
const KEY = 'mebel.lang';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('ru');
  useEffect(() => {
    AsyncStorage.getItem(KEY).then((v) => {
      if (v === 'ru' || v === 'uz') return setLangState(v);
      // первый запуск: язык телефона (узбекский → uz, иначе ru)
      try { if (getLocales()[0]?.languageCode === 'uz') setLangState('uz'); } catch { /* ignore */ }
    }).catch(() => undefined);
  }, []);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    AsyncStorage.setItem(KEY, l).catch(() => undefined);
  }, []);
  const value = useMemo<I18n>(() => ({
    lang,
    setLang,
    t: (k, p) => translate(lang, k, p),
    td: (k, f) => translateDynamic(lang, k, f),
  }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useT(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('I18nProvider missing');
  return v;
}
