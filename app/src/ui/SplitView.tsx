/**
 * «Список + детали» широкого планшета (TProjects / TClients / TOrders .dc.html): слева колонка 380 с большим
 * заголовком, поиском и списком, справа — выбранный элемент. Отдельный экран карточки при этом не открывается.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../i18n';
import { EmptyState, T, type IconName } from './kit';
import { tablet } from './layout';
import { palette } from './theme';

export function SplitView({ title, right, list, detail }: {
  title: string; right?: ReactNode;
  /** Содержимое колонки списка под заголовком (поиск, чипы, список). */
  list: ReactNode;
  detail: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={sv.root}>
      <View style={[sv.list, { paddingTop: insets.top + 20 }]}>
        <View style={sv.hdr}>
          <T v="big" numberOfLines={1} style={{ flex: 1 }}>{title}</T>
          {right ? <View style={sv.right}>{right}</View> : null}
        </View>
        {list}
      </View>
      <View style={[sv.detail, { paddingTop: insets.top + 20 }]}>
        <SplitDetail.Provider value>{detail}</SplitDetail.Provider>
      </View>
    </View>
  );
}

const SplitDetail = createContext(false);
/** true — компонент нарисован в правой колонке SplitView. */
export const useInSplitDetail = () => useContext(SplitDetail);

/** Правая колонка, пока ничего не выбрано. */
export function SplitEmpty({ icon = 'albums-outline', title }: { icon?: IconName; title?: string }) {
  const { t } = useT();
  return (
    <View style={{ flex: 1, justifyContent: 'center' }}>
      <EmptyState icon={icon} title={title ?? t('split_pick')} align="center" />
    </View>
  );
}

/** Белая панель .pane (r28) — список в колонке слева. */
export function Pane({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[sv.pane, style]}>{children}</View>;
}

/** Выделенная строка списка (.pr.sel / .lrow.sel): серая подложка r20 с отступом 8 от краёв панели. */
export const splitRow = StyleSheet.create({
  row: { marginHorizontal: 8, borderRadius: 20 },
  sel: { backgroundColor: palette.ground },
});

const sv = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: palette.ground },
  list: { width: tablet.list, paddingLeft: 20, paddingRight: 12, gap: 12 },
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  detail: { flex: 1, minWidth: 0, paddingLeft: 8, paddingRight: 20 },
  pane: { flex: 1, backgroundColor: palette.white, borderRadius: 28, overflow: 'hidden' },
});
