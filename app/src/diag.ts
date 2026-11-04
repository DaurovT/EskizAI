/**
 * Диагностика на устройстве без отладчика (EXPO_PUBLIC_DIAG=1, по умолчанию выключена).
 *
 * - Журнал Documents/diag.log (пишется из JS, новый файл на каждый запуск):
 *   версия GL, размер буфера, ответы геттеров WebGL, draw calls / треугольники, глобальные JS-ошибки,
 *   необработанные промисы, console.error.
 * - В режиме DIAG фатальная JS-ошибка только пишется в журнал и не роняет приложение
 *   (иначе журнал не прочитать). Без DIAG всё как обычно.
 * - Забрать журнал с iPhone:
 *   xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
 *     --domain-identifier uz.mebel.master --source Documents/diag.log --destination ./diag.log
 */
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { API_URL, DIAG, MOCK } from './config';

export { DIAG };

let file: File | null = null;
const listeners = new Set<(line: string) => void>();
let lastError = '';

function stamp(): string {
  return new Date().toISOString();
}

/** Строка в Documents/diag.log (и в console.log). Без DIAG ничего не делает. */
export function diagLog(line: string): void {
  if (!DIAG) return;
  const text = `${stamp()} ${line}`;
  try {
    if (!file) {
      file = new File(Paths.document, 'diag.log');
      file.writeSync(`${text}\n`); // новый запуск — новый журнал
    } else {
      file.writeSync(`${text}\n`, { append: true });
    }
  } catch {
    /* журнал не важнее приложения */
  }
  // eslint-disable-next-line no-console
  console.log(`[diag] ${line}`);
  for (const l of listeners) l(line);
}

/** Последняя пойманная JS-ошибка (для плашки). */
export function diagLastError(): string {
  return lastError;
}

export function onDiagError(fn: (line: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}${e.stack ? ` | ${e.stack.split('\n').slice(0, 4).join(' / ')}` : ''}`;
  try {
    return typeof e === 'string' ? e : JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function recordError(kind: string, e: unknown): void {
  lastError = `${kind}: ${describe(e)}`.slice(0, 600);
  diagLog(`ERROR ${lastError}`);
}

let installed = false;

/** Перехват глобальных ошибок. Вызывается один раз при старте (app/_layout.tsx). */
export function installDiag(): void {
  if (!DIAG || installed) return;
  installed = true;
  diagLog(`start os=${Platform.OS} ${String(Platform.Version)} api=${API_URL || '-'} mock=${MOCK ? 1 : 0} hermes=${typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === 'object' ? 1 : 0}`);

  type Handler = (e: unknown, isFatal?: boolean) => void;
  const EU = (globalThis as { ErrorUtils?: { getGlobalHandler(): Handler; setGlobalHandler(h: Handler): void } }).ErrorUtils;
  if (EU) {
    const prev = EU.getGlobalHandler();
    EU.setGlobalHandler((e, isFatal) => {
      recordError(isFatal ? 'fatal' : 'error', e);
      // Нефатальные — дальше по цепочке (LogBox в dev). Фатальные в DIAG не передаём: приложение не падает.
      if (!isFatal) prev?.(e, isFatal);
    });
  }

  const hermes = (globalThis as {
    HermesInternal?: { enablePromiseRejectionTracker?: (o: { allRejections: boolean; onUnhandled: (id: number, e: unknown) => void }) => void };
  }).HermesInternal;
  try {
    hermes?.enablePromiseRejectionTracker?.({ allRejections: true, onUnhandled: (_id, e) => recordError('unhandled promise', e) });
  } catch {
    /* трекер уже включён (dev) */
  }

  // eslint-disable-next-line no-console
  const origError = console.error;
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => {
    diagLog(`console.error ${args.map(describe).join(' ').slice(0, 600)}`);
    origError(...args);
  };
}
