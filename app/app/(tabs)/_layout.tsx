import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../../src/i18n';
import { CenterColumn, useLayout } from '../../src/ui/layout';
import { TabBarSpaceProvider, floatingNav } from '../../src/ui/kit';
import { TabBar, TabHeader } from '../../src/ui/navigation';
import { colors } from '../../src/ui/theme';

/** Списки, у которых на широком планшете своя раскладка «список + детали» (SplitView) и своя шапка в колонке списка. */
const SPLIT = new Set(['index', 'clients', 'orders']);

/**
 * Нижнее меню .nav: Проекты · Клиенты · ＋ Новый проект (в центре, всегда один тап) · Заказы · Профиль.
 * На телефоне — плавающая стеклянная капсула (Liquid Glass) поверх экрана: экраны вкладок получают нижний запас
 * под неё через TabBarSpaceProvider (Screen добавляет его сам, свои ScrollView — useTabBarSpace()).
 * На планшете — рейка слева (TProjects.dc.html .rail), разделы без своей раскладки — колонкой по центру.
 */
export default function TabsLayout() {
  const { t } = useT();
  const { tablet, wide } = useLayout();
  const insets = useSafeAreaInsets();
  const navSpace = tablet ? 0 : floatingNav.space(insets.bottom);
  return (
    <Tabs
      tabBar={(p) => <TabBar {...p} />}
      screenLayout={({ children, route }) => (
        <TabBarSpaceProvider value={navSpace}>
          {tablet && !(wide && SPLIT.has(route.name)) ? <CenterColumn>{children}</CenterColumn> : children}
        </TabBarSpaceProvider>
      )}
      screenOptions={({ route }) => ({
        header: (p) => <TabHeader {...p} />,
        headerShown: !(wide && SPLIT.has(route.name)),
        tabBarPosition: tablet ? 'left' : 'bottom',
        sceneStyle: { backgroundColor: colors.bg },
      })}
    >
      <Tabs.Screen name="index" options={{ title: t('tab_projects'), headerTitle: t('projects_title') }} />
      <Tabs.Screen name="clients" options={{ title: t('tab_clients') }} />
      {/* «＋» рисует TabBar: открывает /project/new */}
      <Tabs.Screen name="new" options={{ title: t('tab_new') }} />
      <Tabs.Screen name="orders" options={{ title: t('tab_orders') }} />
      <Tabs.Screen name="profile" options={{ title: t('tab_profile') }} />
    </Tabs>
  );
}
