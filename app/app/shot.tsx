/** Служебный маршрут снимков (DIAG/dev): открывает экран `to` и через `wait` мс сохраняет скриншот `name`.
 *  `login=1` (только dev + мок): сначала войти тестовым номером (код 00000), чтобы сверять экраны без ручного входа. */
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { api } from '../src/api';
import { SHOTS, scheduleShot, shotLog } from '../src/dev/shot';
import { useSession } from '../src/state/session';
import { systemStore } from '../src/state/appStatus';

export default function ShotRoute() {
  const { to = '/', name = 'shot', wait, login, sys } = useLocalSearchParams<{ to?: string; name?: string; wait?: string; login?: string; sys?: string }>();
  const { status, signIn } = useSession();
  useEffect(() => {
    if (!SHOTS) return;
    (async () => {
      // login=1 — тестовый номер; login=+998XXXXXXXXX — войти этим номером даже поверх сессии (мок: …0000 — приглашение, …0001 — устаревшее)
      const phone = login?.startsWith('+') ? login : '+998901234567';
      if (__DEV__ && login && api.mode === 'mock' && (status !== 'signedIn' || login.startsWith('+'))) {
        await api.requestCode(phone);
        await signIn(await api.verifyCode({ phone, code: '00000' }));
      }
      // sys=required|optional|maintenance — экран SCR-45 поверх приложения (SystemStates.dc.html)
      if (__DEV__ && sys) {
        systemStore.set({
          screen: sys === 'maintenance' ? { kind: 'maintenance', until: new Date(Date.now() + 40 * 60_000).toISOString(), message: { ru: '', uz: '' } }
            : sys === 'optional' ? { kind: 'optional', storeUrl: 'https://apps.apple.com', version: '1.1.0', notes: { ru: ['Угловые кухни в редакторе', 'Замер кухни по стенам'], uz: ['Burchakli oshxonalar muharrirda', 'Oshxonani devorlar bo‘yicha o‘lchash'] } }
              : sys === 'none' ? null : { kind: 'required', storeUrl: 'https://apps.apple.com' },
        });
      }
      shotLog(`shot route: ${name} → ${to}`);
      if (name !== '-') scheduleShot(String(name), Number(wait) || 2500);
      router.replace(String(to) as never);
    })().catch((e) => shotLog(`shot route failed: ${String(e?.message ?? e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, name, wait, login, sys]);
  if (!SHOTS) return <Redirect href="/" />;
  return null;
}
