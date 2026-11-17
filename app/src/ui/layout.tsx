/**
 * Раскладка под ширину окна (TPrinciples.dc.html, «Точки перехода»):
 * меньше 700 pt — телефон, 700–1000 — портрет планшета (рейка слева, одна колонка), больше 1000 — две колонки.
 * Считается по ширине окна, а не по устройству: iPad в Split View получает телефонную раскладку.
 */
import { Stack, useLocalSearchParams } from 'expo-router';
import { createContext, useContext, useEffect, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';

export type LayoutMode = 'phone' | 'portrait' | 'wide';

export const modeFor = (width: number): LayoutMode => (width < 700 ? 'phone' : width < 1000 ? 'portrait' : 'wide');

/** Размеры планшетной сетки, pt. */
export const tablet = {
  rail: 92,
  /** Колонка списка и панель чата. */
  list: 380,
  /** Панели настроек: декор, фурнитура, свет. */
  panel: 440,
  /** Окна поверх экрана: оплата, пейволл, подтверждения, шторки. */
  modal: 560,
  /** Одиночные экраны без своей планшетной раскладки — колонкой по центру. */
  column: 720,
};

export function useLayout() {
  const { width, height } = useWindowDimensions();
  const mode = modeFor(width);
  return { mode, width, height, tablet: mode !== 'phone', wide: mode === 'wide' };
}

/** Колонка по центру шириной до `max` на планшете; на телефоне — как есть. */
export function CenterColumn({ children, max = tablet.column, style }: { children: ReactNode; max?: number; style?: StyleProp<ViewStyle> }) {
  const { tablet: tab } = useLayout();
  if (!tab) return <>{children}</>;
  return (
    <View style={[{ flex: 1, alignItems: 'center' }, style]}>
      <View style={{ flex: 1, width: '100%', maxWidth: max }}>{children}</View>
    </View>
  );
}

/**
 * Экраны во всю ширину и на планшете: 3D-редактор, встройка, служебные. Остальные экраны стека без своей
 * планшетной раскладки встают колонкой tablet.column по центру (корневой Stack, screenLayout).
 */
export const FULL_WIDTH_ROUTES = new Set(['(tabs)', 'project/[id]/editor', 'project/[id]/builtin', 'project/[id]/ar', 'login', 'diag', 'shot']);

/**
 * Только на широком планшете — во всю ширину (своя «десктопная» раскладка с боковой панелью: TInbox, TRequests).
 * На портрете планшета эти экраны — колонкой, как раньше.
 */
export const WIDE_FULL_ROUTES = new Set(['inbox/index', 'inbox/[id]', 'client-requests/index', 'client-requests/[id]']);

// Экран, которому во всю ширину нужно не всегда (разбор чертежа — только в режиме чертежа): включает сам на время показа.
const wideFull = new Set<string>();
const wideFullSubs = new Set<() => void>();
const wideFullSub = (fn: () => void) => { wideFullSubs.add(fn); return () => { wideFullSubs.delete(fn); }; };
/** На широком планшете показать маршрут `route` во всю ширину, пока компонент на экране (src/screens/DrawingParseWide.tsx). */
export function useWideFullWidth(route: string, on: boolean) {
  useEffect(() => {
    if (!on) return undefined;
    wideFull.add(route);
    wideFullSubs.forEach((f) => f());
    return () => { wideFull.delete(route); wideFullSubs.forEach((f) => f()); };
  }, [route, on]);
}
function useFullWidth(route: string | undefined) {
  const { wide } = useLayout();
  const dyn = useSyncExternalStore(wideFullSub, () => (route ? wideFull.has(route) : false));
  return !!route && (FULL_WIDTH_ROUTES.has(route) || (wide && (WIDE_FULL_ROUTES.has(route) || dyn)));
}

/** Обёртка экрана корневого стека: колонкой по центру, кроме FULL_WIDTH_ROUTES (и WIDE_FULL_ROUTES на широком). */
export function RouteColumn({ route, children }: { route: string; children: ReactNode }) {
  const { tablet: tab } = useLayout();
  const full = useFullWidth(route);
  if (!tab || full) return <>{children}</>;
  return <CenterColumn>{children}</CenterColumn>;
}

/** Шапка той же ширины, что колонка экрана под ней; фон — на всю ширину. */
export function HeaderColumn({ children, route, bg }: { children: ReactNode; route?: string; bg?: string }) {
  const { tablet: tab } = useLayout();
  const full = useFullWidth(route);
  if (!tab || full) return <>{children}</>;
  return (
    <View style={{ alignItems: 'center', backgroundColor: bg }}>
      <View style={{ width: '100%', maxWidth: tablet.column }}>{children}</View>
    </View>
  );
}

// ---------- экран внутри другого (правая колонка «список + детали») ----------

type EmbedCtx = {
  params: Record<string, string>;
  /** Элемент изменился (статус, название) — обновить список слева. */
  onChange?: () => void;
  /** Элемента больше нет (удалён) — снять выбор. */
  onGone?: () => void;
};
const Embed = createContext<EmbedCtx | null>(null);

/**
 * Показывает экран-маршрут (карточку проекта, клиента, заказа) внутри правой колонки списка.
 * Экран читает параметры через useRouteParams и задаёт шапку через ScreenOptions — внутри Embedded
 * шапка навигатора не трогается, а параметры берутся отсюда.
 */
export function Embedded({ children, ...ctx }: EmbedCtx & { children: ReactNode }) {
  return <Embed.Provider value={ctx}>{children}</Embed.Provider>;
}

/** Колбэки колонки: onChange — обновить список, onGone — элемент удалён. Вне Embedded — пустые. */
export function useEmbedEvents() {
  const ctx = useContext(Embed);
  return { onChange: ctx?.onChange ?? noop, onGone: ctx?.onGone ?? noop };
}
const noop = () => undefined;

/** true — экран показан колонкой рядом со списком (без «назад» и без шапки навигатора). */
export const useEmbedded = () => useContext(Embed) !== null;

/** useLocalSearchParams, но внутри Embedded — параметры колонки. */
export function useRouteParams<T extends Record<string, string | undefined>>(): T {
  const ctx = useContext(Embed);
  const own = useLocalSearchParams();
  return (ctx ? ctx.params : own) as T;
}

/** <Stack.Screen options/>, который внутри Embedded ничего не делает (иначе он менял бы шапку вкладки). */
export function ScreenOptions(props: ComponentProps<typeof Stack.Screen>) {
  if (useEmbedded()) return null;
  return <Stack.Screen {...props} />;
}
