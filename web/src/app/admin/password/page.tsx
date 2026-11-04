'use client';

import { Box } from '@/components/admin/ui';
import { ChangePasswordForm } from '@/components/staff/auth';
import { adminClient } from '@/lib/admin/api';
import { useSession } from '@/lib/staff/hooks';

export default function PasswordPage() {
  const session = useSession();
  return (
    <>
      <h1>Смена пароля</h1>
      <Box>
        {session?.legacy ? (
          <div className="muted">Вы вошли по общему токену — пароля нет. Войдите по почте и паролю.</div>
        ) : (
          <ChangePasswordForm client={adminClient} onDone={() => session?.reload()} />
        )}
      </Box>
    </>
  );
}
