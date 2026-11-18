/** Quote — макеты: Quote, QuoteBlocked, QuoteSent (docs/design). Заглушка: экран ещё собирается. */
import { Screen, Txt } from '@/ui/kit';

export default function Quote() {
  return <Screen><Txt w={600} size={18} style={{ padding: 20 }}>Quote</Txt></Screen>;
}
