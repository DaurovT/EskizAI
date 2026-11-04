'use client';

/** Возвраты и рекламации по всем заказам поставщика; владелец подтверждает суммы возврата. */
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Empty, Loading } from '@/components/admin/ui';
import { ReturnCard } from '@/components/vendor/order/Returns';
import type { OrderReturn } from '@/components/vendor/order/types';
import { itemsOf, qs } from '@/lib/staff/client';
import { useApi } from '@/lib/staff/hooks';
import { RETURN_STATUS_LABEL } from '@/lib/vendor/format';

function Returns() {
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? 'open');
  const { data, error, loading, reload } = useApi<OrderReturn[] | { items: OrderReturn[] }>(`/vendor/returns${qs({ status })}`);
  const rows = itemsOf(data);
  return (
    <>
      <h1>Возвраты и рекламации</h1>
      <p className="muted">
        Рекламацию открывает мастер в приложении или конструктор в карточке оплаченного заказа. Возврат денег вступает в силу
        после подтверждения суммы владельцем.
      </p>
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Все</option>
          {Object.entries(RETURN_STATUS_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && (rows.length === 0 ? <Empty>Нет рекламаций</Empty> : rows.map((r) => <ReturnCard key={r.id} r={r} onDone={reload} showOrder />))}
    </>
  );
}

export default function ReturnsPage() {
  return (
    <Suspense fallback={<div className="muted">Загрузка…</div>}>
      <Returns />
    </Suspense>
  );
}
