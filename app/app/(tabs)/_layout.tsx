import { Tabs } from 'expo-router';
import { useT } from '../../src/i18n';
import { TabBar, TabHeader } from '../../src/ui/navigation';
import { colors } from '../../src/ui/theme';

/** Нижняя панель .nav: Проекты · Клиенты · ＋ Новый проект (в центре, всегда один тап) · Заказы · Профиль. */
export default function TabsLayout() {
  const { t } = useT();
  return (
    <Tabs
      tabBar={(p) => <TabBar {...p} />}
      screenOptions={{
        header: (p) => <TabHeader {...p} />,
        sceneStyle: { backgroundColor: colors.bg },
      }}
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
