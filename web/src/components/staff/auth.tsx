'use client';

/** Вход сотрудника, смена пароля, показ временного пароля — общие для админки и кабинета поставщика. */
import { useState, type ReactNode } from 'react';
import { ApiError, type StaffClient, type StaffMe } from '@/lib/staff/client';

export const MIN_PASSWORD = 10;

export function LoginForm({
  client,
  title,
  subtitle,
  onSuccess,
  footer,
}: {
  client: StaffClient;
  title: string;
  subtitle?: ReactNode;
  /** Вернуть строку — это ошибка (например, «учётка не того кабинета»), вход отменяется. */
  onSuccess: (me: StaffMe) => string | null | void;
  footer?: ReactNode;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function finish(me: StaffMe) {
    const problem = onSuccess(me);
    if (problem) {
      await client.logout();
      setMfaToken(null);
      setError(problem);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) {
        await finish(await client.loginMfa(mfaToken, code));
      } else {
        const r = await client.login(email, password);
        if (r.kind === 'mfa') {
          setMfaToken(r.mfaToken);
          setCode('');
        } else {
          await finish(r.me);
        }
      }
    } catch (err) {
      // Срок mfa_token истёк — заново с почты и пароля
      if (mfaToken && err instanceof ApiError && err.status === 401 && err.code !== 'invalid_mfa_code') {
        setMfaToken(null);
      }
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (mfaToken) {
    return (
      <div className="adm-login">
        <form onSubmit={submit}>
          <h1>Код подтверждения</h1>
          <div className="muted">
            Введите 6-значный код из приложения-аутентификатора для {email.trim().toLowerCase()} или один из резервных кодов.
          </div>
          <label>
            Код
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              required
            />
          </label>
          {error && <div className="err">{error}</div>}
          <button type="submit" className="go" disabled={busy || code.replace(/\s/g, '').length < 6}>
            {busy ? 'Проверяю…' : 'Подтвердить'}
          </button>
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              setMfaToken(null);
              setError(null);
            }}
          >
            ← Другая учётная запись
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="adm-login">
      <form onSubmit={submit}>
        <h1>{title}</h1>
        {subtitle && <div className="muted">{subtitle}</div>}
        <label>
          Почта
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </label>
        <label>
          Пароль
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <div className="err">{error}</div>}
        <button type="submit" className="go" disabled={busy || !email.trim() || !password}>
          {busy ? 'Вхожу…' : 'Войти'}
        </button>
        {footer}
      </form>
    </div>
  );
}

export function ChangePasswordForm({
  client,
  forced,
  onDone,
  onLogout,
}: {
  client: StaffClient;
  forced?: boolean;
  onDone: () => void;
  onLogout?: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const problem =
    next && next.length < MIN_PASSWORD
      ? `Новый пароль — не короче ${MIN_PASSWORD} символов`
      : repeat && next !== repeat
        ? 'Пароли не совпадают'
        : next && next === current
          ? 'Новый пароль совпадает с текущим'
          : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      await client.changePassword(current, next);
      setOk(true);
      setCurrent('');
      setNext('');
      setRepeat('');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="pw-form">
      {forced && (
        <div className="msg warn">Вы вошли с временным паролем. Задайте свой пароль, чтобы продолжить работу.</div>
      )}
      <label>
        {forced ? 'Временный пароль' : 'Текущий пароль'}
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label>
        Новый пароль (не короче {MIN_PASSWORD} символов)
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      </label>
      <label>
        Повторите новый пароль
        <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
      </label>
      {(problem || error) && <div className="err">{problem ?? error}</div>}
      {ok && !forced && <div className="msg ok">Пароль изменён</div>}
      <button type="submit" className="go" disabled={busy || !current || !next || !repeat || Boolean(problem)}>
        {busy ? 'Сохраняю…' : 'Сменить пароль'}
      </button>
      {onLogout && (
        <button type="button" className="b" onClick={onLogout}>
          Выйти
        </button>
      )}
    </form>
  );
}

/** Временный пароль: показывается один раз, с кнопкой «Скопировать». */
export function TempPassword({ email, password, onClose }: { email?: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
      window.prompt('Скопируйте пароль', password);
    }
  }
  return (
    <div className="temp-pass">
      <div>
        <b>Временный пароль{email ? ` для ${email}` : ''}</b>
      </div>
      <div className="temp-pass-row">
        <code>{password}</code>
        <button type="button" className="b primary" onClick={() => void copy()}>
          {copied ? 'Скопировано ✓' : 'Скопировать'}
        </button>
        <button type="button" className="b" onClick={onClose}>
          Закрыть
        </button>
      </div>
      <div className="muted">
        Пароль показывается один раз. Передайте его сотруднику лично — при первом входе он задаст свой пароль.
      </div>
    </div>
  );
}
