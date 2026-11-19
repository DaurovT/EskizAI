/**
 * Набор компонентов по макету (классы .dc.html → компоненты):
 * .ph → Screen, .top → TopBar, .h → SectionTitle, .list → Card, .row → Row, .it → Item, .big/.pri → Button,
 * .dock → Dock, .seg → Seg, .fld → Field, .chip → Chip, .sx/.pst → StatusPill, .act → Act, .sheet → Sheet,
 * .hero → Hero, .sw → Switch, .stp → Stepper, .note → Note.
 * Экраны собирают интерфейс из этих деталей; новое общее — добавляйте сюда.
 */
import { ComponentRef, ReactNode, Ref, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleProp, StyleSheet, Text, TextInput, TextInputProps, TextStyle, View, ViewStyle, KeyboardAvoidingView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { C, F, R, STATUS_BADGE } from '@/theme';
import { Glass } from './Glass';
import { Icon, IconName } from './Icon';

// ---------- текст ----------
type TxtProps = { children?: ReactNode; style?: StyleProp<TextStyle>; w?: 400 | 500 | 600 | 700; size?: number; color?: string; lines?: number; center?: boolean };
export function Txt({ children, style, w = 400, size = 16, color = C.ink, lines, center }: TxtProps) {
  const fontFamily = w === 700 ? F.bold : w === 600 ? F.semibold : w === 500 ? F.medium : F.regular;
  return (
    <Text numberOfLines={lines} style={[{ fontFamily, fontSize: size, lineHeight: Math.round(size * 1.35), color, letterSpacing: -0.08, textAlign: center ? 'center' : undefined }, style]}>
      {children}
    </Text>
  );
}
export const Note = ({ children, style, center }: { children?: ReactNode; style?: StyleProp<TextStyle>; center?: boolean }) => (
  <Txt size={14} color={C.muted} style={style} center={center}>{children}</Txt>
);
export const ErrorText = ({ children }: { children?: ReactNode }) => (children ? <Txt size={14} w={500} color={C.danger}>{children}</Txt> : null);

// ---------- экран ----------
export function Screen({ children, bg = C.bg, style }: { children?: ReactNode; bg?: string; style?: StyleProp<ViewStyle> }) {
  const insets = useSafeAreaInsets();
  return <View style={[{ flex: 1, backgroundColor: bg, paddingTop: insets.top }, style]}>{children}</View>;
}

export function TopBar({ title, subtitle, onBack, right, big }: { title?: ReactNode; subtitle?: ReactNode; onBack?: () => void; right?: ReactNode; big?: boolean }) {
  return (
    <View style={s.top}>
      {onBack ? <IconButton name="back" label="Назад" onPress={onBack} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof title === 'string' ? <Txt w={600} size={big ? 22 : 18} lines={1}>{title}</Txt> : title}
        {subtitle ? (typeof subtitle === 'string' ? <Txt size={14} color={C.muted} lines={1}>{subtitle}</Txt> : subtitle) : null}
      </View>
      {right}
    </View>
  );
}

/** Круглая кнопка шапки (макет V3.1: .top .ic — стекло). bg — сплошной фон вместо стекла; dark — для тёмных экранов. */
export function IconButton({ name, label, onPress, bg, color = C.ink, dark }: { name: IconName; label: string; onPress?: () => void; bg?: string; color?: string; dark?: boolean }) {
  if (bg) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6}
        style={({ pressed }) => [s.icBtn, { backgroundColor: bg, opacity: pressed ? 0.7 : 1 }]}>
        <Icon name={name} color={color} />
      </Pressable>
    );
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6}
      style={({ pressed }) => ({ transform: [{ scaleX: pressed ? 1.07 : 1 }, { scaleY: pressed ? 0.93 : 1 }] })}>
      <Glass radius={22} dark={dark} interactive style={s.icBtn}>
        <Icon name={name} color={dark ? '#fff' : color} />
      </Glass>
    </Pressable>
  );
}

export function Body({ children, style, refresh }: { children?: ReactNode; style?: StyleProp<ViewStyle>; refresh?: ReactNode }) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={[{ paddingBottom: 24 }, style]} keyboardShouldPersistTaps="handled" refreshControl={refresh as never}>
      {children}
    </ScrollView>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={s.h}>
      <Txt size={15} w={600} color={C.muted} style={{ flex: 1 }}>{children}</Txt>
      {right}
    </View>
  );
}

// ---------- списки ----------
export function Card({ children, style }: { children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>;
}

/** Строка .row: подпись слева, значение справа, шеврон если есть onPress. */
export function Row({ label, value, sub, onPress, first, danger, left, right, chevron, selected }: {
  label: ReactNode; value?: ReactNode; sub?: ReactNode; onPress?: () => void; first?: boolean; danger?: boolean;
  left?: ReactNode; right?: ReactNode; chevron?: boolean; selected?: boolean;
}) {
  const inner = (
    <>
      {!first ? <View style={s.sep} /> : null}
      {left}
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof label === 'string' ? <Txt w={500} color={danger ? C.danger : C.ink}>{label}</Txt> : label}
        {sub ? (typeof sub === 'string' ? <Note>{sub}</Note> : sub) : null}
      </View>
      {value !== undefined && value !== null ? (typeof value === 'string' || typeof value === 'number'
        ? <Txt size={15} color={C.muted} style={{ textAlign: 'right' }}>{value}</Txt> : value) : null}
      {right}
      {(chevron ?? !!onPress) ? <Icon name="chevron" size={20} color="#A9A7A1" /> : null}
    </>
  );
  const style = [s.row, selected && { backgroundColor: C.accentSoft }];
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [style, pressed && { backgroundColor: '#F7F6F3' }]}>{inner}</Pressable>
  ) : <View style={style}>{inner}</View>;
}

/** Элемент .it: миниатюра, заголовок, подпись, справа значение/действие. */
export function Item({ thumb, title, sub, status, right, onPress, first }: {
  thumb?: ReactNode; title: ReactNode; sub?: ReactNode; status?: { code: string; title: string } | null; right?: ReactNode; onPress?: () => void; first?: boolean;
}) {
  const inner = (
    <>
      {!first ? <View style={s.sep} /> : null}
      {thumb ? <View style={s.thumb}>{thumb}</View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof title === 'string' ? <Txt w={500} lines={1}>{title}</Txt> : title}
        {sub ? (typeof sub === 'string' ? <Txt size={14} color={C.muted} lines={1}>{sub}</Txt> : sub) : null}
        {status ? <StatusLine code={status.code} title={status.title} /> : null}
      </View>
      {right}
    </>
  );
  const style = [s.item, status ? s.itemTop : null];
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [style, pressed && { backgroundColor: '#F7F6F3' }]}>{inner}</Pressable>
  ) : <View style={style}>{inner}</View>;
}

/** Статус под заголовком элемента списка (макет V3: тонированная плашка). */
export function StatusLine({ code, title }: { code: string; title: string }) {
  const c = STATUS_BADGE[code] ?? STATUS_BADGE.draft;
  return (
    <View style={[s.pill, { backgroundColor: c.bg, marginTop: 6 }]}>
      <Txt size={13} w={600} color={c.fg}>{title}</Txt>
    </View>
  );
}

export function StatusPill({ code, title, onPress }: { code: string; title: string; onPress?: () => void }) {
  const c = STATUS_BADGE[code] ?? STATUS_BADGE.draft;
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={[s.pill, { backgroundColor: c.bg }]}>
      <Txt size={13} w={600} color={c.fg}>{title}</Txt>
    </Pressable>
  );
}

/** Небольшая кнопка действия .act */
export function Act({ title, onPress, style, color = C.ink, bg = C.soft }: { title: string; onPress?: () => void; style?: StyleProp<ViewStyle>; color?: string; bg?: string }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.act, { backgroundColor: bg, opacity: pressed ? 0.7 : 1 }, style]}>
      <Txt size={14} w={600} color={color}>{title}</Txt>
    </Pressable>
  );
}

// ---------- кнопки ----------
type BtnKind = 'primary' | 'dark' | 'secondary' | 'danger';
export function Button({ title, onPress, kind = 'primary', icon, loading, disabled, style, small }: {
  title: string; onPress?: () => void; kind?: BtnKind; icon?: IconName; loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>; small?: boolean;
}) {
  const glass = kind === 'primary' && !disabled;          // макет: GLASS-BLUE — светло-голубое стекло, тёмно-синий текст
  const bg = disabled && kind === 'primary' ? C.seg : { primary: 'transparent', dark: C.dark, secondary: C.card, danger: C.danger }[kind];
  const fg = glass ? C.ctaText : disabled && kind === 'primary' ? C.faint : kind === 'secondary' ? C.ink : '#fff';
  const off = disabled || loading;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!off, busy: !!loading }} disabled={off} onPress={onPress}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, height: small ? 48 : 56, borderRadius: kind === 'primary' || kind === 'secondary' ? 999 : 16,
        opacity: pressed ? 0.88 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] },
        glass && { overflow: 'hidden', borderWidth: 1.2, borderColor: 'rgba(64,92,138,0.95)', shadowColor: '#1E325A', shadowOpacity: 0.3, shadowRadius: 11, shadowOffset: { width: 0, height: 8 } }, style]}>
      {glass ? <GlassBlue /> : null}
      {loading ? <ActivityIndicator color={fg} /> : (
        <>
          {icon ? <Icon name={icon} color={fg} size={22} /> : null}
          <Txt w={600} size={small ? 15 : 17} color={fg}>{title}</Txt>
        </>
      )}
    </Pressable>
  );
}

/** Заливка «стеклянной голубой» кнопки (.cta:not(.off)::before/::after в макете). */
export function GlassBlue() {
  // размер — по onLayout: проценты в react-native-svg не пересчитываются, когда кнопка растягивается после первой отрисовки
  const [box, setBox] = useState({ w: 0, h: 0 });
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}
      onLayout={(e) => { const { width, height } = e.nativeEvent.layout; if (width !== box.w || height !== box.h) setBox({ w: width, h: height }); }}>
      {box.w ? (
        <Svg width={box.w} height={box.h}>
          <Defs>
            <LinearGradient id="gb" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#ECF3FC" stopOpacity={0.96} />
              <Stop offset="0.28" stopColor="#C2D6F0" stopOpacity={0.92} />
              <Stop offset="0.62" stopColor="#A6C4EA" stopOpacity={0.92} />
              <Stop offset="1" stopColor="#CEE6FD" stopOpacity={0.96} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={box.w} height={box.h} fill="url(#gb)" />
        </Svg>
      ) : null}
    </View>
  );
}

/** Нижняя панель с главной кнопкой (.dock) */
export function Dock({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <View style={[s.dock, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>{children}</View>;
}

// ---------- ввод ----------
export function Seg<T extends string>({ items, value, onChange, style, chips }: {
  items: { value: T; title: string; count?: number }[]; value: T; onChange: (v: T) => void; style?: StyleProp<ViewStyle>;
  /** фильтр над списком (макет V3): белые «чипсы», выбранная — тёмная */
  chips?: boolean;
}) {
  if (chips) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[{ flexGrow: 0 }, style]}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }} accessibilityRole="tablist">
        {items.map((it) => {
          const on = it.value === value;
          return (
            <Pressable key={it.value} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(it.value)}
              style={[s.chip, { flexDirection: 'row', gap: 6 }, on && { backgroundColor: C.dark }]}>
              <Txt size={15} w={500} color={on ? '#fff' : C.ink}>{it.title}</Txt>
              {it.count !== undefined ? <Txt size={15} w={500} color={on ? '#A9A6A0' : '#9C9993'}>{it.count}</Txt> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    );
  }
  return (
    <View style={[s.seg, style]} accessibilityRole="tablist">
      {items.map((it) => {
        const on = it.value === value;
        return (
          <Pressable key={it.value} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(it.value)} style={[s.segBtn, on && s.segOn]}>
            <Txt size={15} w={on ? 600 : 500}>{it.title}</Txt>
            {it.count !== undefined ? <Txt size={15} w={500} color={C.faint}>{it.count}</Txt> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function Field({ label, error, style, right, inputStyle, ref, ...input }: TextInputProps & {
  label: string; error?: string | boolean; right?: ReactNode; inputStyle?: StyleProp<TextStyle>; ref?: Ref<ComponentRef<typeof TextInput>>;
}) {
  const [focus, setFocus] = useState(false);
  return (
    <View style={[s.fld, focus && { borderColor: C.accent }, error ? { backgroundColor: C.dangerBg, borderColor: C.dangerLine } : null, style]}>
      <Txt size={13} color={C.muted}>{label}</Txt>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <TextInput ref={ref} placeholderTextColor={C.faint} {...input}
          onFocus={(e) => { setFocus(true); input.onFocus?.(e); }} onBlur={(e) => { setFocus(false); input.onBlur?.(e); }}
          style={[{ flex: 1, fontFamily: F.medium, fontSize: 17, color: C.ink, paddingVertical: 2 }, input.multiline && { minHeight: 60, textAlignVertical: 'top' }, inputStyle]} />
        {right}
      </View>
    </View>
  );
}

export function Chip({ title, on, onPress }: { title: string; on?: boolean; onPress?: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: !!on }} onPress={onPress} style={[s.chip, on && { backgroundColor: C.dark }]}>
      <Txt size={15} w={500} color={on ? '#fff' : C.ink}>{title}</Txt>
    </Pressable>
  );
}

export function Switch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: value }} onPress={() => onChange(!value)}
      style={[s.sw, { backgroundColor: value ? C.accent : '#D3D1CB', alignItems: value ? 'flex-end' : 'flex-start' }]}>
      <View style={s.swKnob} />
    </Pressable>
  );
}

export function Stepper({ value, onChange, step = 1, min, max, format }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; format?: (v: number) => string }) {
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Pressable accessibilityLabel="Меньше" onPress={() => onChange(clamp(value - step))} style={s.stpBtn}><Txt size={22} w={500}>−</Txt></Pressable>
      <Txt size={17} w={600} style={{ minWidth: 64, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{format ? format(value) : String(value)}</Txt>
      <Pressable accessibilityLabel="Больше" onPress={() => onChange(clamp(value + step))} style={s.stpBtn}><Txt size={22} w={500}>+</Txt></Pressable>
    </View>
  );
}

// ---------- крупные блоки ----------
/** Тёмная карточка .hero (портфель на главной) */
export function Hero({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.hero, style]}>{children}</View>;
}

/** Нижний лист .sheet поверх затемнения */
export function Sheet({ visible, onClose, children, title }: { visible: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* лист поднимается над клавиатурой: иначе поля внизу (цена, «Добавить») закрыты и ввод уходит не туда */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable accessibilityLabel="Закрыть" style={{ flex: 1, backgroundColor: C.scrim }} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={s.grab}><View style={s.grabBar} /></View>
          {title ? (
            // заголовок с крестиком: длинный лист (наценка, работы) иначе закрывался только тапом по тёмному фону
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 8, paddingBottom: 8, gap: 8 }}>
              <Txt w={600} size={17} style={{ flex: 1 }}>{title}</Txt>
              <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" hitSlop={10} onPress={onClose}
                style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? C.line : 'transparent' })}>
                <Txt size={22} color={C.muted}>×</Txt>
              </Pressable>
            </View>
          ) : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Loading() {
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}><ActivityIndicator color={C.accent} /></View>;
}

export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <View style={{ alignItems: 'center', paddingTop: 40, paddingHorizontal: 24, gap: 6 }}>
      <Txt w={600} size={19} center>{title}</Txt>
      {text ? <Note center>{text}</Note> : null}
      {action ? <View style={{ marginTop: 12, alignSelf: 'stretch' }}>{action}</View> : null}
    </View>
  );
}

/** Ошибка загрузки с повтором */
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={{ padding: 24, gap: 12, alignItems: 'center' }}>
      <Txt w={600} center>Не получилось загрузить</Txt>
      <Note center>{message}</Note>
      {onRetry ? <Act title="Повторить" onPress={onRetry} bg={C.card} /> : null}
    </View>
  );
}

export const s = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6, minHeight: 56 },
  icBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  h: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 8 },
  card: { backgroundColor: C.card, marginHorizontal: 12, borderRadius: R.list, overflow: 'hidden' },
  sep: { position: 'absolute', left: 0, right: 0, top: 0, height: 1, backgroundColor: C.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingHorizontal: 20, paddingVertical: 10 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, paddingHorizontal: 20, paddingVertical: 10 },
  itemTop: { alignItems: 'flex-start', paddingVertical: 14 },
  thumb: { width: 56, height: 56, borderRadius: 16, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pill: { flexDirection: 'row', alignItems: 'center', height: 26, paddingHorizontal: 10, borderRadius: 9, backgroundColor: C.soft, alignSelf: 'flex-start' },
  act: { height: 44, borderRadius: 14, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  btn: { borderRadius: R.button, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 16 },
  dock: { paddingHorizontal: 12, paddingTop: 10, backgroundColor: C.bg },
  seg: { flexDirection: 'row', gap: 4, backgroundColor: C.seg, borderRadius: 14, padding: 3, marginHorizontal: 12 },
  segBtn: { flex: 1, height: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  segOn: { backgroundColor: C.card, shadowColor: '#21201F', shadowOpacity: 0.1, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  fld: { backgroundColor: C.card, borderRadius: R.field, minHeight: 60, paddingHorizontal: 16, paddingVertical: 9, justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  chip: { height: 40, borderRadius: R.chip, backgroundColor: C.card, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  sw: { width: 50, height: 30, borderRadius: 15, padding: 3, justifyContent: 'center' },
  swKnob: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#fff' },
  stpBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' },
  hero: { marginHorizontal: 12, marginBottom: 10, borderRadius: 28, backgroundColor: C.dark, padding: 20, gap: 14 },
  sheet: { backgroundColor: C.bg, borderTopLeftRadius: R.sheet, borderTopRightRadius: R.sheet, maxHeight: '86%' },
  grab: { height: 20, alignItems: 'center', justifyContent: 'center' },
  grabBar: { width: 40, height: 5, borderRadius: 3, backgroundColor: '#D6D4CF' },
});
