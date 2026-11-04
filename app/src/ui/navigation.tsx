/**
 * Шапки и нижняя панель V3 для навигаторов expo-router.
 * StackHeader — options.header у Stack: экраны по-прежнему задают <Stack.Screen options={{ title, headerRight }} />.
 * TabHeader / TabBar — для Tabs (.nav: Проекты · Клиенты · ＋ · Заказы · Профиль).
 */
import { Ionicons } from '@expo/vector-icons';
import { router, type NativeStackHeaderProps } from 'expo-router';
import type { BottomTabBarProps, BottomTabHeaderProps } from 'expo-router/tabs';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../i18n';
import { BigTitle, Header, Press, resolveFont, type IconName } from './kit';
import { palette, radius, type } from './theme';

const titleOf = (o: { title?: string; headerTitle?: unknown }) => (typeof o.headerTitle === 'string' ? o.headerTitle : o.title) ?? '';

/**
 * Шапка стека: круглая «назад» (в модальном окне — «закрыть»), справа headerRight, ниже — большой заголовок из title.
 * headerLargeTitle: false — заголовок в строке шапки (.ht), как в редакторе; headerBackVisible: false — без «назад»;
 * headerLeft — своё содержимое вместо «назад»; title: '' — без заголовка.
 */
export function StackHeader({ options, back, navigation }: NativeStackHeaderProps) {
  const insets = useSafeAreaInsets();
  const modal = options.presentation === 'modal' || options.presentation === 'formSheet' || options.presentation === 'pageSheet';
  // модальное окно на iOS — карточка ниже статус-бара: верхний отступ не нужен
  const top = modal && Platform.OS === 'ios' ? 0 : insets.top;
  const canBack = (!!back || modal) && options.headerBackVisible !== false;
  const title = titleOf(options);
  const inline = options.headerLargeTitle === false;
  const left = options.headerLeft?.({ canGoBack: canBack, tintColor: palette.ink });
  const right = options.headerRight?.({ canGoBack: canBack, tintColor: palette.ink });
  return (
    <Header
      topInset={top}
      back={canBack}
      backIcon={modal ? 'close' : 'back'}
      onBack={() => (navigation.canGoBack() ? navigation.goBack() : router.back())}
      left={left ?? undefined}
      right={right ?? undefined}
      title={inline ? title : undefined}
      big={!inline && title ? title : undefined}
      bigSize="push"
      style={{ backgroundColor: palette.ground }}
    />
  );
}

/** Шапка вкладки: большой заголовок 30/36; headerLeft/headerRight — строка шапки над ним (аватар цеха, «Добавить»). */
export function TabHeader({ options }: BottomTabHeaderProps) {
  const insets = useSafeAreaInsets();
  const title = titleOf(options);
  const left = options.headerLeft?.({ tintColor: palette.ink, canGoBack: false });
  const right = options.headerRight?.({ tintColor: palette.ink, canGoBack: false });
  return (
    <Header
      topInset={insets.top}
      left={left ?? undefined}
      right={right ?? undefined}
      big={title || undefined}
      bigSize="root"
      style={{ backgroundColor: palette.ground }}
    />
  );
}

// как в макетах (.nv): контурные иконки и у активной вкладки — её выделяет зелёная «таблетка»
const TAB_ICONS: Record<string, [IconName, IconName]> = {
  index: ['folder-outline', 'folder-outline'],
  clients: ['people-outline', 'people-outline'],
  orders: ['cube-outline', 'cube-outline'],
  profile: ['person-outline', 'person-outline'],
};

/** .nav — белая панель r24 сверху, 84 с безопасной зоной; активная вкладка — зелёная «таблетка» под иконкой; в центре .plus. */
export function TabBar({ state, descriptors, emitter, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { t } = useT();
  return (
    // подложка цвета фона: иначе за скруглёнными углами панели виден белый корень
    <View style={{ backgroundColor: palette.ground }}>
    <View style={[st.nav, { paddingBottom: Math.max(insets.bottom - 8, 10) }]} accessibilityRole="tablist">
      {state.routes.map((route, i) => {
        if (route.name === 'new') {
          return (
            <View key={route.key} style={st.slot}>
              <Press accessibilityRole="button" accessibilityLabel={t('new_title')} onPress={() => router.push('/project/new')} style={st.plus}>
                <Ionicons name="add" size={28} color={palette.white} />
              </Press>
            </View>
          );
        }
        const { options } = descriptors[route.key];
        const focused = i === state.index;
        const label = typeof options.tabBarLabel === 'string' ? options.tabBarLabel : options.title ?? route.name;
        const [off, on] = TAB_ICONS[route.name] ?? ['ellipse-outline', 'ellipse'];
        const onPress = () => {
          const ev = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !ev.defaultPrevented) navigateToTab(route.key);
        };
        return (
          <Press key={route.key} feedback="opacity" onPress={onPress} onLongPress={() => emitter.emit({ type: 'tabLongPress', target: route.key })}
            accessibilityRole="tab" accessibilityState={{ selected: focused }} accessibilityLabel={label} style={st.slot}>
            <View style={[st.ni, focused && { backgroundColor: palette.greenSoft }]}>
              <Ionicons name={focused ? on : off} size={24} color={focused ? palette.greenDeep : palette.faint} />
            </View>
            <Text style={resolveFont([type.nav, { color: focused ? palette.ink : palette.faint }])} numberOfLines={1}>{label}</Text>
          </Press>
        );
      })}
    </View>
    </View>
  );
}

const st = StyleSheet.create({
  nav: {
    backgroundColor: palette.white, borderTopLeftRadius: radius.nav, borderTopRightRadius: radius.nav,
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-around', paddingTop: 8, paddingHorizontal: 4,
  },
  slot: { width: 70, alignItems: 'center', gap: 3 },
  ni: { width: 52, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  plus: { width: 52, height: 44, borderRadius: 16, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
});

/**
 * Шапка экранов, где в макете `.hdr` с padding-top 14 (Recognition, TypeChoice, Clarify, TextParse…): «назад» на 20 от безопасной зоны,
 * справа headerRight (плашка «Фото 1 из 2»), title — большой заголовок 30/36 (.big padding 4 20 8). Подключение:
 * `<Stack.Screen options={{ title, headerRight, header: (p) => <StackHeader14 {...p} /> }} />`.
 */
export function StackHeader14({ options, navigation }: NativeStackHeaderProps) {
  const insets = useSafeAreaInsets();
  const right = options.headerRight?.({ canGoBack: true, tintColor: palette.ink });
  const title = titleOf(options);
  return (
    <View style={{ backgroundColor: palette.ground }}>
      <Header topInset={insets.top + 2} back onBack={() => (navigation.canGoBack() ? navigation.goBack() : router.back())} right={right ?? undefined} />
      {title ? <BigTitle size="root" inset={20} style={{ paddingTop: 3, paddingBottom: 10 }}>{title}</BigTitle> : null}
    </View>
  );
}
