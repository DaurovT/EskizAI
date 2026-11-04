'use client';

import Link from 'next/link';
import { Empty, Loading, Msg, Tag } from '@/components/admin/ui';
import { post } from '@/lib/admin/api';
import { sum } from '@/lib/admin/format';
import { useAction, useApi } from '@/lib/admin/useApi';

interface Rec {
  id: string;
  run_id: string;
  sku: string | null;
  name: string;
  price: number | null;
  matched_item_name: string | null;
  old_price: number | null;
  change_pct: number | null;
}

export default function ReviewPage() {
  const { data, error, loading, reload } = useApi<Rec[]>('/admin/catalog/review-queue');
  const act = useAction();
  return (
    <>
      <h1>Проверка цен: изменения больше 15%</h1>
      <p className="muted">Подтверждённые изменения публикуются кнопкой «Опубликовать» в карточке запуска парсера.</p>
      <Msg message={act.message} />
      <Loading error={error} loading={loading && !data} />
      {data &&
        (data.length === 0 ? (
          <Empty>Очередь пуста</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Позиция</th>
                <th className="num">Было</th>
                <th className="num">Стало</th>
                <th className="num">Δ</th>
                <th>Запуск</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((x) => (
                <tr key={x.id}>
                  <td>
                    {x.matched_item_name ?? x.name}
                    <div className="muted">
                      {x.sku} · в прайсе: {x.name}
                    </div>
                  </td>
                  <td className="num">{sum(x.old_price)}</td>
                  <td className="num">{sum(x.price)}</td>
                  <td className="num">
                    <Tag color="red">{x.change_pct === null ? '—' : `${x.change_pct > 0 ? '+' : ''}${x.change_pct}%`}</Tag>
                  </td>
                  <td>
                    <Link href={`/admin/catalog/runs/${x.run_id}`}>открыть</Link>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="b primary"
                      type="button"
                      disabled={act.busy}
                      onClick={() => void act.run(() => post(`/admin/catalog/raw-records/${x.id}/review`, { action: 'approve' }), 'Подтверждено').then(reload)}
                    >
                      Подтвердить
                    </button>{' '}
                    <button
                      className="b danger"
                      type="button"
                      disabled={act.busy}
                      onClick={() => void act.run(() => post(`/admin/catalog/raw-records/${x.id}/review`, { action: 'reject' }), 'Отклонено').then(reload)}
                    >
                      Отклонить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </>
  );
}
