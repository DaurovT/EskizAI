/** Calc — макеты: Calc, CalcNoPrice, CalcDemo, CalcMeasurer (docs/design). Заглушка: экран ещё собирается. */
import { Screen, Txt } from '@/ui/kit';

export default function Calc() {
  return <Screen><Txt w={600} size={18} style={{ padding: 20 }}>Calc</Txt></Screen>;
}
