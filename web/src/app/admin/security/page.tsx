'use client';

import { useState } from 'react';
import { Box, Tag } from '@/components/admin/ui';
import { MfaDisable, MfaSetup, SessionsPanel } from '@/components/staff/security';
import { adminClient } from '@/lib/admin/api';
import { needsMfaSetup } from '@/lib/staff/client';
import { useSession } from '@/lib/staff/hooks';

/** Безопасность своей учётной записи (§4a): 2FA и сессии. */
export default function SecurityPage() {
  const session = useSession();
  const [mode, setMode] = useState<'idle' | 'enable' | 'disable'>('idle');
  if (!session) return null;
  if (session.legacy) {
    return (
      <>
        <h1>Безопасность</h1>
        <Box>
          <p className="muted">
            Вы вошли по общему токену админки (переходный режим): у этого входа нет пароля, 2FA и сессий. Создайте
            суперадмина (scripts/create_staff.py) и войдите по почте и паролю.
          </p>
        </Box>
      </>
    );
  }
  const me = session.me;
  const enabled = me.mfa_enabled === true;
  const required = needsMfaSetup({ ...me, mfa_enabled: false });
  return (
    <>
      <h1>Безопасность</h1>
      <Box title="Двухфакторный вход (2FA)">
        <p>
          Статус: {enabled ? <Tag color="green">включена</Tag> : <Tag color="yellow">выключена</Tag>}
          {required && <span className="muted"> · для вашей роли обязательна</span>}
        </p>
        {!enabled && mode !== 'enable' && (
          <button type="button" className="b primary" onClick={() => setMode('enable')}>
            Включить 2FA
          </button>
        )}
        {!enabled && mode === 'enable' && (
          <MfaSetup
            client={adminClient}
            onEnabled={() => {
              setMode('idle');
              session.reload();
            }}
          />
        )}
        {enabled && !required && mode !== 'disable' && (
          <button type="button" className="b danger" onClick={() => setMode('disable')}>
            Отключить 2FA
          </button>
        )}
        {enabled && required && <p className="muted">Отключить 2FA для этой роли нельзя. Новый телефон — попросите другого суперадмина сбросить 2FA.</p>}
        {enabled && mode === 'disable' && (
          <MfaDisable
            client={adminClient}
            onDone={() => {
              setMode('idle');
              session.reload();
            }}
          />
        )}
      </Box>
      <Box title="Мои сессии">
        <p className="muted">Входы по устройствам. «Завершить все» выйдет везде, включая этот браузер.</p>
        <SessionsPanel userId={me.id} self />
      </Box>
    </>
  );
}
