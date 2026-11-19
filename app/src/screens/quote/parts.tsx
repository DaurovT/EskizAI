/**
 * Общее для экранов расчёта, КП и документов (S09, S10, S12): типы ответов, плашки .ban/.tag/.st,
 * нижняя панель .foot.bar, тост, иконки, которых нет в Icon, и скачивание PDF с токеном.
 * Кандидаты в общие файлы: Banner/Tag/Pill → src/ui/kit.tsx, LockIcon/DownloadIcon → src/ui/Icon.tsx,
 * sharePdf → src/api/http.ts, типы → src/api/types.ts.
 */
import * as Linking from 'expo-linking';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { ReactNode, useEffect } from 'react';
import { Pressable, StyleProp, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect } from 'react-native-svg';

import { api, ApiError, authHeaders } from '@/api/http';
import type { Kit, Role, Setup, Violation } from '@/api/types';
import { API_URL } from '@/config';
import { num } from '@/lib/format';
import { Txt } from '@/ui/kit';
import { Icon } from '@/ui/Icon';
import { C, TAG } from '@/theme';

// ---------- типы ответов (нет в src/api/types.ts) ----------
/** supplier / supplier_name — поставщик строки, если у цеха их несколько (shapes_contract §9.7) */
export type CalcLine = { name: string; qty: number; bars?: number; total?: number; supplier?: string | null; supplier_name?: string | null; kind?: string };
export type CalcGroup = {
  key: string; title: string; qty: number; unit: string; price_status: 'price' | 'demo' | 'none' | 'estimate';
  lines: CalcLine[]; bars?: number; cost?: number;
};
export type MissingPrice = { item_id?: string | null; name: string; article?: string | null; position?: string | null };
export type OrderCalc = {
  kit: string | null; total: number; total_usd?: number | null; usd_rate?: number | null; discount_pct: number;
  groups: CalcGroup[]; auto_added: string[]; missing: MissingPrice[]; demo: boolean; can_quote: boolean;
  cost?: number; margin?: number; markup_kind?: 'percent' | 'margin' | 'per_m2'; markup_value?: number;
};
export type Blocking = Violation & { position?: string | null; room?: string | null };
export type VariantFull = {
  kit: string; setup: Setup; total: number; area_m2: number; per_m2: number | null; demo: boolean; can_quote: boolean;
  blocking: Blocking[]; current: boolean;
};
export type QuoteCreated = {
  version: number; token: string; url: string; public_url: string; pdf_url: string; telegram_share: string; demo: boolean;
  variants: { kit: string; total: number }[];
};
export type QuoteBlockedBody = { error: string; variants: { kit: string; blocking: Blocking[] }[] };
export type CompanyOut = {
  company: { id: string; name: string; phone?: string | null; plan?: 'free' | 'pro'; lang_default?: 'ru' | 'uz'; demo_prices?: boolean;
    markup_kind?: string; markup_value?: number; usd_rate?: number | null };
  kits: (Kit & { id: string })[];
};
export type CatalogItem = { item_id: string; system: string; article: string; color: string; role: string; unit: string; price_sum: number | null; own_price_sum: number | null };

/** Роль — подпись в шапке для не-владельца («Расчёт · замерщик», макет CalcMeasurer). */
export const ROLE_TITLE: Record<Role, string> = {
  owner: 'владелец', manager: 'менеджер', measurer: 'замерщик', installer: 'монтажник', production: 'производство',
};

/** Единицы спецификации → по-русски */
export const UNIT: Record<string, string> = { m: 'м', m2: 'м²', pcs: 'шт', bar: 'хлыст', kg: 'кг', pack: 'уп.', 'поз.': 'поз.', l: 'л', set: 'компл.' };
export const unitRu = (u?: string) => (u ? UNIT[u] ?? u : '');

/** 1 020 000 → «1,02 млн» (за м² — два знака, как в макете), меньше миллиона — «850 тыс.» */
export function perM2(v?: number | null): string {
  if (v === null || v === undefined) return '';
  if (v >= 1e6) return `${num(v / 1e6, 2)} млн`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} тыс.`;
  return num(v);
}
/** Сумма спецификации в млн с двумя знаками: 3 950 000 → «3,95 млн», 40 000 → «0,04 млн» */
export function mln(v?: number | null): string {
  if (v === null || v === undefined) return '';
  return `${num(v / 1e6, 2)} млн`;
}
/** «хлыст / хлыста / хлыстов» */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// ---------- плашки ----------
type BanKind = 'err' | 'est' | 'info' | 'ok';
const BAN: Record<BanKind, { bg: string; fg: string }> = {
  err: { bg: C.errBg, fg: C.errFg }, est: { bg: C.estBg, fg: C.estFg }, info: { bg: C.accentSoft, fg: C.accentDeep }, ok: { bg: C.okBg, fg: C.okFg },
};
/** .ban: иконка, заголовок .bt, текст .bd, справа действие (кнопка .soft.sm или ссылка .ba) */
export function Banner({ kind, title, text, action, onAction, actionStyle = 'button', icon = true, style }: {
  kind: BanKind; title: string; text?: ReactNode; action?: string; onAction?: () => void; actionStyle?: 'button' | 'link'; icon?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = BAN[kind];
  return (
    <View style={[{ borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', gap: 12, alignItems: action ? 'center' : 'flex-start', backgroundColor: c.bg }, style]}>
      {icon ? <View style={{ paddingTop: action ? 0 : 1 }}><Icon name="warn" size={20} color={c.fg} stroke={2.3} /></View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt size={16} w={600} color={c.fg} style={{ lineHeight: 21 }}>{title}</Txt>
        {text ? (typeof text === 'string' ? <Txt size={14} color={c.fg} style={{ lineHeight: 19 }}>{text}</Txt> : text) : null}
      </View>
      {action ? (actionStyle === 'button' ? (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={4}
          style={({ pressed }) => ({ height: 44, borderRadius: 999, backgroundColor: '#fff', paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.75 : 1 })}>
          <Txt size={15} w={500}>{action}</Txt>
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={6} style={{ minHeight: 44, justifyContent: 'center' }}>
          <Txt size={15} w={600} color={c.fg}>{action}</Txt>
        </Pressable>
      )) : null}
    </View>
  );
}

/** .tag (est / info / ok / n / err) — «ДЕМО» и т. п. */
export function Tag({ kind = 'est', title }: { kind?: keyof typeof TAG; title: string }) {
  const c = TAG[kind];
  return (
    <View style={{ height: 24, paddingHorizontal: 9, borderRadius: 8, backgroundColor: c.bg, alignSelf: 'center', justifyContent: 'center' }}>
      <Txt size={13} w={600} color={c.fg}>{title}</Txt>
    </View>
  );
}

/** .st c-* — статус в строке («нет цены», «Готовим PDF…»); small — 20 px, как в спецификации */
export function Pill({ kind, title, small }: { kind: 'red' | 'blue' | 'green' | 'amber' | 'gray'; title: string; small?: boolean }) {
  const c = { red: TAG.err, blue: TAG.info, green: TAG.ok, amber: TAG.est, gray: TAG.n }[kind];
  return (
    <View style={{ height: small ? 20 : 26, paddingHorizontal: small ? 8 : 10, borderRadius: small ? 7 : 9, backgroundColor: c.bg, justifyContent: 'center', alignSelf: 'center' }}>
      <Txt size={small ? 11 : 13} w={600} color={c.fg}>{title}</Txt>
    </View>
  );
}

/** .foot.bar — белая нижняя панель со скруглением сверху */
export function FootBar({ children, white = true }: { children: ReactNode; white?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[{ paddingHorizontal: white ? 16 : 12, paddingTop: white ? 12 : 10, paddingBottom: Math.max(insets.bottom, 14) + 6, gap: 8 },
      white && { backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28 }]}>
      <View style={{ flexDirection: 'row', gap: 8 }}>{children}</View>
    </View>
  );
}

/** .soft — белая круглая кнопка (в нижней панели); icon-only, если нет title */
export function SoftButton({ title, icon, onPress, label, disabled, square }: { title?: string; icon?: ReactNode; onPress?: () => void; label?: string; disabled?: boolean; square?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [{ height: 56, borderRadius: 999, backgroundColor: square ? C.card : C.soft, flexDirection: 'row', gap: 8,
        alignItems: 'center', justifyContent: 'center', paddingHorizontal: title ? 18 : 0, width: title ? undefined : 56, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 }]}>
      {icon}
      {title ? <Txt size={17} w={500}>{title}</Txt> : null}
    </Pressable>
  );
}

/** .toast — тёмная плашка снизу с действием .ta; сама скрывается через 5 с */
export function Toast({ text, action, onAction, onHide, bottom = 110 }: { text: string; action?: string; onAction?: () => void; onHide: () => void; bottom?: number }) {
  useEffect(() => { const t = setTimeout(onHide, 5000); return () => clearTimeout(t); }, [onHide, text]);
  return (
    <View style={{ position: 'absolute', left: 12, right: 12, bottom, zIndex: 7, borderRadius: 18, backgroundColor: C.dark, flexDirection: 'row',
      alignItems: 'center', gap: 12, minHeight: 56, paddingLeft: 18, paddingRight: 8 }}>
      <Txt size={15} color="#fff" style={{ flex: 1 }}>{text}</Txt>
      {action ? (
        <Pressable accessibilityRole="button" onPress={onAction} style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' }}>
          <Txt size={15} w={600} color="#9CC4FF">{action}</Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

// ---------- иконки макета, которых нет в Icon ----------
export function LockIcon({ size = 18, color = C.heroMuted }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x={5} y={10.5} width={14} height={10} rx={2} />
      <Path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </Svg>
  );
}
export function DownloadIcon({ size = 22, color = C.ink }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 4v11" /><Path d="M8 11l4 4 4-4" /><Path d="M5 19.5h14" />
    </Svg>
  );
}
export function DocIcon({ size = 20, color = C.ink }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5z" /><Path d="M14 3.5V8h4" />
    </Svg>
  );
}
export function ShareIcon({ size = 20, color = C.ink }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 4v11" /><Path d="M8 8l4-4 4 4" /><Path d="M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13" />
    </Svg>
  );
}
export function SendIcon({ size = 20, color = C.ctaText }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 4L10 14" /><Path d="M21 4l-7 17-3.5-7.5L3 10z" />
    </Svg>
  );
}

// ---------- PDF с токеном ----------
async function fetchPdf(path: string, retried = false): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { headers: { Accept: 'application/pdf', ...(await authHeaders()) } });
  } catch {
    throw new ApiError(0, 'network', 'Нет связи с сервером. Проверьте интернет');
  }
  if (res.status === 401 && !retried) {
    await api.get('/auth/me');                       // обновит токен (request делает refresh по 401)
    return fetchPdf(path, true);
  }
  if (!res.ok) {
    let msg = `Ошибка ${res.status}`;
    try {
      const j = await res.json();
      const d = j?.detail;
      if (typeof d === 'string') msg = d;
      else if (d?.msg) msg = d.msg;
    } catch { /* не JSON */ }
    if (res.status === 403 && msg.startsWith('Ошибка')) msg = 'Нет доступа для вашей роли';
    throw new ApiError(res.status, 'error', msg[0].toUpperCase() + msg.slice(1));
  }
  return res.arrayBuffer();
}

/** Скачивает PDF API (с Bearer) в кэш и открывает «Поделиться». path — от корня API: /oyna/orders/{id}/documents/shop.pdf */
export async function sharePdf(path: string, fileName: string, title?: string): Promise<void> {
  const bytes = await fetchPdf(path);
  const f = new File(Paths.cache, fileName);
  f.create({ overwrite: true });
  await f.write(new Uint8Array(bytes));
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(f.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: title ?? fileName });
  } else {
    await Linking.openURL(f.uri);
  }
}
