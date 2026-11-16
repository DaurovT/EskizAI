/**
 * Примитивы V3: текст T с Onest, «поверхность» (белое/серое), нажатие со сжатием, кнопки.
 * Импортируйте через './kit' — там всё реэкспортировано.
 */
import { Ionicons } from '@expo/vector-icons';
import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Animated, Easing, Platform, Pressable, StyleSheet, Text, View,
  type PressableProps, type StyleProp, type TextStyle, type ViewStyle,
} from 'react-native';
import { colors, fontFor, fonts, motion, palette, radius, type } from './theme';
import { haptics } from './haptics';

export type IconName = ComponentProps<typeof Ionicons>['name'];

// ---------- шрифт ----------
/**
 * Подставляет семейство Onest по fontWeight и убирает fontWeight (с кастомным шрифтом RN его не понимает).
 * Нужен для «сырых» Text/TextInput: style={resolveFont([..., { fontWeight: '600' }])}.
 */
export function resolveFont(style: StyleProp<TextStyle>): TextStyle {
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const fam = flat.fontFamily;
  if (fam && !fam.startsWith('Onest')) return flat;
  const { fontWeight, ...rest } = flat;
  return { ...rest, fontFamily: fontWeight != null ? fontFor(fontWeight) : fam ?? fonts.regular };
}

// ---------- текст ----------
/** Варианты T: новые (имена классов CSS) и прежние (h1/h2/bodyL/caption/muted/price/label — сопоставлены с V3). */
export type TV =
  | 'body' | 'big' | 'bigPush' | 'title' | 'h3' | 'ht' | 'sub' | 'cap' | 'lbl' | 'rt' | 'rs' | 'rv' | 'bigN'
  | 'fl' | 'fv' | 'bt' | 'bd' | 'link'
  | 'h1' | 'h2' | 'bodyL' | 'caption' | 'muted' | 'price' | 'label';
const tv: Record<TV, TextStyle> = {
  body: type.body, big: type.big, bigPush: type.bigPush, title: type.title, h3: type.h3, ht: type.ht,
  sub: type.sub, cap: type.cap, lbl: type.lbl, rt: type.rt, rs: type.rs, rv: type.rv, bigN: type.bigN,
  fl: type.fl, fv: type.fv, bt: type.bt, bd: type.bd, link: type.txt,
  h1: type.big,
  h2: type.title,
  bodyL: { ...type.body, fontSize: 17, lineHeight: 23 },
  caption: type.cap,
  muted: type.sub,
  price: { ...type.bigN, fontSize: 24, lineHeight: 30 },
  label: type.lbl,
};
export function T({ v = 'body', style, children, numberOfLines, num, center, color, selectable, onPress }: {
  v?: TV; style?: StyleProp<TextStyle>; children: ReactNode; numberOfLines?: number;
  /** Табличные цифры (суммы, размеры). */
  num?: boolean; center?: boolean; color?: string; selectable?: boolean; onPress?: () => void;
}) {
  return (
    <Text
      style={resolveFont([tv[v], num && type.num, center && { textAlign: 'center' }, color ? { color } : null, style])}
      numberOfLines={numberOfLines}
      selectable={selectable}
      onPress={onPress}
    >
      {children}
    </Text>
  );
}

// ---------- поверхность ----------
/** «Внутри белого контролы серые»: Card/Sheet(white)/Dialog/футер-бар ставят 'white', контролы читают. */
export type Surface = 'ground' | 'white';
const SurfaceCtx = createContext<Surface>('ground');
export const SurfaceProvider = SurfaceCtx.Provider;
export const useSurface = () => useContext(SurfaceCtx);
/** Фон контрола (.soft, .chip, .opt, .fld, .search, .ib): белый на сером фоне, серый внутри белого. */
export const useControlBg = () => (useContext(SurfaceCtx) === 'white' ? palette.ground : palette.white);

// ---------- строки в группе ----------
/** Group ставит true всем строкам, кроме первой: строка рисует волосяную линию сверху (.row+.row). */
const SepCtx = createContext(false);
export const SeparatorProvider = SepCtx.Provider;
export const useSeparator = () => useContext(SepCtx);
/** Горизонтальный отступ строк: 20 в Group/шторке, 0 внутри Card с отступами. */
const InsetCtx = createContext(20);
export const RowInsetProvider = InsetCtx.Provider;
export const useRowInset = () => useContext(InsetCtx);
/** Волосяная линия .hair (#F0EFEC). */
export const Hairline = ({ style }: { style?: StyleProp<ViewStyle> }) => <View style={[{ height: 1, backgroundColor: palette.hair }, style]} />;

// ---------- плавающее меню вкладок ----------
/**
 * Размеры плавающего .nav (Liquid Glass): капсула 64 с отступами 12 по бокам и 26 снизу (у iPhone с «полоской»
 * домой это 34 − 8, у остальных — не меньше 12, чтобы не задевать системную полосу Android).
 */
export const floatingNav = {
  height: 64,
  side: 12,
  bottom: (insetBottom: number) => Math.max(insetBottom - 8, 12),
  /** Нижний отступ прокрутки под меню: .app:has(>.nav) .body { padding-bottom: 104 } = 26 + 64 + 14. */
  space: (insetBottom: number) => Math.max(insetBottom - 8, 12) + 64 + 14,
};
/** Сколько места снизу занимает плавающее меню вкладок над экраном (0 — меню нет: стек, планшет). */
const TabSpaceCtx = createContext(0);
export const TabBarSpaceProvider = TabSpaceCtx.Provider;
export const useTabBarSpace = () => useContext(TabSpaceCtx);

// ---------- «уменьшить движение» ----------
let reduceMotion = false;
const rmSubs = new Set<(v: boolean) => void>();
let rmInit = false;
function initReduceMotion() {
  if (rmInit) return;
  rmInit = true;
  try {
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { reduceMotion = v; rmSubs.forEach((f) => f(v)); }).catch(() => undefined);
    AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => { reduceMotion = v; rmSubs.forEach((f) => f(v)); });
  } catch { /* тесты */ }
}
/** true — в системе включено «уменьшить движение»: оставляем только прозрачность. */
export function useReduceMotion() {
  initReduceMotion();
  const [v, setV] = useState(reduceMotion);
  useEffect(() => { rmSubs.add(setV); return () => { rmSubs.delete(setV); }; }, []);
  return v;
}
export const isReduceMotion = () => reduceMotion;

export const ease = Easing.bezier(...motion.ease);
export const sheetEase = Easing.bezier(...motion.sheetEase);
export const exitEase = Easing.bezier(...motion.exitEase);

// ---------- нажатие ----------
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
/** scale — сжатие 0.97 и затемнение 6% (.cta .soft .chip .ib .opt); row — подсветка строки; opacity — .txt и вкладки; none. */
export type PressFeedback = 'scale' | 'row' | 'opacity' | 'none';

/** Нажимаемая область с анимацией V3 (120 мс нажатие, 160 мс отпускание). */
export function Press({ feedback = 'scale', style, children, disabled, onPressIn, onPressOut, ...rest }: Omit<PressableProps, 'style' | 'children'> & {
  feedback?: PressFeedback; style?: StyleProp<ViewStyle>; children?: ReactNode;
}) {
  const p = useRef(new Animated.Value(0)).current;
  const reduce = useReduceMotion();
  const to = (v: number, d: number) => Animated.timing(p, { toValue: v, duration: d, easing: ease, useNativeDriver: true }).start();
  const anim =
    feedback === 'scale' && !reduce ? { transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [1, 0.97] }) }] }
      : feedback === 'opacity' ? { opacity: p.interpolate({ inputRange: [0, 1], outputRange: [1, 0.6] }) }
        : null;
  const shade = feedback === 'scale' ? 0.06 : feedback === 'row' ? 0.035 : 0;
  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={(e) => { if (feedback !== 'none') to(1, motion.press); onPressIn?.(e); }}
      onPressOut={(e) => { if (feedback !== 'none') to(0, motion.release); onPressOut?.(e); }}
      style={[shade ? { overflow: 'hidden' } : null, style, anim]}
    >
      {children}
      {shade ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: palette.ink, opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0, shade] }) }]} /> : null}
    </AnimatedPressable>
  );
}

// ---------- «стекло» GLASS-GREEN ----------
/**
 * Светло-зелёное стекло основных кнопок (блок GLASS-GREEN в CSS макетов): внешний слой — рамка 1.2 и вертикальный
 * градиент, внутренний (отступ 4) — свой градиент, тонкое кольцо и внутренняя тень; тень снаружи; текст #12351A.
 * Нажатие — «сплющивание» слоёв scale(1.03, .94) пружиной (.34,1.56,.64,1) за 550 мс, текст не двигается;
 * при «уменьшить движение» — только лёгкое затемнение слоёв. Градиенты и тени — стили RN 0.88 (New Architecture), без нативных модулей.
 */
export const glass = {
  fg: '#12351A',
  border: 'rgba(80,92,76,0.95)',
  outer: 'linear-gradient(180deg, rgba(240,244,234,0.96) 0%, rgba(200,216,194,0.92) 28%, rgba(176,198,170,0.92) 62%, rgba(214,243,207,0.96) 100%)',
  inner: 'linear-gradient(180deg, rgba(190,198,175,0.94) 0%, rgba(203,212,189,0.94) 100%)',
  innerShadow: 'inset 0px 1px 1px rgba(60,70,50,0.1), 0px 0px 0px 0.5px rgba(120,140,110,0.35)',
  shadow: '0px 10px 22px -10px rgba(40,50,35,0.3), 0px 2px 5px rgba(40,50,35,0.08)',
  /** .cta .v — плашка значения внутри стекла. */
  chip: 'rgba(232,238,224,0.55)',
  chipShadow: 'inset 0px 1px 0px rgba(255,255,255,0.6), 0px 0px 0px 1px rgba(80,96,74,0.22)',
  /** text-shadow 0 1px 0 rgba(255,255,255,.35) */
  text: { textShadowColor: 'rgba(255,255,255,0.35)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 0 } as TextStyle,
} as const;
const glassEase = Easing.bezier(0.34, 1.56, 0.64, 1);

/** Сплющивание стекла при нажатии: scale(sx, sy) по `p` 0…1; при «уменьшить движение» — лёгкое затемнение. */
const squishStyle = (p: Animated.Value | undefined, reduce: boolean | undefined, [sx, sy]: readonly [number, number]) => (!p ? null
  : reduce ? { opacity: p.interpolate({ inputRange: [0, 1], outputRange: [1, 0.86] }) }
    : { transform: [{ scaleX: p.interpolate({ inputRange: [0, 1], outputRange: [1, sx] }) }, { scaleY: p.interpolate({ inputRange: [0, 1], outputRange: [1, sy] }) }] });

/**
 * Два слоя стекла под содержимым; `p` — 0…1 нажатие (Animated). Радиус по умолчанию — «таблетка».
 * `inset`/`innerRadius` — отступ и радиус внутреннего слоя (у «＋» меню 3.5 и 22), `squish` — сплющивание при нажатии.
 */
export function GlassLayers({ radius: r = 999, p, reduce, inset = 4, innerRadius, squish = [1.03, 0.94] }: {
  radius?: number; p?: Animated.Value; reduce?: boolean; inset?: number; innerRadius?: number; squish?: readonly [number, number];
}) {
  const anim = squishStyle(p, reduce, squish);
  return (
    <>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, gst.outer, { borderRadius: r }, anim]} />
      <Animated.View pointerEvents="none" style={[gst.inner, { top: inset, left: inset, right: inset, bottom: inset, borderRadius: innerRadius ?? r }, anim]} />
    </>
  );
}

/** Неподвижная стеклянная плашка (иллюстрации онбординга и т. п.). */
export function GlassSurface({ radius: r = 999, style, children }: { radius?: number; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  return <View style={[{ borderRadius: r, boxShadow: glass.shadow }, style]}><GlassLayers radius={r} />{children}</View>;
}

/** Нажимаемое стекло: .cta, .plus, зелёные плитки .svc. Свой `style` задаёт размер и раскладку содержимого. */
export function GlassPress({ radius: r = 999, style, children, disabled, onPressIn, onPressOut, ...rest }: Omit<PressableProps, 'style' | 'children'> & {
  radius?: number; style?: StyleProp<ViewStyle>; children?: ReactNode;
}) {
  const p = useRef(new Animated.Value(0)).current;
  const reduce = useReduceMotion();
  const to = (v: number) => Animated.timing(p, {
    toValue: v, duration: reduce ? motion.press : 550, easing: reduce ? ease : glassEase, useNativeDriver: true,
  }).start();
  return (
    <Pressable
      {...rest}
      disabled={disabled}
      onPressIn={(e) => { to(1); onPressIn?.(e); }}
      onPressOut={(e) => { to(0); onPressOut?.(e); }}
      style={[{ borderRadius: r, boxShadow: glass.shadow }, style]}
    >
      <GlassLayers radius={r} p={p} reduce={reduce} />
      {children}
    </Pressable>
  );
}

const gst = StyleSheet.create({
  outer: { borderWidth: 1.2, borderColor: glass.border, backgroundImage: glass.outer },
  inner: { position: 'absolute', backgroundImage: glass.inner, boxShadow: glass.innerShadow },
});

// ---------- «жидкое стекло» (блок /* Liquid Glass */ макетов) ----------
/**
 * Прозрачное стекло: плавающее меню, круглые кнопки шапки (.ib), инструменты и «Вид» редактора (.tool, .vb).
 * В CSS — градиент rgba(255,255,255,.30 → .08) поверх backdrop-filter: blur(4px) saturate(2.2) brightness(1.05).
 * Размытия того, что под элементом, в RN без нативного модуля нет (expo-blur не установлен), поэтому заливка плотнее:
 * на фоне #F2F1EE она даёт тот же почти белый тон, что и «осветлённое размытие» макета, а содержимое под меню
 * лишь слегка просвечивает. Блики и тени — как в макете.
 */
export const liquid = {
  /** Заливка (замена backdrop-blur): белый .9 сверху → .72 снизу. */
  fill: 'linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.72) 100%)',
  /** Внутренние блики (верх 1px, низ, кольцо) + внешнее кольцо .5 и тень 0 10 28 -8. */
  shadow: 'inset 0px 1px 0px rgba(255,255,255,0.95), inset 0px -1px 1px rgba(255,255,255,0.5), inset 0px 0px 0px 1px rgba(255,255,255,0.5), '
    + '0px 0px 0px 0.5px rgba(33,32,31,0.1), 0px 10px 28px -8px rgba(33,32,31,0.28)',
  /** Тень под системным стеклом iOS 26: только внешнее кольцо и мягкая тень. */
  nativeShadow: '0px 0px 0px 0.5px rgba(33,32,31,0.08), 0px 10px 28px -8px rgba(33,32,31,0.22)',
  /** .nv.on .ni — подложка активной вкладки. */
  active: 'rgba(255,255,255,0.72)',
  activeShadow: 'inset 0px 1px 0px #FFFFFF, 0px 3px 10px -3px rgba(33,32,31,0.22)',
  /** .tl:active — нажатый пункт в стекле. */
  press: 'rgba(255,255,255,0.6)',
  /** .nav .lens — линза, которую тянут по меню. */
  lens: 'radial-gradient(120% 90% at 50% 0%, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0.03) 60%)',
  lensBg: 'rgba(255,255,255,0.05)',
  lensShadow: 'inset 0px 1.5px 0px #FFFFFF, inset 0px -2px 3px rgba(255,255,255,0.65), inset 0px 0px 0px 1px rgba(255,255,255,0.85), '
    + 'inset 3px 0px 7px rgba(255,255,255,0.45), inset -3px 0px 7px rgba(255,255,255,0.45), 0px 18px 36px -10px rgba(33,32,31,0.4), 0px 0px 0px 1px rgba(33,32,31,0.1)',
} as const;

/**
 * Слой жидкого стекла под содержимым (::before/::after в CSS): заливка, блики, кольцо и тень; `p` 0…1 — нажатие,
 * `squish` — во что сплющивается (у .ib 1.08 × .93, у .vb 1.07 × .93, у меню 1.025 × .96).
 */
/** Настоящее стекло iOS 26 (expo-glass-effect, UIGlassEffect) — размывает то, что под ним; иначе — заливка liquid.fill. */
let nativeGlassView: ComponentType<{ style?: StyleProp<ViewStyle>; glassEffectStyle?: 'clear' | 'regular'; colorScheme?: 'light' }> | null | undefined;
export function nativeGlass() {
  if (nativeGlassView === undefined) {
    nativeGlassView = null;
    if (Platform.OS === 'ios') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const m = require('expo-glass-effect');
        if (m.isLiquidGlassAvailable()) nativeGlassView = m.GlassView;
      } catch { nativeGlassView = null; }
    }
  }
  return nativeGlassView;
}

export function LiquidLayer({ radius: r = 999, p, reduce, squish = [1.08, 0.93], style }: {
  radius?: number; p?: Animated.Value; reduce?: boolean; squish?: readonly [number, number]; style?: StyleProp<ViewStyle>;
}) {
  const Glass = nativeGlass();
  if (Glass) {
    // стекло системы + те же внешнее кольцо и тень; блики рисует сама система
    return (
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: r, boxShadow: liquid.nativeShadow }, squishStyle(p, reduce, squish), style]}>
        <Glass glassEffectStyle="regular" colorScheme="light" style={[StyleSheet.absoluteFill, { borderRadius: r, overflow: 'hidden' }]} />
      </Animated.View>
    );
  }
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: r, backgroundImage: liquid.fill, boxShadow: liquid.shadow }, squishStyle(p, reduce, squish), style]} />;
}

/** Нажатие стекла: пружина (.34,1.56,.64,1) за 550 мс; при «уменьшить движение» — 120 мс без отскока. */
export function useGlassPress() {
  const p = useRef(new Animated.Value(0)).current;
  const reduce = useReduceMotion();
  const to = (v: number) => Animated.timing(p, {
    toValue: v, duration: reduce ? motion.press : 550, easing: reduce ? ease : glassEase, useNativeDriver: true,
  }).start();
  return { p, reduce, in: () => to(1), out: () => to(0) };
}

/** Нажимаемое жидкое стекло (.vb, .ib): слой сплющивается, содержимое на месте. Свой `style` — размер и раскладка. */
export function LiquidPress({ radius: r = 999, squish, style, layerStyle, children, disabled, onPressIn, onPressOut, ...rest }: Omit<PressableProps, 'style' | 'children'> & {
  radius?: number; squish?: readonly [number, number]; style?: StyleProp<ViewStyle>;
  /** Поверх стиля слоя (например, тёмная «включённая» кнопка без стекла). */
  layerStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const g = useGlassPress();
  return (
    <Pressable
      {...rest}
      disabled={disabled}
      onPressIn={(e) => { g.in(); onPressIn?.(e); }}
      onPressOut={(e) => { g.out(); onPressOut?.(e); }}
      style={[{ borderRadius: r }, style]}
    >
      <LiquidLayer radius={r} p={g.p} reduce={g.reduce} squish={squish} style={layerStyle} />
      {children}
    </Pressable>
  );
}

// ---------- кнопки ----------
/** primary=.cta (стекло GLASS-GREEN, «таблетка»), secondary=.soft, ghost=.txt, ghostDanger=.txt.red, danger=красная (.red), tg=.soft с самолётиком. */
export type BV = 'primary' | 'secondary' | 'ghost' | 'ghostDanger' | 'danger' | 'tg';
export function Button({
  title, onPress, v = 'primary', icon, iconNode, iconRight, textStyle, loading, disabled, style, small, value, haptic, accessibilityLabel, numberOfLines = 2, color,
}: {
  title: string; onPress?: () => void; v?: BV; icon?: IconName; iconRight?: IconName; loading?: boolean; disabled?: boolean;
  /** Своя иконка слева вместо Ionicons (например, линейка «Замер» из другого набора). */
  iconNode?: ReactNode;
  /** Свой размер текста (например, .soft 15/16 в рядах из двух кнопок). */
  textStyle?: StyleProp<TextStyle>;
  style?: StyleProp<ViewStyle>;
  /** .sm — высота 44, радиус 14, шрифт 15. */
  small?: boolean;
  /** .cta.val — значение справа в полупрозрачной плашке («осталось 2», сумма). */
  value?: string | null;
  /** Вибрация при нажатии: success — оплата/заказ, error, light. */
  haptic?: 'light' | 'success' | 'error';
  accessibilityLabel?: string; numberOfLines?: number;
  /** Свой цвет текста/иконки (например серый .txt «Пропустить» #55524D в онбординге). */
  color?: string;
}) {
  const ctrl = useControlBg();
  const off = !!disabled;
  const busy = !!loading;
  const text = v === 'ghost' || v === 'ghostDanger';
  const cta = v === 'primary' || v === 'danger';
  // основная — стекло; выключенная остаётся серой .cta.off (той же «таблеткой», чтобы форма не прыгала)
  const isGlass = v === 'primary' && !off;
  const pill = v === 'primary';
  const bg = text || isGlass ? 'transparent'
    : off && cta ? palette.off
      : v === 'danger' ? palette.red : ctrl;
  const fg = color ?? (off && cta ? palette.faint
    : isGlass ? glass.fg : cta ? palette.white : v === 'ghost' ? palette.greenPress : v === 'ghostDanger' ? palette.redText : palette.ink);
  const ico = icon ?? (v === 'tg' ? 'paper-plane-outline' : undefined);
  const icoColor = v === 'tg' && !off ? colors.tg : fg;
  const txtStyle: TextStyle = text ? type.txt : small ? type.btnSm : cta ? type.btn : type.btnSoft;
  const hasVal = value != null && value !== '' && !small;
  const press = () => {
    if (off || busy) return;
    if (haptic) haptics[haptic]();
    onPress?.();
  };
  const a11y = {
    accessibilityRole: 'button' as const,
    accessibilityLabel: accessibilityLabel ?? (hasVal ? `${title}, ${value}` : title),
    accessibilityState: { disabled: off, busy },
    onPress: press,
    disabled: off || busy,
  };
  const boxStyle = [
    text ? st.txt : small ? st.sm : st.btn,
    !text && { backgroundColor: bg },
    pill && { borderRadius: 999 },
    cta && !small && st.ctaPad,
    hasVal && st.val,
    off && !cta && { opacity: 0.45 },
    style,
  ];
  const content = (
    <>
      <View style={[st.inner, hasVal && { flex: 1, justifyContent: 'flex-start' }, { gap: text ? 6 : cta ? 10 : 8 }, busy && { opacity: 0 }]}>
        {iconNode ?? (ico ? <Ionicons name={ico} size={small || text ? 18 : 22} color={icoColor} /> : null)}
        <Text style={resolveFont([txtStyle, { color: fg, textAlign: 'center', flexShrink: 1 }, isGlass && glass.text, textStyle])} numberOfLines={numberOfLines}>{title}</Text>
        {iconRight ? <Ionicons name={iconRight} size={small || text ? 18 : 22} color={fg} /> : null}
      </View>
      {hasVal ? (
        <View style={[st.v, isGlass && st.vGlass, busy && { opacity: 0 }]}>
          <Text style={resolveFont([st.vText, { color: fg }])} numberOfLines={1}>{value}</Text>
        </View>
      ) : null}
      {busy ? <View style={[StyleSheet.absoluteFill, st.center]} pointerEvents="none"><ActivityIndicator color={fg} /></View> : null}
    </>
  );
  if (isGlass) return <GlassPress {...a11y} style={boxStyle}>{content}</GlassPress>;
  return (
    <Press {...a11y} feedback={text ? 'opacity' : off ? 'none' : 'scale'} style={boxStyle}>
      {content}
    </Press>
  );
}

/**
 * .ib — круглая кнопка 44. На фоне экрана — жидкое стекло (Liquid Glass: заливка, блики, тень; нажатие сплющивает
 * стекло 1.08 × .93, иконка на месте); внутри белого (Card, Sheet, футер-бар) — серая #F2F1EE; flat — прозрачная;
 * dark — тёмная (аватар цеха); `glass={false}` — прежняя белая. badge — красная точка.
 */
export function IconButton({ icon, onPress, label, disabled, color = palette.ink, style, flat, badge, size = 44, iconSize = 22, dark, glass: glassOn = true, children }: {
  icon?: IconName; onPress?: () => void; label: string; disabled?: boolean; color?: string; style?: StyleProp<ViewStyle>;
  flat?: boolean; badge?: boolean; size?: number; iconSize?: number;
  /** Тёмная (аватар цеха в шапке). */
  dark?: boolean;
  /** false — белая/серая без стекла. */
  glass?: boolean;
  children?: ReactNode;
}) {
  const ctrl = useControlBg();
  const onWhite = useSurface() === 'white';
  const liquidOn = glassOn && !flat && !dark && !onWhite;
  const a11y = {
    accessibilityLabel: label,
    accessibilityRole: 'button' as const,
    accessibilityState: { disabled: !!disabled },
    onPress: disabled ? undefined : onPress,
    disabled,
    hitSlop: 4,
  };
  const content = (
    <>
      {icon ? <Ionicons name={icon} size={iconSize} color={dark ? palette.white : color} /> : children}
      {badge ? <View style={[st.badge, { borderColor: flat ? palette.ground : liquidOn ? palette.white : ctrl }]} /> : null}
    </>
  );
  const dims = { width: size, height: size, borderRadius: size / 2 };
  if (liquidOn) return <LiquidPress {...a11y} radius={size / 2} style={[st.ib, dims, disabled && { opacity: 0.35 }, style]}>{content}</LiquidPress>;
  return (
    <Press {...a11y} style={[st.ib, dims, { backgroundColor: flat ? 'transparent' : dark ? palette.ink : ctrl }, disabled && { opacity: 0.35 }, style]}>
      {content}
    </Press>
  );
}

const st = StyleSheet.create({
  btn: { minHeight: 56, borderRadius: radius.btn, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  ctaPad: { paddingHorizontal: 20 },
  sm: { minHeight: 44, borderRadius: radius.sm, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  txt: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  val: { justifyContent: 'space-between', paddingLeft: 20, paddingRight: 8, gap: 10 },
  inner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexShrink: 1, paddingVertical: 6 },
  v: { height: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.16)', justifyContent: 'center', paddingHorizontal: 12 },
  vGlass: { backgroundColor: glass.chip, boxShadow: glass.chipShadow },
  vText: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 20, fontVariant: ['tabular-nums'] },
  center: { alignItems: 'center', justifyContent: 'center' },
  ib: { alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: 7, right: 8, width: 13, height: 13, borderRadius: 7, backgroundColor: palette.red, borderWidth: 2 },
});
