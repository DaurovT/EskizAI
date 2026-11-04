'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { API_URL, ApiError, checkToken, setToken } from '@/lib/admin/api';

export default function LoginPage() {
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
        setToken(token.trim());
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
        <h1 style={{ margin: 0, fontSize: 20 }}>Вход в админку</h1>
        <label>
          Токен админки
          <input
            type="password"
            value={token}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            style={{ width: '100%', padding: 8, marginTop: 4, border: '1px solid #e1e4e8', borderRadius: 6 }}
          />
        </label>
        {error && <div style={{ color: '#b42318' }}>{error}</div>}
        <button
          type="submit"
          disabled={busy || !token.trim()}
          style={{ padding: 10, borderRadius: 8, border: 0, background: '#1f6f5c', color: '#fff', cursor: 'pointer' }}
        >
          {busy ? 'Проверяю…' : 'Войти'}
        </button>
        <div style={{ fontSize: 12, color: '#6a717d' }}>
          Временно — общий токен (ADMIN_TOKEN на сервере). API: {API_URL}
        </div>
      </form>
    </div>
  );
}
