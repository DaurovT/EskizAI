/** SCR-00a: онбординг показываем один раз — при первом запуске, до входа. Флаг — в телефоне. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

const KEY = 'mebel.onboarded';
let seen: boolean | null = null;
const subs = new Set<(v: boolean) => void>();
let loading: Promise<void> | null = null;

function load() {
  if (!loading) {
    loading = AsyncStorage.getItem(KEY)
      .then((v) => { seen = v === '1'; })
      .catch(() => { seen = true; }) // хранилище недоступно — не держим мастера на онбординге
      .then(() => subs.forEach((f) => f(seen!)));
  }
  return loading;
}

export function markOnboarded() {
  seen = true;
  subs.forEach((f) => f(true));
  AsyncStorage.setItem(KEY, '1').catch(() => undefined);
}

/** null — ещё читаем из телефона. */
export function useOnboarded(): boolean | null {
  const [v, setV] = useState<boolean | null>(seen);
  useEffect(() => {
    subs.add(setV);
    if (seen === null) load(); else setV(seen);
    return () => { subs.delete(setV); };
  }, []);
  return v;
}
