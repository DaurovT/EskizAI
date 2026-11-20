/**
 * Общее для экранов заказов (Orders, OrderNew, Order, Templates): мелкие детали макета, которых нет в src/ui/kit.tsx,
 * — .tag, .ban, .optc, .soft.sm, .svc, миниатюра окна, лист «Сопутствующий товар», склонения.
 */
import { ReactNode, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { api, errorText } from '@/api/http';
import type { Doc, Extra, Kit } from '@/api/types';
import { num } from '@/lib/format';
import { C, TAG } from '@/theme';
import { Icon, IconName } from '@/ui/Icon';
import { Button, ErrorText, Field, GlassBlue, Txt } from '@/ui/kit';
import { Schema } from '@/ui/Schema';

// ---------- ответы API, которых нет в types.ts ----------
/** GET /oyna/company (oyna_api/company.py::_out) — только нужные экранам заказов поля */
export type CompanyOut = {
  company: { id: string; name: string; demo_prices?: boolean };
  kits: (Kit & { id: string })[];
  onboarding: { works_missing: string[]; glass_missing: boolean };
};

// ---------- склонения ----------
/** plural(3, ['изделие', 'изделия', 'изделий']) → «изделия» */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
export const nItems = (n: number) => `${n} ${plural(n, ['изделие', 'изделия', 'изделий'])}`;
export const nPositions = (n: number) => `${n} ${plural(n, ['позиция', 'позиции', 'позиций'])}`;
/** 1400×1300 → «1 400 × 1 300» (макет .rs.num) */
export const dims = (w?: number, h?: number) => `${w !== undefined ? num(w) : '?'} × ${h !== undefined ? num(h) : '?'}`;

// ---------- иконки макета, которых нет в Icon.tsx ----------
const EXTRA_ICONS = {
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  tag: ['M4 12.5V5.5A1.5 1.5 0 0 1 5.5 4h7l7.5 7.5-8.5 8.5z'],
  wifi_off: ['M3 3l18 18', 'M8.5 16.5a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4-2.3M19 12.5a10 10 0 0 0-2.5-1.8M12 20h.01'],
  cloud_up: ['M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.5 9.5 4.5 4.5 0 0 0 7 18.5z', 'M12 16v-5M9.8 13l2.2-2.2 2.2 2.2'],
  camera2: ['M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z'],
} as const;
export type PIconName = keyof typeof EXTRA_ICONS | IconName;

/** Иконка: из Icon.tsx или из дополнительных (grid, tag, wifi_off, cloud_up, camera2). */
export function PIcon({ name, size = 22, color = C.ink, stroke = 2.2 }: { name: PIconName; size?: number; color?: string; stroke?: number }) {
  if (!(name in EXTRA_ICONS)) return <Icon name={name as IconName} size={size} color={color} stroke={stroke} />;
  const paths = EXTRA_ICONS[name as keyof typeof EXTRA_ICONS];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {paths.map((d, i) => <Path key={i} d={d} />)}
      {name === 'tag' ? <Circle cx={9} cy={9} r={1.5} /> : null}
      {name === 'camera2' ? <Circle cx={12} cy={13} r={3.5} /> : null}
    </Svg>
  );
}

// ---------- .tag ----------
export function Tag({ title, kind = 'est' }: { title: string; kind?: keyof typeof TAG }) {
  const c = TAG[kind] ?? TAG.n;
  return (
    <View style={[st.tag, { backgroundColor: c.bg }]}>
      <Txt size={13} w={600} color={c.fg}>{title}</Txt>
    </View>
  );
}

/** .st с произвольным цветом (c-red, c-amber, c-gray …) — для «нет цены», «1 предупр.» */
const PILL = {
  red: { bg: '#FFE7E4', fg: '#A1221A' }, amber: { bg: '#FFF0D4', fg: '#8A4B00' }, gray: { bg: '#F2F1EE', fg: '#55524D' },
  blue: { bg: '#E3EEFC', fg: '#154A99' }, green: { bg: '#E6F1EA', fg: '#275C3A' },
};
export function Pill({ title, color }: { title: string; color: keyof typeof PILL }) {
  return (
    <View style={[st.pill, { backgroundColor: PILL[color].bg }]}>
      <Txt size={13} w={600} color={PILL[color].fg}>{title}</Txt>
    </View>
  );
}

/** «не отправлен» с облаком (макет Orders / OrdersOffline) */
export function NotSent() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <PIcon name="cloud_up" size={16} color={C.muted} stroke={2} />
      <Txt size={13} color={C.muted}>не отправлен</Txt>
    </View>
  );
}

// ---------- .ban ----------
const BAN = {
  ok: { bg: C.okBg, fg: C.okFg }, est: { bg: C.estBg, fg: C.estFg }, info: { bg: C.accentSoft, fg: C.accentDeep },
  err: { bg: C.errBg, fg: C.errFg }, n: { bg: C.card, fg: C.ink },
};
export function Ban({ kind, title, text, icon, action, onPress, style }: {
  kind: keyof typeof BAN; title?: ReactNode; text?: ReactNode; icon?: PIconName; action?: ReactNode; onPress?: () => void; style?: StyleProp<ViewStyle>;
}) {
  const c = BAN[kind];
  const inner = (
    <>
      {icon ? <View style={{ marginTop: 1 }}><PIcon name={icon} size={20} color={c.fg} /></View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {title ? <Txt size={16} w={600} color={c.fg}>{title}</Txt> : null}
        {typeof text === 'string' ? <Txt size={14} color={c.fg}>{text}</Txt> : text}
      </View>
      {action}
      {onPress && !action ? <View style={{ alignSelf: 'center' }}><Icon name="chevron" size={20} color={c.fg} /></View> : null}
    </>
  );
  const s = [st.ban, { backgroundColor: c.bg }, onPress ? { alignItems: 'center' as const, paddingVertical: 12 } : null, style];
  return onPress
    ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s, pressed && { opacity: 0.85 }]}>{inner}</Pressable>
    : <View style={s}>{inner}</View>;
}

// ---------- .optc (карточка выбора способа) ----------
export function OptCard({ icon, title, text, onPress, accent, disabled, loading }: {
  icon: PIconName; title: string; text: string; onPress?: () => void; accent?: boolean; disabled?: boolean; loading?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled, busy: !!loading }} disabled={disabled || loading} onPress={onPress}
      style={({ pressed }) => [st.optc, { opacity: disabled ? 0.5 : loading ? 0.7 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
      <View style={[st.tile, accent && { backgroundColor: C.accentSoft }]}>
        <PIcon name={icon} size={22} color={accent ? C.accentDeep : C.ink} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt size={16} w={600}>{title}</Txt>
        <Txt size={13} color={C.muted}>{text}</Txt>
      </View>
    </Pressable>
  );
}

// ---------- .soft.sm ----------
export function SoftSm({ title, icon, onPress, disabled, style }: { title: string; icon?: PIconName; onPress?: () => void; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={({ pressed }) => [st.softSm, { opacity: disabled ? 0.45 : pressed ? 0.8 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }, style]}>
      {icon ? <PIcon name={icon} size={18} /> : null}
      <Txt size={15} w={500}>{title}</Txt>
    </Pressable>
  );
}

// ---------- .svc (быстрые действия на «Заказах») ----------
export function Svc({ title, sub, icon, pri, onPress, disabled, flex = 1 }: {
  title: string; sub?: string; icon?: PIconName; pri?: boolean; onPress?: () => void; disabled?: boolean; flex?: number;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [st.svc, { flex, opacity: disabled ? 0.55 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] },
        pri && { backgroundColor: 'transparent', borderWidth: 1.2, borderColor: 'rgba(64,92,138,0.95)' }]}>
      {pri ? <GlassBlue /> : null}
      {pri ? (
        <View pointerEvents="none" style={{ position: 'absolute', right: -6, top: -8, transform: [{ rotate: '-8deg' }] }}>
          <WindowThumb width={56} height={62} />
        </View>
      ) : icon ? (
        <View style={st.svcIco}><PIcon name={icon} size={20} /></View>
      ) : null}
      <Txt size={16} w={600} color={pri ? C.ctaText : C.ink} style={{ lineHeight: 20 }}>{title}</Txt>
      {sub ? <Txt size={13} color={pri ? '#2A4E85' : C.muted} style={{ marginTop: 2 }}>{sub}</Txt> : null}
    </Pressable>
  );
}

// ---------- миниатюры ----------
/** Схематичное окно П-О + глухая + П (макет .tile в списке заказов). */
export function WindowThumb({ width = 40, height = 34 }: { width?: number; height?: number }) {
  const W = width, H = height;
  const third = (W - 18) / 3;
  return (
    <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <Rect x={2} y={2} width={W - 4} height={H - 4} fill="#fff" stroke={C.ink} strokeWidth={2.5} />
      <Rect x={7} y={7} width={W - 14} height={H - 14} fill="none" stroke={C.ink} strokeWidth={1.5} />
      <Rect x={9} y={9} width={third} height={H - 18} fill="#DCE9F1" stroke={C.ink} strokeWidth={1} />
      <Path d={`M${9 + third} 9L9 ${H / 2}L${9 + third} ${H - 9}`} fill="none" stroke="#55524D" strokeWidth={1.1} strokeDasharray="4 3" />
      <Rect x={9 + third * 1.1} y={9} width={third * 0.8} height={H - 18} fill="#DCE9F1" stroke={C.ink} strokeWidth={1} />
      <Rect x={W - 9 - third} y={9} width={third} height={H - 18} fill="#DCE9F1" stroke={C.ink} strokeWidth={1} />
      <Path d={`M${W - 9 - third} 9L${W - 9} ${H / 2}L${W - 9 - third} ${H - 9}`} fill="none" stroke="#55524D" strokeWidth={1.1} strokeDasharray="4 3" />
    </Svg>
  );
}

/** Плитка 56×56 со схемой позиции (Schema без размеров) или общей миниатюрой окна. */
export function PosTile({ doc, size = 56, bg = '#EEF3F8' }: { doc?: Doc | null; size?: number; bg?: string }) {
  const inner = doc?.frame?.root ? <Schema doc={doc} width={size - 10} maxHeight={size - 10} dims={false} /> : <WindowThumb />;
  return <View style={[st.posTile, { width: size, height: size, backgroundColor: bg }]}>{inner}</View>;
}

// ---------- нижний лист с полями ввода ----------
/** Как Sheet из kit.tsx (.bs), но поднимается над клавиатурой — для листов с полями. */
export function KbSheet({ visible, onClose, children, title }: { visible: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable accessibilityLabel="Закрыть" style={{ flex: 1, backgroundColor: C.scrim }} onPress={onClose} />
        <View style={[st.kbSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={st.grab}><View style={st.grabBar} /></View>
          {title ? <Txt w={600} size={17} style={{ paddingHorizontal: 18, paddingBottom: 8 }}>{title}</Txt> : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------- лист «Сопутствующий товар» ----------
/** Добавить / изменить / удалить строку сопутствующего товара (POST/PUT/DELETE /oyna/orders/{id}/extras). */
export function ExtraSheet({ orderId, extra, visible, onClose, onSaved }: {
  orderId: string; extra?: Extra | null; visible: boolean; onClose: () => void; onSaved: (extras: Extra[]) => void;
}) {
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [unit, setUnit] = useState('шт');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState<'save' | 'del' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    setName(extra?.name ?? ''); setQty(extra ? String(extra.qty).replace('.', ',') : '1'); setUnit(extra?.unit ?? 'шт');
    setPrice(extra ? String(Math.round(extra.price_sum)) : ''); setErr(null); setBusy(null);
  }, [visible, extra]);
  const q = Number(qty.replace(',', '.'));
  const p = Number(price.replace(/\s/g, ''));
  const ok = name.trim().length > 0 && q > 0 && price.trim() !== '' && p >= 0;
  const save = async () => {
    setBusy('save'); setErr(null);
    try {
      const body = { name: name.trim(), unit: unit.trim() || 'шт', qty: q, price_sum: p };
      const out = extra
        ? await api.put<Extra[]>(`/oyna/orders/${orderId}/extras/${extra.id}`, body)
        : await api.post<Extra[]>(`/oyna/orders/${orderId}/extras`, body);
      onSaved(out);
      onClose();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const del = async () => {
    if (!extra) return;
    setBusy('del'); setErr(null);
    try {
      onSaved(await api.del<Extra[]>(`/oyna/orders/${orderId}/extras/${extra.id}`));
      onClose();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <KbSheet visible={visible} onClose={onClose} title={extra ? 'Сопутствующий товар' : 'Добавить товар'}>
      <View style={{ paddingHorizontal: 12, gap: 8, paddingBottom: 8 }}>
        <Txt size={14} color={C.muted} style={{ paddingHorizontal: 4 }}>Сетка, жалюзи — строкой с ценой</Txt>
        <Field label="Название" value={name} onChangeText={setName} placeholder="Москитная дверь" autoFocus={!extra} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="Количество" value={qty} onChangeText={setQty} keyboardType="decimal-pad" style={{ flex: 1 }} />
          <Field label="Ед." value={unit} onChangeText={setUnit} style={{ width: 96 }} />
        </View>
        <Field label="Цена за единицу, сум" value={price} onChangeText={(t) => setPrice(t.replace(/[^\d]/g, ''))} keyboardType="number-pad"
          placeholder="0" />
        {ok ? <Txt size={14} color={C.muted} style={{ paddingHorizontal: 4 }}>Итого: {num(Math.round(q * p))} сум</Txt> : null}
        <ErrorText>{err}</ErrorText>
        <Button title={extra ? 'Сохранить' : 'Добавить'} onPress={save} disabled={!ok} loading={busy === 'save'} />
        {extra ? <Button title="Удалить" kind="secondary" onPress={del} loading={busy === 'del'} /> : null}
      </View>
    </KbSheet>
  );
}

export const st = StyleSheet.create({
  tag: { height: 24, paddingHorizontal: 9, borderRadius: 8, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  pill: { height: 26, paddingHorizontal: 10, borderRadius: 9, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  ban: { borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  optc: { borderRadius: 22, backgroundColor: C.card, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 88 },
  tile: { width: 44, height: 44, borderRadius: 14, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' },
  posTile: { borderRadius: 16, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  softSm: { height: 44, borderRadius: 999, backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 14 },
  svc: { height: 112, borderRadius: 24, backgroundColor: C.card, padding: 14, justifyContent: 'flex-end', overflow: 'hidden' },
  svcIco: { position: 'absolute', right: 10, top: 10, width: 36, height: 36, borderRadius: 12, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' },
  kbSheet: { backgroundColor: C.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '92%' },
  grab: { height: 22, alignItems: 'center', justifyContent: 'center' },
  grabBar: { width: 40, height: 5, borderRadius: 3, backgroundColor: '#D6D4CF' },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  pills: { flexDirection: 'row', gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' },
});
