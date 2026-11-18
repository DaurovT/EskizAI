import { Tabs } from 'expo-router';

import { TabBar } from '@/ui/TabBar';

export default function TabsLayout() {
  return (
    <Tabs tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="orders" />
      <Tabs.Screen name="clients" />
      <Tabs.Screen name="new" />
      <Tabs.Screen name="catalog" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
