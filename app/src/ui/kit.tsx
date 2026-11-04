/**
 * UI-кит V3 (docs/design, блок /*V3*\/). Каталог компонентов — src/ui/README.md.
 * Примитивы (T, Button, IconButton, Press, поверхность) — в base.tsx, шторка/окно/тост — в overlays.tsx; всё доступно отсюда.
 */
import { Ionicons } from '@expo/vector-icons';
import { Children, forwardRef, isValidElement, useEffect, useImperativeHandle, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  ActivityIndicator, Animated, Image, Keyboard, LayoutAnimation, Platform, ScrollView, StyleSheet, Text, TextInput, View,
  type RefreshControlProps, type StyleProp, type TextInputInstance, type ViewInstance, type TextInputProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, palette, radius, space, statusTone, tagTones, bannerTones, tones, type, type BannerTone, type TagTone, type Tone } from './theme';
import {
  IconButton, Press, RowInsetProvider, SeparatorProvider, SurfaceProvider, T, ease, resolveFont,
  useControlBg, useReduceMotion, useRowInset, useSeparator, useSurface, type IconName,
} from './base';
import { haptics } from './haptics';
import { useT } from '../i18n';
import { useOffline } from '../state/net';
import { MOCK, SHOTS_MODE } from '../config';

export * from './base';
export * from './overlays';

// ---------- раскладка ----------
export const Row = ({ children, style, gap = space.s }: { children: ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) => (
  <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>
);
export const Gap = ({ h = space.m }: { h?: number }) => <View style={{ height: h }} />;
/** Растяжка (.grow). */
export const Grow = () => <View style={{ flex: 1 }} />;

// ---------- карточки ----------
/** .sheet — белая карточка r28. padded (по умолчанию) — отступы 16/20; padded={false} — для строк и картинок во всю ширину. */
export function Card({ children, onPress, style, padded = true, accessibilityLabel }: {
  children: ReactNode; onPress?: () => void; style?: StyleProp<ViewStyle>; padded?: boolean; accessibilityLabel?: string;
}) {
  const inner = (
    <SurfaceProvider value="white">
      <RowInsetProvider value={padded ? 0 : 20}>{children}</RowInsetProvider>
    </SurfaceProvider>
  );
  const box = [st.card, padded && st.cardPad, style];
  if (!onPress) return <View style={box}>{inner}</View>;
  return <Press onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={box}>{inner}</Press>;
}

/** .sheet со строками: волосяные линии между дочерними ListItem/MenuItem (.row+.row). */
export function Group({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const items = Children.toArray(children).filter(isValidElement) as ReactElement[];
  return (
    <View style={[st.card, style]}>
      <SurfaceProvider value="white">
        <RowInsetProvider value={20}>
          {items.map((c, i) => <SeparatorProvider key={c.key ?? i} value={i > 0}>{c}</SeparatorProvider>)}
        </RowInsetProvider>
      </SurfaceProvider>
    </View>
  );
}

/** Заголовок секции над карточкой (.sh: 19/24 жирный, отступ 8). */
export function SectionTitle({ children, right, style }: { children: ReactNode; right?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <Row style={[{ paddingHorizontal: 8, paddingTop: 4 }, style]}>
      <T v="h3" style={{ flex: 1, fontSize: 19 }}>{children}</T>
      {right}
    </Row>
  );
}

/** Строка .row: иконка в плитке, заголовок .rt, подпись .rs, значение .rv, шеврон; внутри Group — с разделителями. */
export function ListItem({
  title, subtitle, right, onPress, icon, value, valueMuted, left, danger, chevron, compact, numberOfLines, disabled, accessibilityLabel, style, children,
}: {
  title: string; subtitle?: string | null; right?: ReactNode; onPress?: () => void; icon?: IconName;
  /** Значение справа: .rv (жирное, табличные цифры) или, с valueMuted, серое .vv. */
  value?: string | null; valueMuted?: boolean;
  /** Своё содержимое слева вместо плитки с иконкой (Thumb, Avatar). */
  left?: ReactNode;
  /** Красная строка («Выйти», «Удалить аккаунт»). */
  danger?: boolean;
  /** Шеврон: по умолчанию — если есть onPress и нет right. */
  chevron?: boolean;
  /** Плотная строка (мин. 48, плитка 36) — как в профиле и карточке проекта. */
  compact?: boolean;
  numberOfLines?: number; disabled?: boolean; accessibilityLabel?: string; style?: StyleProp<ViewStyle>;
  /** Доп. содержимое под подписью (статус, подсказка). */
  children?: ReactNode;
}) {
  const inset = useRowInset();
  const sep = useSeparator();
  const showChev = chevron ?? (!!onPress && !right);
  const fg = danger ? palette.redText : palette.ink;
  const content = (
    <>
      {sep ? <View style={st.sep} /> : null}
      {left ?? (icon ? <Tile icon={icon} size={compact ? 's' : 'm'} danger={danger} /> : null)}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T v="rt" color={fg} numberOfLines={numberOfLines}>{title}</T>
        {subtitle ? <T v="rs" numberOfLines={numberOfLines}>{subtitle}</T> : null}
        {children}
      </View>
      {value != null && value !== '' ? <T v={valueMuted ? 'rs' : 'rv'} style={valueMuted ? { fontSize: 15 } : null} num numberOfLines={1}>{value}</T> : null}
      {right}
      {showChev ? <Ionicons name="chevron-forward" size={18} color={palette.chev} /> : null}
    </>
  );
  const box = [st.row, { paddingHorizontal: inset }, compact && st.rowCompact, disabled && { opacity: 0.45 }, style];
  if (!onPress) return <View style={box}>{content}</View>;
  return (
    <Press feedback="row" onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} style={box}>
      {content}
    </Press>
  );
}

// ---------- шапка ----------
/**
 * .hdr: круглая кнопка «назад» (.ib), необязательный заголовок в строке (.ht), правый слот; ниже — большой заголовок (.big).
 * Обычно рисуется навигатором (src/ui/navigation.tsx) из options экрана; вручную — для экранов с headerShown: false.
 */
export function Header({ back, onBack, backIcon = 'back', backLabel, title, left, right, big, bigSize = 'push', sub, topInset = 0, style }: {
  /** Показать кнопку «назад» (по умолчанию — если передан onBack). */
  back?: boolean; onBack?: () => void; backIcon?: 'back' | 'close'; backLabel?: string;
  /** Заголовок в строке шапки (.ht 18/600). */
  title?: string;
  /** Своё содержимое слева вместо «назад» (аватар цеха, логотип). */
  left?: ReactNode; right?: ReactNode;
  /** Большой заголовок под шапкой. */
  big?: string; bigSize?: 'root' | 'push'; sub?: string;
  topInset?: number; style?: StyleProp<ViewStyle>;
}) {
  const { t } = useT();
  const showBack = back ?? !!onBack;
  const hasRow = showBack || !!left || !!right || !!title;
  return (
    <View style={[{ paddingTop: topInset }, style]}>
      {hasRow ? (
        <View style={st.hdr}>
          {left ?? (showBack ? <IconButton icon={backIcon === 'close' ? 'close' : 'chevron-back'} label={backLabel ?? (backIcon === 'close' ? t('close') : t('back'))} onPress={onBack} /> : null)}
          {title ? <Text style={resolveFont([type.ht, { flex: 1 }])} numberOfLines={1}>{title}</Text> : <View style={{ flex: 1 }} />}
          {right ? <View style={st.hdrRight}>{right}</View> : null}
        </View>
      ) : <View style={{ height: 14 }} />}
      {big ? <BigTitle size={bigSize} sub={sub} inset={20} style={{ paddingBottom: 4 }}>{big}</BigTitle> : null}
    </View>
  );
}

/** .big — крупный заголовок экрана (root 30/36, push 28/34) и подзаголовок .sub. inset 8 — внутри тела экрана, 20 — в шапке. */
export function BigTitle({ children, sub, size = 'root', inset = 8, style }: { children: ReactNode; sub?: string; size?: 'root' | 'push'; inset?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ paddingHorizontal: inset, paddingTop: 4 }, style]} accessibilityRole="header">
      <T v={size === 'root' ? 'big' : 'bigPush'}>{children}</T>
      {sub ? <T v="sub" style={{ marginTop: 6 }}>{sub}</T> : null}
    </View>
  );
}

// ---------- экран ----------
/**
 * Экран: фон #F2F1EE, тело .body (отступы 8/12/12, gap 10), прокрутка, офлайн-плашка, футер .foot или .foot.bar.
 * Шапку рисует навигатор; для экранов без неё — проп header (<Header …/>) и edges={['top','bottom']}.
 */
export function Screen({
  children, scroll = true, footer, footerBar, edges = ['bottom'], padded = true, gap = space.gap, header, refreshControl, contentStyle, style, footerStyle,
}: {
  children: ReactNode; scroll?: boolean; footer?: ReactNode;
  /** Футер белой плашкой со скруглением 28 сверху (.foot.bar); контролы внутри — серые. */
  footerBar?: boolean;
  edges?: ('top' | 'bottom')[]; padded?: boolean;
  /** Расстояние между блоками тела (.body gap 10). */
  gap?: number;
  header?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  contentStyle?: StyleProp<ViewStyle>; style?: StyleProp<ViewStyle>;
  /** Свои отступы/gap футера (например, `.foot` с gap 2 и padding-top 6 в макетах SCR-04/05). */
  footerStyle?: StyleProp<ViewStyle>;
}) {
  const pad = [padded && st.body, { gap }, contentStyle];
  const box = useRef<ViewInstance>(null);
  const kb = useKeyboardOverlap(box);
  const bottomInset = useSafeAreaInsets().bottom;
  const body = scroll ? (
    <ScrollView contentContainerStyle={[pad, { paddingBottom: footer ? space.m : space.xxl, flexGrow: 1 }]} keyboardShouldPersistTaps="handled" refreshControl={refreshControl}>
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, pad]}>{children}</View>
  );
  // с футером нижнюю безопасную зону забирает сам футер (белая плашка доходит до края)
  const safeEdges = footer ? edges.filter((e) => e !== 'bottom') : edges;
  return (
    <SafeAreaView style={[st.screen, style]} edges={safeEdges}>
      {header}
      <OfflineBanner />
      {/* футер и поле у низа — ровно над клавиатурой (KeyboardAvoidingView ошибался на высоту шапки стека) */}
      <View ref={box} style={{ flex: 1, paddingBottom: footer && kb ? Math.max(0, kb - bottomInset + 8) : kb }}>
        {body}
        {footer ? <Footer bar={footerBar} style={footerStyle}>{footer}</Footer> : null}
      </View>
    </SafeAreaView>
  );
}

/**
 * Насколько клавиатура перекрывает низ контейнера, pt (iOS; на Android окно само сжимается — 0).
 * Считается по положению контейнера в окне, поэтому верно под любой шапкой и над вкладками.
 */
export function useKeyboardOverlap(ref: { current: ViewInstance | null }): number {
  const [overlap, setOverlap] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const animate = (duration?: number) => {
      if (duration) LayoutAnimation.configureNext({ duration, update: { type: LayoutAnimation.Types.keyboard } });
    };
    const change = Keyboard.addListener('keyboardWillChangeFrame', (e) => {
      const top = e.endCoordinates.screenY;
      ref.current?.measureInWindow((_x, y, _w, h) => {
        const next = Math.max(0, Math.round(y + h - top));
        setOverlap((cur) => { if (cur !== next) animate(e.duration); return next; });
      });
    });
    const hide = Keyboard.addListener('keyboardWillHide', (e) => { animate(e.duration); setOverlap(0); });
    return () => { change.remove(); hide.remove(); };
  }, [ref]);
  return overlap;
}

/** .foot (прозрачный, отступы 10/12, gap 8) или .foot.bar (белый, r28 сверху). Сам добавляет нижнюю безопасную зону. */
export function Footer({ children, bar, style }: { children: ReactNode; bar?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <SafeAreaView edges={{ bottom: 'maximum' }} style={[bar ? st.footBar : st.foot, style]}>
      <SurfaceProvider value={bar ? 'white' : 'ground'}>{children}</SurfaceProvider>
    </SafeAreaView>
  );
}
/** Ряд кнопок .fr: дети с style={{ flex: 1 }} делят ширину. */
export const ButtonRow = ({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) => (
  <View style={[{ flexDirection: 'row', gap: 8 }, style]}>{children}</View>
);

/** Офлайн: тёмная плашка «Нет сети · показана сохранённая версия» (Errors.dc.html). */
export function OfflineBanner() {
  const offline = useOffline();
  const { t } = useT();
  if (!offline) return MOCK && !SHOTS_MODE ? <View style={st.mock}><T v="cap" style={{ color: colors.estimate, fontSize: 13 }}>{t('mock_badge')}</T></View> : null;
  return (
    <View style={st.offline} accessibilityLiveRegion="polite">
      <Ionicons name="cloud-offline-outline" size={18} color={palette.white} />
      <Text style={resolveFont([st.offlineText])}>{t('err_offline_banner')}</Text>
    </View>
  );
}

// ---------- поля ----------
type FieldProps = TextInputProps & {
  /** Подпись внутри поля над значением (.fl). */
  label?: string;
  error?: string | null;
  /** Значение — оценка ИИ (.fld.est, янтарная рамка и метка «оценка»). */
  estimate?: boolean;
  /** Подсказка под полем. */
  hint?: string;
  /** Мин. высота многострочного поля (по умолчанию 112; «Заметки для цеха» в замере — 68). */
  multilineMinHeight?: number;
  /** Содержимое справа внутри поля (единица, иконка). */
  right?: ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
};
/** .fld — белое поле r16 (серое внутри белого) с подписью внутри; фокус — рамка 2 px #21201F, ошибка — красная. */
export const Field = forwardRef<TextInputInstance, FieldProps>(function Field({ label, error, estimate, hint, right, style, containerStyle, onFocus, onBlur, multiline, editable, multilineMinHeight = 112, ...props }, ref) {
  const ctrl = useControlBg();
  const inner = useRef<TextInputInstance>(null);
  useImperativeHandle(ref, () => inner.current as TextInputInstance);
  const [focus, setFocus] = useState(false);
  const ring = error ? palette.red : focus ? palette.ink : estimate ? '#F3CF8F' : 'transparent';
  const bg = error ? '#FFF5F4' : focus ? palette.white : estimate ? '#FFF9EE' : ctrl;
  return (
    <View style={containerStyle}>
      <Press feedback="none" onPress={() => inner.current?.focus()} accessible={false}
        style={[st.fld, { backgroundColor: bg, borderColor: ring }, multiline && { minHeight: multilineMinHeight, justifyContent: 'flex-start' }, editable === false && { opacity: 0.6 }]}>
        {label || estimate ? (
          <Row gap={6}>
            {label ? <T v="fl" style={{ flex: 1 }} numberOfLines={1}>{label}</T> : <View style={{ flex: 1 }} />}
            {estimate ? <EstimateBadge /> : null}
          </Row>
        ) : null}
        <Row gap={8} style={multiline ? { alignItems: 'flex-start', flex: 1 } : null}>
          <TextInput
            ref={inner}
            placeholderTextColor={palette.faint}
            accessibilityLabel={props.accessibilityLabel ?? label}
            {...props}
            editable={editable}
            multiline={multiline}
            onFocus={(e) => { setFocus(true); onFocus?.(e); }}
            onBlur={(e) => { setFocus(false); onBlur?.(e); }}
            style={[resolveFont([st.input, multiline && { textAlignVertical: 'top', minHeight: Math.max(23, multilineMinHeight - 43) }, style])]}
          />
          {right}
        </Row>
      </Press>
      {error ? <T v="cap" color={palette.redText} style={st.under}>{error}</T> : hint ? <T v="cap" style={st.under}>{hint}</T> : null}
    </View>
  );
});

/** .search — поле поиска h48 r16 с лупой и крестиком очистки. */
export function Search({ value, onChangeText, placeholder, style, autoFocus, onSubmitEditing }: {
  value: string; onChangeText: (v: string) => void; placeholder?: string; style?: StyleProp<ViewStyle>; autoFocus?: boolean; onSubmitEditing?: () => void;
}) {
  const ctrl = useControlBg();
  const { t } = useT();
  return (
    <View style={[st.search, { backgroundColor: ctrl }, style]}>
      <Ionicons name="search" size={20} color={palette.faint} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.faint}
        returnKeyType="search"
        autoFocus={autoFocus}
        onSubmitEditing={onSubmitEditing}
        accessibilityLabel={placeholder ?? t('search')}
        style={resolveFont([type.body, { flex: 1, paddingVertical: 0, height: 48 }])}
      />
      {value ? (
        <Press feedback="opacity" onPress={() => onChangeText('')} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('close')}>
          <Ionicons name="close-circle" size={20} color={palette.chev} />
        </Press>
      ) : null}
    </View>
  );
}

// ---------- выбор ----------
/** .chip — h40 r20; выбранный — чёрный с белым текстом; count — серое число (.n). tone='warn' — янтарный. */
export function Chip({ label, selected, onPress, icon, tone, count, disabled, style }: {
  label: string; selected?: boolean; onPress?: () => void; icon?: IconName; tone?: 'warn'; count?: number | string | null; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const ctrl = useControlBg();
  const warn = tone === 'warn' && !selected;
  const bg = selected ? palette.ink : warn ? palette.amberSoft : ctrl;
  const fg = selected ? palette.white : warn ? palette.amberDeep : palette.ink;
  return (
    <Press onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ selected: !!selected, disabled: !!disabled }} accessibilityLabel={count != null ? `${label} ${count}` : label}
      style={[st.chip, { backgroundColor: bg }, disabled && { opacity: 0.45 }, style]}>
      {icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
      <Text style={resolveFont([type.chip, { color: fg }])} numberOfLines={1}>{label}</Text>
      {count != null ? <Text style={resolveFont([type.chip, type.num, { color: selected ? '#A9A6A0' : palette.count }])}>{count}</Text> : null}
    </Press>
  );
}

/** Горизонтальная лента чипов с прокруткой (.chips). */
export function ChipRow({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[{ flexGrow: 0, marginHorizontal: -12 }, style]} contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}>
      {children}
    </ScrollView>
  );
}

/** .opt — вариант выбора h56 r16; выбранный — чёрный. */
export function Option({ title, subtitle, selected, onPress, icon, right, disabled, style }: {
  title: string; subtitle?: string | null; selected?: boolean; onPress?: () => void; icon?: IconName; right?: ReactNode; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const ctrl = useControlBg();
  const fg = selected ? palette.white : palette.ink;
  return (
    <Press onPress={onPress} disabled={disabled} accessibilityRole="radio" accessibilityState={{ selected: !!selected, disabled: !!disabled }} accessibilityLabel={title}
      style={[st.opt, { backgroundColor: selected ? palette.ink : ctrl }, disabled && { opacity: 0.45 }, style]}>
      {icon ? <Ionicons name={icon} size={22} color={fg} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={resolveFont([type.rt, { color: fg }])}>{title}</Text>
        {subtitle ? <Text style={resolveFont([type.rs, selected && { color: palette.chev }])}>{subtitle}</Text> : null}
      </View>
      {right}
    </Press>
  );
}

/** .seg — переключатель вкладок; внутри белого — фон #EDECE9. */
export function Segmented<V extends string>({ value, options, onChange, style }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; style?: StyleProp<ViewStyle> }) {
  const onWhite = useSurface() === 'white';
  return (
    <View style={[st.seg, onWhite && { backgroundColor: palette.segOnWhite }, style]} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Press key={o.value} feedback="opacity" onPress={() => { if (!on) { haptics.selection(); onChange(o.value); } }} style={[st.sg, on && st.sgOn]} accessibilityRole="tab" accessibilityState={{ selected: on }}>
            <Text style={resolveFont([type.sg])} numberOfLines={1}>{o.label}</Text>
          </Press>
        );
      })}
    </View>
  );
}

/** .tog — переключатель 51×31, зелёный во включённом состоянии. */
export function Toggle({ value, onValueChange, disabled, accessibilityLabel }: { value: boolean; onValueChange?: (v: boolean) => void; disabled?: boolean; accessibilityLabel?: string }) {
  const a = useRef(new Animated.Value(value ? 1 : 0)).current;
  const reduce = useReduceMotion();
  useEffect(() => {
    Animated.timing(a, { toValue: value ? 1 : 0, duration: reduce ? 0 : 200, easing: ease, useNativeDriver: false }).start();
  }, [value, a, reduce]);
  return (
    <Press feedback="none" disabled={disabled} onPress={() => { haptics.light(); onValueChange?.(!value); }} hitSlop={8}
      accessibilityRole="switch" accessibilityState={{ checked: value, disabled: !!disabled }} accessibilityLabel={accessibilityLabel}
      style={disabled ? { opacity: 0.45 } : null}>
      <Animated.View style={[st.tog, { backgroundColor: a.interpolate({ inputRange: [0, 1], outputRange: [palette.togOff, palette.green] }) }]}>
        <Animated.View style={[st.knob, { transform: [{ translateX: a.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }] }]} />
      </Animated.View>
    </Press>
  );
}

// ---------- метки ----------
/** .st — плашка статуса h26 r9 (tone: green/amber/blue/red/gray) или со своими fg/bg. */
export function Badge({ label, fg, bg, tone, style }: { label: string; fg?: string; bg?: string; tone?: Tone; style?: StyleProp<ViewStyle> }) {
  const c = tones[tone ?? 'gray'];
  return (
    <View style={[st.st, { backgroundColor: bg ?? c.bg }, style]}>
      <Text style={resolveFont([type.st, { color: fg ?? c.fg }])} numberOfLines={1}>{label}</Text>
    </View>
  );
}
/** .tag — метка h24 r8: est (оценка) / info (под запрос) / ok / n / err. */
export function Tag({ label, tone = 'n', icon, style }: { label: string; tone?: TagTone; icon?: IconName; style?: StyleProp<ViewStyle> }) {
  const c = tagTones[tone];
  return (
    <View style={[st.tag, { backgroundColor: c.bg }, style]}>
      {icon ? <Ionicons name={icon} size={13} color={c.fg} /> : null}
      <Text style={resolveFont([type.tag, { color: c.fg }])} numberOfLines={1}>{label}</Text>
    </View>
  );
}
/** «оценка» — .tag.est. */
export function EstimateBadge({ style }: { style?: StyleProp<ViewStyle> }) {
  const { t } = useT();
  return <Tag label={t('estimate_mark')} tone="est" style={style} />;
}
/** Статус проекта: цвет по theme.statusTone. */
export function StatusBadge({ status, archived, style }: { status: string; archived?: boolean; style?: StyleProp<ViewStyle> }) {
  const { t, td } = useT();
  return <Badge label={archived ? t('st_archived') : td(`st_${status}`, status)} tone={archived ? 'gray' : statusTone[status] ?? 'gray'} style={style} />;
}
/** Цветная точка .dot (8 px). */
export const Dot = ({ tone = 'gray', size = 8 }: { tone?: Tone; size?: number }) => (
  <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tones[tone].dot }} />
);

/** .ban — баннер r20: ok / est / info / err / n(белый). action — кнопка-текст справа («Тарифы»). */
export function Banner({ tone = 'info', title, text, icon, action, onPress, children, style, textStyle }: {
  tone?: BannerTone; title?: string; text?: string; icon?: IconName;
  /** Свой размер текста (.bd 15/20 в замере и файлах). */
  textStyle?: StyleProp<TextStyle>;
  action?: { label: string; onPress: () => void }; onPress?: () => void; children?: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const c = bannerTones[tone];
  const inner = (
    <SurfaceProvider value={tone === 'n' ? 'white' : 'ground'}>
      {icon ? <Ionicons name={icon} size={20} color={c.fg} style={{ marginTop: 1 }} /> : null}
      <View style={{ flex: 1 }}>
        {title ? <Text style={resolveFont([type.bt, { color: c.fg }])}>{title}</Text> : null}
        {text ? <Text style={resolveFont([type.bd, { color: c.fg }, textStyle])}>{text}</Text> : null}
        {children}
      </View>
      {action ? (
        <Press feedback="opacity" onPress={action.onPress} accessibilityRole="button" accessibilityLabel={action.label} style={st.ba}>
          <Text style={resolveFont([type.btnSm, { color: c.fg }])}>{action.label}</Text>
        </Press>
      ) : null}
    </SurfaceProvider>
  );
  const box = [st.ban, { backgroundColor: c.bg }, (action || !text || !title) && { alignItems: 'center' as const }, style];
  if (onPress) return <Press onPress={onPress} accessibilityRole="button" style={box}>{inner}</Press>;
  return <View style={box}>{inner}</View>;
}

// ---------- картинки ----------
/** .tile — плитка 44 r14 с иконкой (s — 36 r12); серая на белом, белая на сером фоне. */
export function Tile({ icon, size = 'm', danger, color, bg, children, style }: {
  icon?: IconName; size?: 's' | 'm'; danger?: boolean; color?: string; bg?: string; children?: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const onWhite = useSurface() === 'white';
  const d = size === 's' ? 36 : 44;
  return (
    <View style={[st.center, { width: d, height: d, borderRadius: size === 's' ? 12 : radius.tile, backgroundColor: bg ?? (danger ? palette.redSoft : onWhite ? palette.ground : palette.white) }, style]}>
      {icon ? <Ionicons name={icon} size={size === 's' ? 20 : 22} color={color ?? (danger ? palette.redText : palette.ink)} /> : children}
    </View>
  );
}
/** .thumb — превью 56 r16 на «деревянном» фоне (#F4EBDD); uri — фото. */
export function Thumb({ uri, icon, size = 56, style, children }: { uri?: string | null; icon?: IconName; size?: number; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  return (
    <View style={[st.center, { width: size, height: size, borderRadius: radius.thumb, backgroundColor: palette.wood, overflow: 'hidden' }, style]}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : icon ? <Ionicons name={icon} size={Math.round(size / 2)} color="#9A7B55" /> : children}
    </View>
  );
}
/** .av — аватар 44 с инициалами; dark — чёрный (цех). */
export function Avatar({ name, uri, size = 44, dark, style, color }: {
  name?: string | null; uri?: string | null; size?: number; dark?: boolean; style?: StyleProp<ViewStyle>;
  /** Цвет инициалов (например синий на #E6EEFF у сотрудника в Team.dc.html). */
  color?: string;
}) {
  const initials = (name ?? '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '·';
  return (
    <View style={[st.center, { width: size, height: size, borderRadius: size / 2, backgroundColor: dark ? palette.ink : palette.segOnWhite, overflow: 'hidden' }, style]}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} /> : (
        <Text style={resolveFont([type.btnSm, { color: color ?? (dark ? palette.white : palette.ink), fontSize: size >= 60 ? 22 : 15 }])}>{initials}</Text>
      )}
    </View>
  );
}

// ---------- состояния ----------
/** Спиннер ожидания; delay — показать не раньше 300 мс (быстрые ответы без мигания). */
export function Loading({ label, delay = 300 }: { label?: string; delay?: number }) {
  const [show, setShow] = useState(delay <= 0);
  useEffect(() => { if (delay <= 0) return; const id = setTimeout(() => setShow(true), delay); return () => clearTimeout(id); }, [delay]);
  return (
    <View style={[st.center, { flex: 1, padding: space.xl }]}>
      {show ? <ActivityIndicator size="large" color={palette.green} /> : null}
      {show && label ? <T v="sub" center style={{ marginTop: space.m }}>{label}</T> : null}
    </View>
  );
}

/** Скелетон: пульсирующий блок #ECEBE7 (при «уменьшить движение» — статичный). */
export function Skeleton({ width = '100%', height = 16, r = 12, style }: { width?: ViewStyle['width']; height?: number; r?: number; style?: StyleProp<ViewStyle> }) {
  const a = useRef(new Animated.Value(1)).current;
  const reduce = useReduceMotion();
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 0.5, duration: 600, useNativeDriver: true }),
      Animated.timing(a, { toValue: 1, duration: 600, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [a, reduce]);
  return <Animated.View style={[{ width, height, borderRadius: r, backgroundColor: '#ECEBE7', opacity: a }, style]} />;
}
/** Скелетон списка: карточка с n строками (плитка + две линии). */
export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <View style={[st.card, { paddingVertical: 6 }]}>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[st.row, { paddingHorizontal: 20 }]}>
          <Skeleton width={44} height={44} r={14} />
          <View style={{ flex: 1, gap: 8 }}><Skeleton width="60%" height={14} /><Skeleton width="40%" height={12} /></View>
        </View>
      ))}
    </View>
  );
}

/**
 * Пустое состояние / ошибка (Errors.dc.html): плитка-иконка 76 r26, крупный заголовок, текст, заметка-баннер и действия.
 * align='center' — для пустых списков посреди экрана.
 */
export function EmptyState({ icon = 'albums-outline', title, text, actions, tone = 'gray', note, align = 'start', compact }: {
  icon?: IconName; title: string; text?: string; actions?: ReactNode;
  /** Цвет плитки: gray (нет сети), amber (плохое фото, ИИ), blue (долго), red (правка не прошла). */
  tone?: Tone;
  /** Зелёная заметка под текстом («Лимит проектов не списан»). */
  note?: string;
  align?: 'start' | 'center';
  /** Заголовок 22 вместо 30 (внутри списка). */
  compact?: boolean;
}) {
  const c = tone === 'gray' ? { bg: palette.segOnWhite, fg: palette.ink } : { bg: tones[tone].bg, fg: tones[tone].fg };
  const center = align === 'center';
  return (
    <View style={[st.empty, center && { alignItems: 'center' }]}>
      <View style={[st.center, { width: compact ? 64 : 76, height: compact ? 64 : 76, borderRadius: compact ? 22 : 26, backgroundColor: c.bg }]}>
        <Ionicons name={icon} size={compact ? 30 : 36} color={c.fg} />
      </View>
      <T v={compact ? 'title' : 'big'} center={center}>{title}</T>
      {text ? <T v="sub" center={center} style={{ color: palette.muted2, lineHeight: 24 }}>{text}</T> : null}
      {note ? <Banner tone="ok" icon="checkmark-circle-outline" text={note} style={{ alignSelf: 'stretch' }} /> : null}
      {actions ? <View style={{ alignSelf: 'stretch', gap: 8, marginTop: 8 }}>{actions}</View> : null}
    </View>
  );
}

// прежний экспорт стилей (на случай внешних ссылок)
export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  pad: { paddingHorizontal: space.gutter, paddingTop: 8 },
});

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.ground },
  body: { paddingHorizontal: space.gutter, paddingTop: 8 },
  foot: { paddingTop: 10, paddingHorizontal: 12, paddingBottom: 16, gap: 8 },
  footBar: { backgroundColor: palette.white, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingTop: 16, paddingHorizontal: 16, paddingBottom: 16, gap: 8 },
  card: { backgroundColor: palette.white, borderRadius: radius.sheet, overflow: 'hidden' },
  cardPad: { paddingVertical: 16, paddingHorizontal: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingVertical: 10 },
  rowCompact: { minHeight: 50, paddingVertical: 5 },
  sep: { position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: palette.hair },
  // .hdr: padding 12/12/4 + min-height 56 по содержимому (content-box) = 72 — кнопка .ib 44 встаёт на 18 от верха, как в макетах
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 4, minHeight: 72 },
  hdrRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginTop: 4, marginBottom: 4, borderRadius: 16, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: palette.ink },
  offlineText: { flex: 1, color: palette.white, fontSize: 14, lineHeight: 18, fontWeight: '500' } as TextStyle,
  mock: { alignItems: 'center', paddingVertical: 2, backgroundColor: palette.amberSoft },
  fld: { borderRadius: radius.field, minHeight: 60, paddingVertical: 7, paddingHorizontal: 14, borderWidth: 2, justifyContent: 'center' },
  input: { ...type.fv, padding: 0, flex: 1, minHeight: 23 },
  under: { paddingHorizontal: 16, marginTop: 6 },
  search: { height: 48, borderRadius: radius.field, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 },
  chip: { height: 40, borderRadius: radius.chip, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, alignSelf: 'flex-start' },
  opt: { minHeight: 56, borderRadius: radius.btn, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 16 },
  seg: { flexDirection: 'row', backgroundColor: palette.off, borderRadius: 14, padding: 3, gap: 2 },
  sg: { flex: 1, height: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  sgOn: { backgroundColor: palette.white, shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  tog: { width: 51, height: 31, borderRadius: 16, padding: 2 },
  knob: { width: 27, height: 27, borderRadius: 14, backgroundColor: palette.white, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  st: { height: 26, borderRadius: radius.st, paddingHorizontal: 10, justifyContent: 'center', alignSelf: 'flex-start' },
  tag: { height: 24, borderRadius: radius.tag, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  ban: { borderRadius: radius.ban, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  ba: { marginLeft: 'auto', minHeight: 44, justifyContent: 'center', alignSelf: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  empty: { paddingTop: 32, paddingHorizontal: 12, paddingBottom: 8, gap: 16 },
});

