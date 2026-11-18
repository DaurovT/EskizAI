/** Measure — макеты: M1Room, M2Opening, M3Size, M3SizeErr, M4Split, M5Extras, M6Next (docs/design). Заглушка: экран ещё собирается. */
import { Screen, Txt } from '@/ui/kit';

export default function Measure() {
  return <Screen><Txt w={600} size={18} style={{ padding: 20 }}>Measure</Txt></Screen>;
}
