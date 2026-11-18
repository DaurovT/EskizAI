/**
 * Нижнее меню (макет Oyna: .nav — Заказы, Клиенты, «+», Каталог, Профиль): плавающая стеклянная капсула 60 pt над контентом, отступы 12 по бокам и
 * 28 снизу. Пункты: Главная, Проекты, «Новый» (синяя таблетка), Документы, Ещё; выбранный — белая подложка 55 %
 * и синий цвет. Контент вкладок прокручивается под капсулой — отступ снизу TAB_BAR_SPACE.
 */
import type { BottomTabBarProps } from 'expo-router/build/layouts/Tabs';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C } from '@/theme';
import { Glass } from './Glass';
import { Icon, IconName } from './Icon';
import { GlassBlue, Txt } from './kit';

const TABS: { name: string; title: string; icon: IconName }[] = [
  { name: 'orders', title: 'Заказы', icon: 'folder' },
  { name: 'clients', title: 'Клиенты', icon: 'person' },
  { name: 'new', title: '', icon: 'plus' },
  { name: 'catalog', title: 'Каталог', icon: 'layers' },
  { name: 'profile', title: 'Профиль', icon: 'more' },
];

/** Сколько места снизу оставить списку вкладки, чтобы последняя строка не пряталась под капсулой. */
export const TAB_BAR_SPACE = 110;

export function TabBar({ state, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const current = state.routes[state.index]?.name;
  // «+» — новый заказ во весь экран, без меню (макет OrderNew)
  if (current === 'new') return null;
  const go = (name: string) => { const r = state.routes.find((x) => x.name === name); if (r) navigateToTab(r.key); };
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 12, right: 12, bottom: Math.max(insets.bottom - 6, 12) + 8 }}>
      <Glass radius={30} interactive style={{ height: 60, padding: 4, flexDirection: 'row' }}>
        <View accessibilityRole="tablist" style={{ flex: 1, flexDirection: 'row' }}>
          {TABS.map((t) => {
            const on = current === t.name;
            if (t.name === 'new') {
              return (
                <Pressable key={t.name} accessibilityRole="button" accessibilityLabel="Новый заказ" onPress={() => go(t.name)}
                  style={({ pressed }) => ({ flex: 1, height: 52, borderRadius: 26, overflow: 'hidden', borderWidth: 1.2, borderColor: 'rgba(64,92,138,0.95)', alignItems: 'center', justifyContent: 'center', gap: 2, transform: [{ scale: pressed ? 0.96 : 1 }] })}>
                  <GlassBlue />
                  <Icon name="plus" color={C.ctaText} size={26} stroke={2.4} />
                </Pressable>
              );
            }
            return (
              <Pressable key={t.name} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={t.title} onPress={() => go(t.name)}
                style={({ pressed }) => [{ flex: 1, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', gap: 2, transform: [{ scale: pressed ? 0.96 : 1 }] },
                  on && { backgroundColor: 'rgba(255,255,255,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)', shadowColor: '#21201F', shadowOpacity: 0.16, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } }]}>
                <Icon name={t.icon} color={on ? C.accentDeep : '#55524D'} size={24} />
                <Txt size={11} w={600} color={on ? C.accentDeep : '#55524D'} style={{ lineHeight: 13 }}>{t.title}</Txt>
              </Pressable>
            );
          })}
        </View>
      </Glass>
    </View>
  );
}
