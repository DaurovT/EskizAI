/** Resume — макеты: MResume (docs/design). Заглушка: экран ещё собирается. */
import { Screen, Txt } from '@/ui/kit';

export default function Resume() {
  return <Screen><Txt w={600} size={18} style={{ padding: 20 }}>Resume</Txt></Screen>;
}
