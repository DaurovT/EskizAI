/** Templates — макеты: Templates, TemplateSize, TemplateSizeErr (docs/design). Заглушка: экран ещё собирается. */
import { Screen, Txt } from '@/ui/kit';

export default function Templates() {
  return <Screen><Txt w={600} size={18} style={{ padding: 20 }}>Templates</Txt></Screen>;
}
