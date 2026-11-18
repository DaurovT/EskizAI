/** Orders — макеты: Orders, OrdersEmpty, OrdersOffline (docs/design). Заглушка: экран ещё собирается. */
import { Screen, Txt } from '@/ui/kit';

export default function Orders() {
  return <Screen><Txt w={600} size={18} style={{ padding: 20 }}>Orders</Txt></Screen>;
}
