'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LoginForm } from '@/components/staff/auth';
import { adminClient, API_URL, ApiError, checkToken } from '@/lib/admin/api';

/** Вход в админку: почта и пароль сотрудника; запасной путь — старый общий токен (X-Admin-Token). */
export default function LoginPage() {
  const router = useRouter();
  const [legacy, setLegacy] = useState(false);

  if (legacy) return <LegacyLogin onBack={() => setLegacy(false)} />;

  return (
    <LoginForm
      client={adminClient}
      title="Вход в админку"
      subtitle="Eskiz AI · сотрудники платформы"
      onSuccess={(me) => {
        if (me.org.kind === 'supplier') return 'Это учётная запись поставщика — войдите в кабинет поставщика.';
        router.replace('/admin');
        return null;
      }}
      footer={
        <>
          <button type="button" className="linkbtn" onClick={() => setLegacy(true)}>
            Войти по токену (переходный режим)
          </button>
          <div className="muted">API: {API_URL}</div>
        </>
      }
    />
  );
}

function LegacyLogin({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [token, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (await checkToken(token.trim())) {
        adminClient.clear();
        adminClient.setLegacy(token.trim());
        router.replace('/admin');
      } else {
        setError('Неверный токен админки');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-login">
      <form onSubmit={submit}>
        <h1>Вход по токену</h1>
        <div className="muted">
          Переходный режим: общий токен ADMIN_TOKEN с сервера, права суперадмина. Нужен, пока не создан первый
          суперадмин (scripts/create_staff.py).
        </div>
        <label>
          Токен админки
          <input type="password" value={token} onChange={(e) => setValue(e.target.value)} autoFocus />
        </label>
        {error && <div className="err">{error}</div>}
        <button type="submit" className="go" disabled={busy || !token.trim()}>
          {busy ? 'Проверяю…' : 'Войти'}
        </button>
        <button type="button" className="linkbtn" onClick={onBack}>
          ← Вход по почте и паролю
        </button>
      </form>
    </div>
  );
}
