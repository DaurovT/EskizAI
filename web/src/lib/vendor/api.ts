'use client';

/** Клиент API кабинета поставщика: свои ключи хранилища, тот же механизм входа, что у админки. */
import { createStaffClient } from '@/lib/staff/client';

export const vendorClient = createStaffClient({
  scope: 'vendor',
  loginPath: () => '/vendor/login',
  passwordPath: () => '/vendor/password',
  securityPath: () => '/vendor/security',
});
