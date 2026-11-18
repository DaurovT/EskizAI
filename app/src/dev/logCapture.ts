/** Только для разработки: перехват console.warn/error в файл (импортируется первым в app/_layout.tsx). */
import { File, Paths } from 'expo-file-system';

// предупреждения и ошибки JS → Documents/devlog.txt (читать: scripts/devlog.sh)
if (__DEV__) {
  const log = new File(Paths.document, 'devlog.txt');
  const wrap = (kind: 'warn' | 'error') => {
    const orig = console[kind];
    console[kind] = (...args: unknown[]) => {
      try {
        const line = `${new Date().toISOString().slice(11, 19)} ${kind} ${args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
        if (!log.exists) log.create();
        const prev = log.textSync();
        log.write((prev + line).slice(-40000));
      } catch { /* журнал — не ломаем приложение */ }
      orig(...args);
    };
  };
  wrap('warn');
  wrap('error');
}

