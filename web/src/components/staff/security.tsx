'use client';

/** Безопасность сотрудника (§4a): настройка 2FA (QR + резервные коды), отключение, сессии. */
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { ApiError, itemsOf, type StaffClient } from '@/lib/staff/client';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';
import { dt } from '@/lib/admin/format';
import { Empty, Loading, Msg } from '@/components/admin/ui';

export function BackupCodes({ codes, onDone }: { codes: string[]; onDone?: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  return (
    <div className="temp-pass">
      <b>Резервные коды</b>
      <div className="muted">
        Каждый код срабатывает один раз — если телефон с приложением недоступен. Сохраните их в надёжном месте: больше они
        не покажутся.
      </div>
      <pre style={{ fontSize: 15, columns: 2, background: '#fff' }}>{text}</pre>
      <div className="temp-pass-row">
        <button
          type="button"
          className="b"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => window.prompt('Скопируйте коды', text),
            )
          }
        >
          {copied ? 'Скопировано ✓' : 'Скопировать'}
        </button>
        <button
          type="button"
          className="b"
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            a.download = 'eskiz-backup-codes.txt';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }}
        >
          Скачать .txt
        </button>
        {onDone && (
          <button type="button" className="b primary" onClick={onDone}>
            Я сохранил коды
          </button>
        )}
      </div>
    </div>
  );
}

/** Включение 2FA: QR для приложения-аутентификатора → код → резервные коды. */
export function MfaSetup({ client, onEnabled }: { client: StaffClient; onEnabled: () => void }) {
  const [setup, setSetup] = useState<{ otpauth_url: string; secret: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const act = useAction();
  // Один запрос setup на экран: повторный (StrictMode, двойной рендер) выдал бы новый секрет и разошёлся с QR
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void act.run(async () => {
      const s = await client.post<{ otpauth_url: string; secret: string }>('/staff/me/mfa/setup');
      setSetup(s);
      setQr(await QRCode.toDataURL(s.otpauth_url, { margin: 1, width: 220 }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  if (codes) return <BackupCodes codes={codes} onDone={onEnabled} />;

  return (
    <div className="pw-form" style={{ maxWidth: 420 }}>
      <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
        <li>Установите приложение-аутентификатор (Google Authenticator, Microsoft Authenticator, 1Password…).</li>
        <li>Отсканируйте QR-код или введите ключ вручную.</li>
        <li>Введите 6-значный код из приложения.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {qr && <img src={qr} alt="QR-код для приложения-аутентификатора" width={220} height={220} />}
      {setup && (
        <div className="muted" style={{ wordBreak: 'break-all' }}>
          Ключ: <code>{setup.secret}</code>
        </div>
      )}
      <label>
        Код из приложения
        <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <Msg message={act.message} />
      <button
        type="button"
        className="go"
        disabled={act.busy || !setup || code.replace(/\s/g, '').length < 6}
        onClick={() =>
          void act.run(async () => {
            const r = await client.post<{ backup_codes?: string[] }>('/staff/me/mfa/enable', { code: code.replace(/\s/g, '') });
            const cached = client.cachedMe();
            if (cached) client.setCachedMe({ ...cached, mfa_enabled: true });
            if (r?.backup_codes?.length) setCodes(r.backup_codes);
            else onEnabled();
          })
        }
      >
        Включить 2FA
      </button>
    </div>
  );
}

export function MfaDisable({ client, onDone }: { client: StaffClient; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const act = useAction();
  return (
    <div className="pw-form">
      <label>
        Пароль
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label>
        Код из приложения или резервный код
        <input autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <Msg message={act.message} />
      <button
        type="button"
        className="b danger"
        disabled={act.busy || !password || !code}
        onClick={() =>
          void act.run(async () => {
            await client.post('/staff/me/mfa/disable', { password, code: code.replace(/\s/g, '') });
            const cached = client.cachedMe();
            if (cached) client.setCachedMe({ ...cached, mfa_enabled: false });
            onDone();
          }, '2FA отключена')
        }
      >
        Отключить 2FA
      </button>
    </div>
  );
}

export interface StaffSession {
  id: string;
  created_at?: string | null;
  last_seen_at?: string | null;
  last_used_at?: string | null;
  revoked_at?: string | null;
  active?: boolean;
  ip?: string | null;
  user_agent?: string | null;
  current?: boolean;
}

/** Сессии сотрудника (по refresh-токенам) и «завершить все». */
export function SessionsPanel({ userId, self }: { userId: string; self?: boolean }) {
  // Свои сессии — /staff/me/sessions (текущая помечена и при «завершить все» остаётся)
  const base = self ? '/staff/me/sessions' : `/staff/users/${userId}/sessions`;
  const { data, error, loading, reload } = useApi<StaffSession[] | { items: StaffSession[] }>(base);
  const act = useAction();
  const rows = itemsOf(data);
  return (
    <>
      <Loading error={error} loading={loading && !data} />
      <Msg message={act.message} />
      {data &&
        (rows.length === 0 ? (
          <Empty>Активных сессий нет</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Вход</th>
                  <th>Последняя активность</th>
                  <th>Статус</th>
                  <th>IP</th>
                  <th>Браузер</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {dt(s.created_at)} {s.current && <span className="tag green">эта</span>}
                    </td>
                    <td>{dt(s.last_seen_at ?? s.last_used_at)}</td>
                    <td>
                      {s.active === false || s.revoked_at ? (
                        <span className="muted">завершена {dt(s.revoked_at)}</span>
                      ) : (
                        <span className="tag green">активна</span>
                      )}
                    </td>
                    <td>{s.ip ?? '—'}</td>
                    <td style={{ maxWidth: 360, wordBreak: 'break-word' }}>{s.user_agent ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      <EndSessionsButton path={base} self={self} onDone={reload} run={act.run} busy={act.busy} />
    </>
  );
}

function EndSessionsButton({
  path,
  self,
  onDone,
  run,
  busy,
}: {
  path: string;
  self?: boolean;
  onDone: () => void;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
  busy: boolean;
}) {
  const client = useClient();
  return (
    <div className="toolbar" style={{ marginTop: 10 }}>
      <button
        type="button"
        className="b danger"
        disabled={busy}
        onClick={() => {
          if (!window.confirm(self ? 'Завершить все сессии, кроме этой? На других устройствах придётся войти заново.' : 'Завершить все сессии сотрудника?'))
            return;
          void run(async () => {
            await client.del(path);
            onDone();
          }, 'Сессии завершены');
        }}
      >
        {self ? 'Завершить все, кроме этой' : 'Завершить все сессии'}
      </button>
    </div>
  );
}

export function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : String(e);
}
