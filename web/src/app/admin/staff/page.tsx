'use client';

import { StaffManager } from '@/components/staff/StaffManager';

/** Сотрудники платформы и поставщиков (§3, §4a): роли, отключение, сброс пароля и 2FA, сессии. */
export default function StaffPage() {
  return (
    <>
      <h1>Сотрудники</h1>
      <p className="muted">
        Сотрудники платформы и поставщиков. Последнего активного суперадмина нельзя отключить или понизить. Сброс 2FA — с
        причиной (пишется в журнал).
      </p>
      <StaffManager mode="platform" />
    </>
  );
}
