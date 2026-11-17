/**
 * Шапки и нижняя панель V3 для навигаторов expo-router.
 * StackHeader — options.header у Stack: экраны по-прежнему задают <Stack.Screen options={{ title, headerRight }} />.
 * TabHeader / TabBar — для Tabs (.nav: Проекты · Клиенты · ＋ · Заказы · Профиль).
 */
import { Ionicons } from '@expo/vector-icons';
import { router, type NativeStackHeaderProps } from 'expo-router';
import type { BottomTabBarProps, BottomTabHeaderProps } from 'expo-router/tabs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Keyboard, PanResponder, Platform, StyleSheet, Text, View, type LayoutChangeEvent, type ViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../i18n';
import { SideBar, type SideKey } from './Desktop';
import { BrandLogo } from './Illus';
import { haptics } from './haptics';
import {
  BigTitle, GlassLayers, GlassPress, Header, LiquidLayer, Press, floatingNav, glass, liquid, resolveFont, useReduceMotion, type IconName,
} from './kit';
import { HeaderColumn, tablet, useLayout } from './layout';
import { palette, type } from './theme';

const titleOf = (o: { title?: string; headerTitle?: unknown }) => (typeof o.headerTitle === 'string' ? o.headerTitle : o.title) ?? '';

/**
 * Шапка стека: круглая «назад» (в модальном окне — «закрыть»), справа headerRight, ниже — большой заголовок из title.
 * headerLargeTitle: false — заголовок в строке шапки (.ht), как в редакторе; headerBackVisible: false — без «назад»;
 * headerLeft — своё содержимое вместо «назад»; title: '' — без заголовка.
 */
export function StackHeader({ options, back, navigation, route }: NativeStackHeaderProps) {
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
    <HeaderColumn route={route.name} bg={palette.ground}>
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
    </HeaderColumn>
  );
}

/** Шапка вкладки: большой заголовок 30/36; headerLeft/headerRight — строка шапки над ним (аватар цеха, «Добавить»). */
export function TabHeader({ options }: BottomTabHeaderProps) {
  const insets = useSafeAreaInsets();
  const title = titleOf(options);
  const left = options.headerLeft?.({ tintColor: palette.ink, canGoBack: false });
  const right = options.headerRight?.({ tintColor: palette.ink, canGoBack: false });
  return (
    <HeaderColumn bg={palette.ground}>
    <Header
      topInset={insets.top}
      left={left ?? undefined}
      right={right ?? undefined}
      big={title || undefined}
      bigSize="root"
      style={{ backgroundColor: palette.ground }}
    />
    </HeaderColumn>
  );
}

// как в макетах (.nv): контурные иконки и у активной вкладки — её выделяет подложка под иконкой
const TAB_ICONS: Record<string, [IconName, IconName]> = {
  index: ['folder-outline', 'folder-outline'],
  clients: ['people-outline', 'people-outline'],
  orders: ['cube-outline', 'cube-outline'],
  profile: ['person-outline', 'person-outline'],
};

/**
 * Плавающее стеклянное меню (.nav, Liquid Glass) на телефоне; на портрете планшета — рейка слева (RailBar);
 * на широком планшете — боковая панель «десктопного стиля» (TProjects2.dc.html .side, src/ui/Desktop.tsx).
 */
export function TabBar(props: BottomTabBarProps) {
  const { tablet: tab, wide } = useLayout();
  if (wide) return <SideTabs {...props} />;
  return tab ? <RailBar {...props} /> : <BottomBar {...props} />;
}

function SideTabs({ state, emitter, navigateToTab }: BottomTabBarProps) {
  const cur = state.routes[state.index]?.name;
  return (
    <SideBar active={(cur as SideKey) ?? null} onTab={(key) => {
      const route = state.routes.find((r) => r.name === key);
      if (!route) return;
      const ev = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
      if (route.name !== cur && !ev.defaultPrevented) navigateToTab(route.key);
    }} />
  );
}

/** Пружина макета: cubic-bezier(.34,1.56,.64,1). */
const springy = Easing.bezier(0.34, 1.56, 0.64, 1);
const anim = (v: Animated.Value, toValue: number, duration: number, delay = 0, easing = springy) =>
  Animated.timing(v, { toValue, duration, delay, easing, useNativeDriver: true });
/** Линза 76 × 84 r42, над меню на 10. */
const LENS_W = 76;
/** Увеличение пунктов под пальцем: до +22 % в радиусе 70. */
const MAG = 0.22;
const MAG_R = 70;
/** Палец сдвинулся больше — это перетаскивание линзы, а не тап. */
const DRAG_SLOP = 6;

/** Android: окно сжимается под клавиатуру — плавающее меню прячем, чтобы оно не всплывало над ней. */
function useAndroidKeyboard() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const a = Keyboard.addListener('keyboardDidShow', () => setShown(true));
    const b = Keyboard.addListener('keyboardDidHide', () => setShown(false));
    return () => { a.remove(); b.remove(); };
  }, []);
  return shown;
}

/**
 * .nav (Liquid Glass): капсула 64 r32 слева/справа 12 и 26 от низа экрана, стекло (заливка, блики, тень), содержимое
 * экрана прокручивается под ней. Пункты .nv 62: подпись 11/13 600 #55524D, у активной — #275C3A и подложка 56 × 32
 * rgba(255,255,255,.72). В центре — стеклянный «＋» 54 × 50 → /project/new.
 *
 * Линза (.lens, логика nvDown/nvMove/nvUp макета): нажатие на меню показывает стеклянную линзу под пальцем, её можно
 * вести вдоль меню — пункты рядом увеличиваются, капсула чуть сплющивается (1.025 × .96); при отпускании линза пружиной
 * уезжает к ближайшему пункту и гаснет, а меню переходит туда. Тап — переход сразу, перетаскивание — когда линза доехала.
 * «Уменьшить движение»: без линзы, увеличения и сплющивания, переход сразу.
 * Доступность: пункты — tab/selected/подпись, двойной тап VoiceOver/TalkBack — действие activate.
 */
function BottomBar({ state, descriptors, emitter, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { t } = useT();
  const reduce = useReduceMotion();
  const kbShown = useAndroidKeyboard();

  const go = (i: number) => {
    const route = state.routes[i];
    if (!route) return;
    if (route.name === 'new') { router.push('/project/new'); return; }
    const ev = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (i !== state.index && !ev.defaultPrevented) navigateToTab(route.key);
  };
  const goRef = useRef(go);
  goRef.current = go;
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;

  // центры пунктов в координатах капсулы (по индексу маршрута)
  const [centers, setCenters] = useState<number[]>([]);
  const centersRef = useRef<number[]>([]);
  const width = useRef(0);
  const left = useRef(floatingNav.side);
  const box = useRef<ViewInstance>(null);
  const onItemLayout = (i: number) => (e: LayoutChangeEvent) => {
    const c = e.nativeEvent.layout.x + e.nativeEvent.layout.width / 2;
    if (Math.abs((centersRef.current[i] ?? -1) - c) < 0.5) return;
    centersRef.current = [...centersRef.current];
    centersRef.current[i] = c;
    setCenters(centersRef.current);
  };
  const nearest = (px: number) => {
    let best = state.index;
    let bd = Infinity;
    centersRef.current.forEach((c, i) => { if (c != null && Math.abs(c - px) < bd) { bd = Math.abs(c - px); best = i; } });
    return best;
  };
  const nearestRef = useRef(nearest);
  nearestRef.current = nearest;

  const x = useRef(new Animated.Value(0)).current; // палец / линза
  const lensO = useRef(new Animated.Value(0)).current;
  const lensS = useRef(new Animated.Value(0.7)).current;
  const mag = useRef(new Animated.Value(0)).current; // сила увеличения пунктов
  const sq = useRef(new Animated.Value(0)).current; // сплющивание капсулы
  const plusP = useRef(new Animated.Value(0)).current; // нажатие «＋»

  const pan = useRef({ start: 0, cur: 0, moved: false, hot: -1, plus: -1 });
  const responder = useMemo(() => {
    const clamp = (v: number) => Math.max(0, Math.min(width.current, v));
    const finish = (navigate: boolean) => {
      const g = pan.current;
      const n = nearestRef.current(g.cur);
      const c = centersRef.current[n] ?? g.cur;
      if (reduceRef.current) {
        x.setValue(c);
        plusP.setValue(0);
      } else {
        // линза уезжает к пункту и гаснет, пункты и капсула возвращаются пружиной
        Animated.parallel([
          anim(x, c, 450), anim(lensO, 0, 250, 200, Easing.linear), anim(lensS, 0.7, 450),
          anim(mag, 0, 450), anim(sq, 0, 550), anim(plusP, 0, 550),
        ]).start();
      }
      if (!navigate) return;
      if (g.moved && !reduceRef.current) setTimeout(() => goRef.current(n), 320);
      else goRef.current(n);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const px = clamp(e.nativeEvent.pageX - left.current);
        const n = nearestRef.current(px);
        pan.current = { start: px, cur: px, moved: false, hot: n, plus: state.routes[n]?.name === 'new' ? n : -1 };
        x.stopAnimation();
        x.setValue(px);
        if (reduceRef.current) return;
        const parts = [anim(lensO, 1, 180, 0, Easing.linear), anim(lensS, 1, 400), anim(mag, 1, 100, 0, Easing.linear), anim(sq, 1, 550)];
        if (pan.current.plus >= 0) parts.push(anim(plusP, 1, 550));
        Animated.parallel(parts).start();
      },
      onPanResponderMove: (_, g) => {
        const px = clamp(pan.current.start + g.dx);
        pan.current.cur = px;
        x.setValue(px);
        if (!pan.current.moved && Math.abs(g.dx) > DRAG_SLOP) {
          pan.current.moved = true;
          if (pan.current.plus >= 0 && !reduceRef.current) anim(plusP, 0, 550).start();
        }
        const n = nearestRef.current(px);
        if (n !== pan.current.hot) {
          pan.current.hot = n;
          if (pan.current.moved) haptics.selection();
        }
      },
      onPanResponderRelease: () => finish(true),
      onPanResponderTerminate: () => finish(false),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (kbShown) return null;
  const bottom = floatingNav.bottom(insets.bottom);
  return (
    <View
      ref={box}
      style={[st.nav, { bottom, left: floatingNav.side + insets.left, right: floatingNav.side + insets.right }]}
      onLayout={(e) => {
        width.current = e.nativeEvent.layout.width;
        box.current?.measureInWindow((wx) => { left.current = wx; });
      }}
      accessibilityRole="tablist"
      {...responder.panHandlers}
    >
      <LiquidLayer radius={32} p={sq} squish={[1.025, 0.96]} />
      <View style={st.row} pointerEvents="box-none">
        {state.routes.map((route, i) => {
          const c = centers[i];
          const scale = reduce || c == null ? 1 : Animated.add(1, Animated.multiply(
            x.interpolate({ inputRange: [c - MAG_R, c, c + MAG_R], outputRange: [0, MAG, 0], extrapolate: 'clamp' }), mag));
          if (route.name === 'new') {
            return (
              <Animated.View key={route.key} onLayout={onItemLayout(i)} style={[st.plus, { transform: [{ scale }] }]}
                accessible accessibilityRole="button" accessibilityLabel={t('new_title')}
                accessibilityActions={[{ name: 'activate' }]} onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'activate') go(i); }}>
                <GlassLayers radius={25} inset={3.5} innerRadius={22} p={plusP} reduce={reduce} squish={[1.06, 0.92]} />
                <Ionicons name="add" size={28} color={glass.fg} />
              </Animated.View>
            );
          }
          const { options } = descriptors[route.key];
          const focused = i === state.index;
          const label = typeof options.tabBarLabel === 'string' ? options.tabBarLabel : options.title ?? route.name;
          const [off, on] = TAB_ICONS[route.name] ?? ['ellipse-outline', 'ellipse'];
          const color = focused ? palette.greenDeep : palette.muted2;
          return (
            <Animated.View key={route.key} onLayout={onItemLayout(i)} style={[st.nv, { transform: [{ scale }] }]}
              accessible accessibilityRole="tab" accessibilityState={{ selected: focused }} accessibilityLabel={label}
              accessibilityActions={[{ name: 'activate' }]} onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'activate') go(i); }}>
              <View style={[st.ni, focused && st.niOn]}>
                <Ionicons name={focused ? on : off} size={24} color={color} />
              </View>
              <Text style={resolveFont([st.nvText, { color }])} numberOfLines={1}>{label}</Text>
            </Animated.View>
          );
        })}
      </View>
      {reduce ? null : (
        <Animated.View pointerEvents="none" style={[st.lens, {
          opacity: lensO,
          transform: [{ translateX: Animated.subtract(x, LENS_W / 2) }, { scale: lensS }],
        }]} />
      )}
    </View>
  );
}

/**
 * .rail (TProjects.dc.html) — белая рейка 92 слева: знак, «＋» новый проект, разделы.
 * Порядок как у нижнего меню, только «＋» — сверху.
 */
function RailBar({ state, descriptors, emitter, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { t } = useT();
  return (
    <View style={[st.rail, { paddingTop: insets.top + 20, paddingBottom: Math.max(insets.bottom, 20) }]} accessibilityRole="tablist">
      <View style={st.logo} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><BrandLogo size={48} /></View>
      <GlassPress accessibilityRole="button" accessibilityLabel={t('new_title')} onPress={() => router.push('/project/new')} style={st.railNew}>
        <Ionicons name="add" size={30} color={glass.fg} />
      </GlassPress>
      {state.routes.map((route, i) => {
        if (route.name === 'new') return null;
        const { options } = descriptors[route.key];
        const focused = i === state.index;
        const label = typeof options.tabBarLabel === 'string' ? options.tabBarLabel : options.title ?? route.name;
        const [off, on] = TAB_ICONS[route.name] ?? ['ellipse-outline', 'ellipse'];
        const onPress = () => {
          const ev = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !ev.defaultPrevented) navigateToTab(route.key);
        };
        return (
          <Press key={route.key} feedback="opacity" onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected: focused }} accessibilityLabel={label} style={st.rv}>
            <View style={[st.ni52, focused && { backgroundColor: palette.greenSoft }]}>
              <Ionicons name={focused ? on : off} size={24} color={focused ? palette.greenDeep : palette.faint} />
            </View>
            <Text style={resolveFont([type.nav, { color: focused ? palette.ink : palette.faint }])} numberOfLines={1}>{label}</Text>
          </Press>
        );
      })}
    </View>
  );
}

const st = StyleSheet.create({
  rail: { width: tablet.rail, backgroundColor: palette.white, alignItems: 'center', gap: 6 },
  logo: { width: 48, height: 48, borderRadius: 14, overflow: 'hidden', marginBottom: 10 },
  railNew: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  rv: { width: 76, minHeight: 60, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: 4 },
  // .nav (Liquid Glass)
  nav: { position: 'absolute', height: floatingNav.height, borderRadius: 32 },
  row: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
  nv: { width: 62, alignItems: 'center', gap: 2 },
  nvText: { fontSize: 11, lineHeight: 13, fontWeight: '600', letterSpacing: -0.05 },
  ni: { width: 56, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  niOn: { backgroundColor: liquid.active, boxShadow: liquid.activeShadow },
  plus: {
    width: 54, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center',
    boxShadow: '0px 8px 16px -8px rgba(40,50,35,0.35), 0px 2px 4px rgba(40,50,35,0.08)',
  },
  lens: {
    position: 'absolute', left: 0, top: -10, width: LENS_W, height: 84, borderRadius: 42,
    backgroundColor: liquid.lensBg, backgroundImage: liquid.lens, boxShadow: liquid.lensShadow,
  },
  // рейка планшета
  ni52: { width: 52, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});

/**
 * Шапка экранов, где в макете `.hdr` с padding-top 14 (Recognition, TypeChoice, Clarify, TextParse…): «назад» на 20 от безопасной зоны,
 * справа headerRight (плашка «Фото 1 из 2»), title — большой заголовок 30/36 (.big padding 4 20 8). Подключение:
 * `<Stack.Screen options={{ title, headerRight, header: (p) => <StackHeader14 {...p} /> }} />`.
 */
export function StackHeader14({ options, navigation, route }: NativeStackHeaderProps) {
  const insets = useSafeAreaInsets();
  const right = options.headerRight?.({ canGoBack: true, tintColor: palette.ink });
  const title = titleOf(options);
  return (
    <HeaderColumn route={route.name} bg={palette.ground}>
      <Header topInset={insets.top + 2} back onBack={() => (navigation.canGoBack() ? navigation.goBack() : router.back())} right={right ?? undefined} />
      {title ? <BigTitle size="root" inset={20} style={{ paddingTop: 3, paddingBottom: 10 }}>{title}</BigTitle> : null}
    </HeaderColumn>
  );
}
