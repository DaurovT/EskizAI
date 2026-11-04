/**
 * Куда открыть приложение по тапу на push (PRD §19). Сервер кладёт в data: kind, project_id и, по событию,
 * order_id / screen. Без React — покрыто тестами.
 */
export interface PushData {
  kind?: string; project_id?: string; order_id?: string; screen?: string; [k: string]: unknown;
}

export function routeForPush(data: PushData | null | undefined): string | null {
  if (!data) return null;
  if (data.order_id) return `/order/${data.order_id}`;
  const p = data.project_id;
  if (data.screen === 'profile' || data.kind === 'limit_one_left') return '/profile';
  if (!p) return null;
  switch (data.screen) {
    case 'price_requests': return `/project/${p}/price-requests`;
    case 'nonstandard': return `/project/${p}/nonstandard`;
    case 'estimate': return `/project/${p}/estimate`;
    default: return data.kind === 'model_ready' ? `/project/${p}/editor` : `/project/${p}`;
  }
}
