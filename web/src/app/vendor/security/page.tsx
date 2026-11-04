'use client';

import { useState } from 'react';
import { Box, Tag } from '@/components/admin/ui';
import { MfaDisable, MfaSetup, SessionsPanel } from '@/components/staff/security';
import { useSession } from '@/lib/staff/hooks';
import { vendorClient } from '@/lib/vendor/api';

/** Своя безопасность: вход по коду из приложения (по желанию) и сессии. */
export default function VendorSecurity() {
  const session = useSession();
  const [mode, setMode] = useState<'idle' | 'setup' | 'disable'>('idle');
  if (!session) return null;
  const { me } = session;
  const done = () => {
    setMode('idle');
    session.reload();
  };
  return (
    <>
      <h1>Безопасность</h1>
      <Box title="Вход по коду из приложения (2FA)">
        <p>
          Статус: {me.mfa_enabled ? <Tag color="green">включён</Tag> : <Tag>выключен</Tag>}
          {me.mfa_required && <span className="muted"> · обязателен для вашей роли</span>}
        </p>
        {mode === 'idle' && !me.mfa_enabled && (
          <button type="button" className="b primary" onClick={() => setMode('setup')}>
            Включить
          </button>
        )}
        {mode === 'idle' && me.mfa_enabled && !me.mfa_required && (
          <button type="button" className="b" onClick={() => setMode('disable')}>
            Отключить…
          </button>
        )}
        {mode === 'setup' && <MfaSetup client={vendorClient} onEnabled={done} />}
        {mode === 'disable' && <MfaDisable client={vendorClient} onDone={done} />}
      </Box>
      <Box title="Мои сессии">
        <SessionsPanel userId={me.id} self />
      </Box>
    </>
  );
}
