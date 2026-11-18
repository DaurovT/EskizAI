/** Editor — макеты: Editor, EditorCell, EditorBlock, EditorIssues, EditorOffline (docs/design). Заглушка: экран ещё собирается. */
import { Screen, Txt } from '@/ui/kit';

export default function Editor() {
  return <Screen><Txt w={600} size={18} style={{ padding: 20 }}>Editor</Txt></Screen>;
}
