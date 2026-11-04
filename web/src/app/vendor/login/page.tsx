'use client';

import { useRouter } from 'next/navigation';
import { LoginForm } from '@/components/staff/auth';
import { vendorClient } from '@/lib/vendor/api';

export default function VendorLogin() {
  const router = useRouter();
  return (
    <LoginForm
      client={vendorClient}
      title="Кабинет поставщика"
      subtitle="Eskiz AI · вход для сотрудников поставщика"
      onSuccess={(me) => {
        if (me.org.kind !== 'supplier') return 'Это учётная запись платформы — войдите в админку.';
        router.replace('/vendor');
        return null;
      }}
      footer={<div className="muted">Нет доступа или забыли пароль — обратитесь к владельцу кабинета вашей организации.</div>}
    />
  );
}
