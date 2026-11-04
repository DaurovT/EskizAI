/**
 * Примитивы V3: текст T с Onest, «поверхность» (белое/серое), нажатие со сжатием, кнопки.
 * Импортируйте через './kit' — там всё реэкспортировано.
 */
import { Ionicons } from '@expo/vector-icons';
import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, View,
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

// ---------- кнопки ----------
/** primary=.cta, secondary=.soft, ghost=.txt, ghostDanger=.txt.red, danger=красная (.red), tg=.soft с самолётиком. */
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
  const bg = text ? 'transparent'
    : off && cta ? palette.off
      : v === 'primary' ? palette.green : v === 'danger' ? palette.red : ctrl;
  const fg = color ?? (off && cta ? palette.faint
    : cta ? palette.white : v === 'ghost' ? palette.greenPress : v === 'ghostDanger' ? palette.redText : palette.ink);
  const ico = icon ?? (v === 'tg' ? 'paper-plane-outline' : undefined);
  const icoColor = v === 'tg' && !off ? colors.tg : fg;
  const txtStyle: TextStyle = text ? type.txt : small ? type.btnSm : cta ? type.btn : type.btnSoft;
  const hasVal = value != null && value !== '' && !small;
  const press = () => {
    if (off || busy) return;
    if (haptic) haptics[haptic]();
    onPress?.();
  };
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (hasVal ? `${title}, ${value}` : title)}
      accessibilityState={{ disabled: off, busy }}
      onPress={press}
      disabled={off || busy}
      feedback={text ? 'opacity' : off ? 'none' : 'scale'}
      style={[
        text ? st.txt : small ? st.sm : st.btn,
        !text && { backgroundColor: bg },
        cta && !small && st.ctaPad,
        hasVal && st.val,
        off && !cta && { opacity: 0.45 },
        style,
      ]}
    >
      <View style={[st.inner, hasVal && { flex: 1, justifyContent: 'flex-start' }, { gap: text ? 6 : cta ? 10 : 8 }, busy && { opacity: 0 }]}>
        {iconNode ?? (ico ? <Ionicons name={ico} size={small || text ? 18 : 22} color={icoColor} /> : null)}
        <Text style={resolveFont([txtStyle, { color: fg, textAlign: 'center', flexShrink: 1 }, textStyle])} numberOfLines={numberOfLines}>{title}</Text>
        {iconRight ? <Ionicons name={iconRight} size={small || text ? 18 : 22} color={fg} /> : null}
      </View>
      {hasVal ? <View style={[st.v, busy && { opacity: 0 }]}><Text style={resolveFont([st.vText, { color: fg }])} numberOfLines={1}>{value}</Text></View> : null}
      {busy ? <View style={[StyleSheet.absoluteFill, st.center]} pointerEvents="none"><ActivityIndicator color={fg} /></View> : null}
    </Press>
  );
}

/** .ib — круглая кнопка 44 (белая на фоне, серая внутри белого); flat — прозрачная; badge — красная точка. */
export function IconButton({ icon, onPress, label, disabled, color = palette.ink, style, flat, badge, size = 44, iconSize = 22, dark, children }: {
  icon?: IconName; onPress?: () => void; label: string; disabled?: boolean; color?: string; style?: StyleProp<ViewStyle>;
  flat?: boolean; badge?: boolean; size?: number; iconSize?: number;
  /** Тёмная (аватар цеха в шапке). */
  dark?: boolean; children?: ReactNode;
}) {
  const ctrl = useControlBg();
  return (
    <Press
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      hitSlop={4}
      style={[st.ib, { width: size, height: size, borderRadius: size / 2, backgroundColor: flat ? 'transparent' : dark ? palette.ink : ctrl }, disabled && { opacity: 0.35 }, style]}
    >
      {icon ? <Ionicons name={icon} size={iconSize} color={dark ? palette.white : color} /> : children}
      {badge ? <View style={[st.badge, { borderColor: flat ? palette.ground : ctrl }]} /> : null}
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
  vText: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 20, fontVariant: ['tabular-nums'] },
  center: { alignItems: 'center', justifyContent: 'center' },
  ib: { alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: 7, right: 8, width: 13, height: 13, borderRadius: 7, backgroundColor: palette.red, borderWidth: 2 },
});
