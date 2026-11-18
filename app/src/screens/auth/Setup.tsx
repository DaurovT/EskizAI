/** Setup — макеты: Setup1, Setup2, Setup3, Setup6 (docs/design). Заглушка: экран ещё собирается. */
import { Screen, Txt } from '@/ui/kit';

export default function Setup() {
  return <Screen><Txt w={600} size={18} style={{ padding: 20 }}>Setup</Txt></Screen>;
}
