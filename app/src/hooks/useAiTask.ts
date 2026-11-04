/** Запуск ИИ-задачи из экрана: подтверждение 402, опрос раз в 2 с, таймер, отмена при уходе с экрана. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { runAiTask, TaskAbortedError } from '../api/tasks';
import type { TaskAccepted } from '../api/types';
import { useT } from '../i18n';
import { askBudget } from '../ui/dialogs';

export function useAiTask() {
  const { lang } = useT();
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const signal = useRef({ aborted: false });
  useEffect(() => () => { signal.current.aborted = true; }, []);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);

  const run = useCallback(async <R,>(start: (confirm: boolean) => Promise<TaskAccepted>): Promise<R | null> => {
    setRunning(true);
    setElapsed(0);
    setError(null);
    try {
      return await runAiTask<R>(start, (id) => api.getTask<R>(id), askBudget(lang), { signal: signal.current });
    } catch (e) {
      if (!(e instanceof TaskAbortedError)) setError(e);
      return null;
    } finally {
      if (!signal.current.aborted) setRunning(false);
    }
  }, [lang]);

  return { run, running, elapsed, error, setError };
}
