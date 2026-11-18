/** Order — макеты: Order, OrderNew, OrderBlock, OrderAgreed (docs/design). Заглушка: экран ещё собирается. */
import { Screen, Txt } from '@/ui/kit';

export default function Order() {
  return <Screen><Txt w={600} size={18} style={{ padding: 20 }}>Order</Txt></Screen>;
}
