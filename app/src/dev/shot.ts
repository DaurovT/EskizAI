/**
 * Снимки экранов для сверки с макетом (только DIAG и dev-сборки, в сторе этого нет).
 * mebelmaster://shot?to=/project/p1/estimate&name=Estimate&wait=2500 → открыть экран, подождать, сохранить
 * Documents/shots/<name>.png; забрать: devicectl device copy from … --source Documents/shots/<name>.png
 */
import { LogBox } from 'react-native';
import { SHOTS_MODE } from '../config';
import { DIAG, diagLog } from '../diag';

export const SHOTS = DIAG || __DEV__;
// жёлтые плашки предупреждений dev-сборки не должны попадать в снимки
if (__DEV__) LogBox.ignoreAllLogs(true);
if (__DEV__ && SHOTS_MODE) LogBox.uninstall();

/** Журнал снимков: Documents/shots/log.txt (журнал JS в Metro в RN 0.88 не выводится). */
export function shotLog(line: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { File, Directory, Paths } = require('expo-file-system') as typeof import('expo-file-system');
    const dir = new Directory(Paths.document, 'shots');
    if (!dir.exists) dir.create();
    const f = new File(dir, 'log.txt');
    const prev = f.exists ? f.textSync() : '';
    f.write(prev + `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* журнал не критичен */
  }
  diagLog(line);
}

export function scheduleShot(name: string, waitMs = 2500): void {
  if (!SHOTS) return;
  setTimeout(() => { takeShot(name).catch((e) => { shotLog(`shot ${name} failed: ${String(e?.message ?? e)}`); }); }, waitMs);
}

export async function takeShot(name: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { captureScreen } = require('react-native-view-shot') as typeof import('react-native-view-shot');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { File, Directory, Paths } = require('expo-file-system') as typeof import('expo-file-system');
  const tmp = await captureScreen({ format: 'png', quality: 1, result: 'tmpfile' });
  const dir = new Directory(Paths.document, 'shots');
  if (!dir.exists) dir.create();
  const out = new File(dir, `${name.replace(/[^\w.-]/g, '_')}.png`);
  if (out.exists) out.delete();
  new File(tmp).copy(out);
  shotLog(`shot ${name} saved`);
  return out.uri;
}

/**
 * dev + EXPO_PUBLIC_SHOTS=1: управление симулятором без тапов. `simctl openurl` показывает системное
 * «Открыть в приложении?», нажать его без GUI нельзя — поэтому команды кладутся в Documents/devnav.txt
 * (по одной на строку): `login` (мок: вход + перезагрузка), `go /path` (replace), `push /path`, `back`,
 * `eval <js>`. В релизе и без SHOTS ничего не делает.
 */
function startDevNav(): void {
  const g = globalThis as { __devNav?: ReturnType<typeof setInterval> };
  if (g.__devNav) clearInterval(g.__devNav);
  let busy = false;
  g.__devNav = setInterval(async () => {
    if (busy) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
      const f = new File(Paths.document, 'devnav.txt');
      if (!f.exists) return;
      busy = true;
      const lines = f.textSync().split('\n').map((s) => s.trim()).filter(Boolean);
      f.delete();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { router } = require('expo-router') as typeof import('expo-router');
      for (const line of lines) {
        const sp = line.indexOf(' ');
        const cmd = sp < 0 ? line : line.slice(0, sp);
        const arg = sp < 0 ? '' : line.slice(sp + 1).trim();
        if (cmd === 'login') {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { api, tokenStore } = require('../api') as typeof import('../api');
          await api.requestCode('+998901234567', 'telegram');
          const tk = await api.verifyCode({ phone: '+998901234567', code: '00000', device_id: 'dev-sim', platform: 'ios', push_token: null });
          await tokenStore.set({ access: tk.access_token, refresh: tk.refresh_token });
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          (require('react-native') as typeof import('react-native')).DevSettings.reload();
        } else if (cmd === 'go') router.replace(arg as never);
        else if (cmd === 'push') router.push(arg as never);
        else if (cmd === 'back') router.back();
        else if (cmd === 'eval') new Function(arg)();
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (e) {
      shotLog(`devnav: ${String((e as Error)?.message ?? e)}`);
    } finally {
      busy = false;
    }
  }, 400);
}
if (__DEV__ && SHOTS_MODE) startDevNav();
