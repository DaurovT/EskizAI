/**
 * Детали макетов «Ядро v3» (docs/design_v3/*.dc.html), которых нет в kit.tsx:
 * .tabs (разделы с подчёркиванием), .tile2 (плитка «значение / подпись»), .opts + .opt2 (выбор 2 в ряд),
 * .price (цена 26 px + «сум»), .big2 + курсор (крупный ввод размера), .txt (ссылка-кнопка), .optc (карточка варианта).
 */
import { ReactNode, useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { C } from '@/theme';
import { Icon, IconName } from './Icon';
import { Txt } from './kit';

/** .tabs — разделы листа: подчёркнутый выбранный */
export function Tabs<T extends string>({ items, value, onChange, style }: {
  items: { value: T; title: string }[]; value: T; onChange: (v: T) => void; style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[s.tabs, style]} accessibilityRole="tablist">
      {items.map((it) => {
        const on = it.value === value;
        return (
          <Pressable key={it.value} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(it.value)} style={s.tab}>
            <Txt size={15} w={600} color={on ? C.ink : C.muted} lines={1}>{it.title}</Txt>
            {on ? <View style={s.tabLine} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** .tile2 сеткой 2 в ряд: крупно значение, ниже подпись («Akfa 6000 QVT / профиль») */
export function Tile2Grid({ items, onPress }: { items: { key: string; value: string; label: string; dim?: boolean }[]; onPress: (key: string) => void }) {
  return (
    <View style={s.grid}>
      {items.map((it) => (
        <Pressable key={it.key} accessibilityRole="button" accessibilityLabel={`${it.label}: ${it.value}`} onPress={() => onPress(it.key)}
          style={({ pressed }) => [s.tile2, { opacity: it.dim ? 0.55 : pressed ? 0.8 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
          <Txt size={16} w={600} lines={1} style={{ lineHeight: 20 }}>{it.value}</Txt>
          <Txt size={13} color="#5F5C57" lines={1}>{it.label}</Txt>
        </Pressable>
      ))}
    </View>
  );
}

/** .opts + .opt2 — варианты по 2 в ряд (высота 48); white — на сером фоне экрана (белые), иначе внутри белого листа (серые) */
export function Opt2Grid<T extends string>({ items, value, onChange, white }: {
  items: { value: T; title: string; on?: boolean }[]; value?: T | null; onChange: (v: T) => void; white?: boolean;
}) {
  return (
    <View style={s.grid}>
      {items.map((it) => {
        const on = it.on ?? it.value === value;
        return (
          <Pressable key={it.value} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => onChange(it.value)}
            style={({ pressed }) => [s.opt2, { backgroundColor: on ? C.dark : white ? C.card : C.soft, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
            <Txt size={16} w={500} color={on ? '#fff' : C.ink} lines={1}>{it.title}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

/** .price — «1 950 000 сум»; value null — «—» серым (цена после исправления). Число «въезжает» при смене (tick). */
export function PriceLine({ value, unit = 'сум', muted, right }: { value: string | null; unit?: string; muted?: boolean; right?: ReactNode }) {
  const a = useRef(new Animated.Value(1)).current;
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    a.setValue(0);
    Animated.timing(a, { toValue: 1, duration: 280, easing: Easing.bezier(0.2, 0, 0, 1), useNativeDriver: true }).start();
  }, [value, a]);
  const ty = a.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, flexShrink: 1 }}>
      <Animated.View style={{ opacity: a, transform: [{ translateY: ty }] }}>
        <Txt size={26} w={700} color={value === null || muted ? C.heroMuted : C.ink} style={{ lineHeight: 30, letterSpacing: -0.5, fontVariant: ['tabular-nums'] }}>
          {value ?? '—'}
        </Txt>
      </Animated.View>
      {unit ? <Txt size={15} color="#5F5C57" lines={1} style={{ flexShrink: 1 }}>{unit}</Txt> : null}
      {right}
    </View>
  );
}

/** Мигающий курсор ввода (2 × 30, голубой) */
export function Caret({ height = 30 }: { height?: number }) {
  const a = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 0, duration: 450, delay: 300, useNativeDriver: true }),
      Animated.timing(a, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [a]);
  return <Animated.View style={{ width: 2, height, backgroundColor: C.accent, marginLeft: 2, opacity: a }} />;
}

/** .big2 — крупное значение размера (34 px) с курсором, «—» серым, если пусто */
export function BigValue({ text, focus, size = 34 }: { text: string; focus?: boolean; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: size + 4 }}>
      <Txt size={size} w={700} color={text ? C.ink : C.heroMuted} style={{ lineHeight: size + 4, letterSpacing: -0.6, fontVariant: ['tabular-nums'] }}>
        {text || (focus ? '' : '—')}
      </Txt>
      {focus ? <Caret height={Math.round(size * 0.88)} /> : null}
    </View>
  );
}

/** .txt — ссылка-кнопка голубым */
export function TxtLink({ title, onPress, icon, style }: { title: string; onPress?: () => void; icon?: IconName; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={4}
      style={({ pressed }) => [{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, opacity: pressed ? 0.6 : 1 }, style]}>
      {icon ? <Icon name={icon} size={18} color={C.accentText} /> : null}
      <Txt size={16} w={500} color={C.accentText}>{title}</Txt>
    </Pressable>
  );
}

/** .optc — карточка варианта (выбранная — голубая рамка 2,5) */
export function OptC({ on, onPress, children, style, label }: { on?: boolean; onPress?: () => void; children: ReactNode; style?: StyleProp<ViewStyle>; label?: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!on }} onPress={onPress}
      style={({ pressed }) => [s.optc, on && s.optcOn, { transform: [{ scale: pressed ? 0.97 : 1 }] }, style]}>
      {children}
    </Pressable>
  );
}

const s = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 4, borderBottomWidth: 1, borderBottomColor: '#EDECE9', marginHorizontal: -4 },
  tab: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' },
  tabLine: { position: 'absolute', left: '18%', right: '18%', bottom: -1, height: 3, borderRadius: 2, backgroundColor: C.ink },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile2: { flexBasis: '47%', flexGrow: 1, minHeight: 58, borderRadius: 16, backgroundColor: C.soft, paddingVertical: 10, paddingHorizontal: 14, justifyContent: 'center', gap: 1 },
  opt2: { flexBasis: '47%', flexGrow: 1, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  optc: { borderRadius: 22, backgroundColor: C.card, padding: 14, alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 2.5, borderColor: 'transparent' },
  optcOn: { borderColor: C.accent },
});
