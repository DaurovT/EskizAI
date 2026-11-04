'use client';

import { Box } from '@/components/admin/ui';
import { ChangePasswordForm } from '@/components/staff/auth';
import { useSession } from '@/lib/staff/hooks';
import { vendorClient } from '@/lib/vendor/api';

export default function VendorPassword() {
  const session = useSession();
  return (
    <>
      <h1>Смена пароля</h1>
      <Box>
        <ChangePasswordForm client={vendorClient} onDone={() => session?.reload()} />
      </Box>
    </>
  );
}
