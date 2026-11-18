/** Kit — макеты: Kit, GlassFormula (docs/design). Заглушка: экран ещё собирается. */
import { Screen, Txt } from '@/ui/kit';

export default function Kit() {
  return <Screen><Txt w={600} size={18} style={{ padding: 20 }}>Kit</Txt></Screen>;
}
