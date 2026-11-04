'use client';

import { StaffManager } from '@/components/staff/StaffManager';

export default function VendorStaff() {
  return (
    <>
      <h1>Сотрудники</h1>
      <p className="muted">
        Конструкторы работают с заказами, перепиской, исправлениями и возвратами. Владелец видит всё: деньги, аналитику,
        прайс, сотрудников и настройки.
      </p>
      <StaffManager mode="vendor" />
    </>
  );
}
