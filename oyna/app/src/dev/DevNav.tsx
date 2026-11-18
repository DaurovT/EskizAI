/**
 * Только для разработки (__DEV__): команды из Documents/devnav.txt — сверка экранов с макетом в симуляторе
 * без ручных нажатий (scripts/shot.sh). Команды: `go /route` (replace), `push /route`, `back`,
 * `login +998901234567` (локальный API: ENV=dev, код 00000), `logout`. Файл удаляется после выполнения.
 */
import { File, Paths } from 'expo-file-system';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import { useAuth } from '@/auth/AuthContext';

export function DevNav() {
  const router = useRouter();
  const auth = useAuth();
  useEffect(() => {
    if (!__DEV__) return;
    const f = new File(Paths.document, 'devnav.txt');
    const t = setInterval(async () => {
      try {
        if (!f.exists) return;
        const cmd = (await f.text()).trim();
        f.delete();
        const [op, ...rest] = cmd.split(' ');
        const arg = rest.join(' ');
        if (op === 'go') router.replace(arg as never);
        else if (op === 'push') router.push(arg as never);
        else if (op === 'back') router.back();
        else if (op === 'logout') { await auth.logout(); router.replace('/'); }
        else if (op === 'login') {
          await auth.requestCode(arg).catch(() => undefined); // «слишком часто» — код 00000 всё равно примется
          await auth.verifyCode(arg, '00000');
          router.replace('/');
        }
      } catch (e) {
        console.warn('devnav', e);
      }
    }, 700);
    return () => clearInterval(t);
  }, [router, auth]);
  return null;
}
