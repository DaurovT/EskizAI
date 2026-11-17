/**
 * «Десктопный стиль» широкого планшета (TProjects2 / TInbox / TRequests / TDrawing .dc.html, 1194×834): боковая панель
 * 236 с разделами и счётчиками, строка инструментов 52 (.tb), плотные кнопки 32 (.btn), сегменты (.sgm), плашки (.pill),
 * колонки списков (.pane1, .lr), карточки с рамкой (.card) и строки «ключ — значение» (.kv2).
 * Только для useLayout().wide; телефон и портрет планшета эти компоненты не используют.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api';
import { useResource } from '../hooks/useResource';
import { useT } from '../i18n';
import { initials } from '../lib/clientRequests';
import { useSession } from '../state/session';
import { BrandLogo } from './Illus';
import { Press, resolveFont, type IconName } from './kit';
import { palette } from './theme';

/** Цвета досок «десктопного стиля» (их нет в палитре телефона). */
export const dk = {
  side: '#E9E8E4', sideLine: '#DEDCD7', sideHover: '#E1DFDA', sideText: '#3E3C39',
  tb: '#F7F6F3', line: '#E3E1DC', pane: '#FBFAF8', rowLine: '#EFEDE9', cardLine: '#E6E4DF', kvLine: '#F0EFEC',
  sel: '#E6F1EA', btnLine: '#DEDCD7', seg: '#E6E5E1', th: '#8E8B85', grid: '#EEF0F3', canvasGrid: '#F1F3F6',
};

export const SIDEBAR_W = 236;

export type SideKey = 'index' | 'clients' | 'orders' | 'inbox' | 'requests' | 'profile';
const ITEMS: { key: SideKey; icon: IconName; label: string; path: string; tab: boolean }[] = [
  { key: 'index', icon: 'folder-outline', label: 'tab_projects', path: '/', tab: true },
  { key: 'clients', icon: 'people-outline', label: 'tab_clients', path: '/clients', tab: true },
  { key: 'orders', icon: 'cube-outline', label: 'tab_orders', path: '/orders', tab: true },
  { key: 'inbox', icon: 'document-outline', label: 'inb_title', path: '/inbox', tab: false },
  { key: 'requests', icon: 'chatbox-outline', label: 'crq_title', path: '/client-requests', tab: false },
  { key: 'profile', icon: 'person-outline', label: 'tab_profile', path: '/profile', tab: true },
];

/** Раздел по адресу (для стека над вкладками: входящие, просьбы). */
export function sideKeyFor(path: string): SideKey | null {
  if (path.startsWith('/inbox')) return 'inbox';
  if (path.startsWith('/client-requests')) return 'requests';
  return null;
}

/** Счётчики боковой панели: новые входящие чертежи и новые просьбы клиентов. Обновляются при смене раздела. */
export function useSideCounts(dep: unknown) {
  const inbox = useResource(() => api.listInbox().catch(() => null), [dep]);
  const req = useResource(() => api.listWorkshopClientRequests({ status: 'new' }).catch(() => null), [dep]);
  return {
    inbox: (inbox.data?.items ?? []).filter((d) => !d.last_opened_at).length,
    requests: req.data?.new_count ?? 0,
  };
}

/**
 * .side — боковая панель 236: знак и «Eskiz Mebel», «＋ Новый проект», разделы со счётчиками, внизу «Производство»
 * и цех. onTab — переход на вкладку (из TabBar); без него — через router (экраны стека над вкладками).
 */
export function SideBar({ active, onTab }: { active: SideKey | null; onTab?: (key: SideKey) => void }) {
  const insets = useSafeAreaInsets();
  const { t } = useT();
  const { workshop } = useSession();
  const path = usePathname();
  const counts = useSideCounts(path);
  const inStack = sideKeyFor(path) != null;
  const go = (it: (typeof ITEMS)[number]) => {
    if (it.key === active) return;
    if (it.tab) {
      if (onTab) onTab(it.key);
      else router.navigate(it.path as never);
    } else if (inStack) router.replace(it.path as never);
    else router.push(it.path as never);
  };
  const badge = (k: SideKey) => (k === 'inbox' ? counts.inbox : k === 'requests' ? counts.requests : 0);
  return (
    <View style={[s.side, { paddingTop: insets.top + 14, paddingBottom: Math.max(insets.bottom, 12) }]} accessibilityRole="tablist">
      <View style={s.brand} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={s.logo}><BrandLogo size={26} /></View>
        <Text style={resolveFont(s.brandT)}>Eskiz Mebel</Text>
      </View>
      <Press onPress={() => router.push('/project/new')} accessibilityRole="button" accessibilityLabel={t('new_title')} style={s.snew}>
        <Ionicons name="add" size={18} color={palette.white} />
        <Text style={resolveFont(s.snewT)}>{t('new_title')}</Text>
      </Press>
      {ITEMS.map((it) => (
        <SideItem key={it.key} icon={it.icon} label={t(it.label as 'tab_projects')} on={it.key === active} badge={badge(it.key)} onPress={() => go(it)} />
      ))}
      <View style={{ flex: 1 }} />
      <SideItem icon="settings-outline" label={t('tab_production')} on={false} onPress={() => go(ITEMS[ITEMS.length - 1])} />
      <View style={s.acc}>
        <View style={s.accAv}><Text style={resolveFont(s.accAvT)}>{initials(workshop?.name)}</Text></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={resolveFont(s.accName)} numberOfLines={1}>{workshop?.name || '—'}</Text>
          {workshop?.city ? <Text style={resolveFont(s.accCity)} numberOfLines={1}>{workshop.city}</Text> : null}
        </View>
      </View>
    </View>
  );
}

function SideItem({ icon, label, on, badge, onPress }: { icon: IconName; label: string; on: boolean; badge?: number; onPress: () => void }) {
  return (
    <Press feedback="opacity" onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected: on }}
      accessibilityLabel={badge ? `${label}, ${badge}` : label} style={[s.si, on && s.siOn]}>
      <Ionicons name={icon} size={17} color={on ? palette.ink : dk.sideText} />
      <Text style={resolveFont([s.siT, on && { color: palette.ink }])} numberOfLines={1}>{label}</Text>
      {badge ? <View style={s.sb}><Text style={resolveFont(s.sbT)}>{badge}</Text></View> : null}
    </Press>
  );
}

/** Экран стека (входящие, просьбы) на широком планшете: боковая панель + содержимое. */
export function DesktopShell({ active, children }: { active: SideKey; children: ReactNode }) {
  return (
    <View style={s.shell}>
      <SideBar active={active} />
      <View style={s.main}>{children}</View>
    </View>
  );
}

/** .tb — строка инструментов 52 (под статус-баром): «назад» (по желанию), заголовок 16/700, подпись 13, справа — кнопки. */
export function Toolbar({ title, sub, onBack, children }: { title: string; sub?: string | null; onBack?: () => void; children?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { t } = useT();
  return (
    <View style={[s.tbWrap, { paddingTop: insets.top }]}>
      <View style={s.tb}>
        {onBack ? <DBtn icon="chevron-back" label={t('back')} onPress={onBack} /> : null}
        <Text style={resolveFont(s.tt)} numberOfLines={1}>{title}</Text>
        {sub ? <Text style={resolveFont(s.ts)} numberOfLines={1}>{sub}</Text> : null}
        <View style={{ flex: 1 }} />
        {children}
      </View>
    </View>
  );
}

/** Сетка «миллиметровки» под холстом (.canvas — линии через step). */
export function GridBg({ step = 20, color = dk.canvasGrid, rows = 48, cols = 64 }: { step?: number; color?: string; rows?: number; cols?: number }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {Array.from({ length: rows }, (_, i) => <View key={`h${i}`} style={{ position: 'absolute', left: 0, right: 0, top: (i + 1) * step, height: 1, backgroundColor: color }} />)}
      {Array.from({ length: cols }, (_, i) => <View key={`v${i}`} style={{ position: 'absolute', top: 0, bottom: 0, left: (i + 1) * step, width: 1, backgroundColor: color }} />)}
    </View>
  );
}

/** .btn — кнопка 32 r8 с рамкой; primary — зелёная; без title — квадратная с иконкой (label — для VoiceOver). */
export function DBtn({ title, icon, label, primary, onPress, disabled, style, tall }: {
  title?: string; icon?: IconName; label?: string; primary?: boolean; onPress?: () => void; disabled?: boolean;
  style?: StyleProp<ViewStyle>; tall?: boolean;
}) {
  const fg = primary ? palette.white : palette.ink;
  return (
    <Press onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label ?? title}
      style={[s.btn, primary && s.btnPri, !title && s.btnIc, tall && { height: 36 }, disabled && { opacity: 0.45 }, style]}>
      {icon ? <Ionicons name={icon} size={15} color={fg} /> : null}
      {title ? <Text style={resolveFont([s.btnT, { color: fg }])} numberOfLines={1}>{title}</Text> : null}
    </Press>
  );
}

/** .sgm — сегменты 28 в серой подложке. */
export function DSeg<V extends string>({ value, options, onChange }: { value: V; options: { value: V; label: string; n?: number | null }[]; onChange: (v: V) => void }) {
  return (
    <View style={s.sgm} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Press key={o.value} feedback="opacity" onPress={() => onChange(o.value)} accessibilityRole="tab" accessibilityState={{ selected: on }}
            accessibilityLabel={o.n != null ? `${o.label} ${o.n}` : o.label} style={[s.sg, on && s.sgOn]}>
            <Text style={resolveFont([s.sgT, on && { color: palette.ink }])} numberOfLines={1}>
              {o.label}{o.n != null ? <Text style={{ color: palette.count }}>{`  ${o.n}`}</Text> : null}
            </Text>
          </Press>
        );
      })}
    </View>
  );
}

export type PillTone = 'g' | 'b' | 'a' | 'n' | 'r';
const PILL: Record<PillTone, [string, string]> = {
  g: [palette.greenSoft, palette.greenDeep], b: [palette.blueSoft, palette.blue], a: [palette.amberSoft, palette.amberDeep],
  n: [palette.ground, palette.muted2], r: [palette.redSoft, palette.redDeep],
};
/** .pill — плашка 20 r6 11/700. */
export function Pill({ label, tone = 'n', style }: { label: string; tone?: PillTone; style?: StyleProp<ViewStyle> }) {
  const [bg, fg] = PILL[tone];
  return <View style={[s.pill, { backgroundColor: bg }, style]}><Text style={resolveFont([s.pillT, { color: fg }])} numberOfLines={1}>{label}</Text></View>;
}

/** .ph — заголовок колонки 40: 12/700 заглавными. */
export const PaneHead = ({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) => (
  <View style={[s.ph, style]}><Text style={resolveFont(s.phT)} numberOfLines={1}>{children}</Text></View>
);

/** .pane1 — колонка списка фиксированной ширины с правой линией. */
export function Pane({ width, children, bg = dk.pane, scroll = true }: { width: number; children: ReactNode; bg?: string; scroll?: boolean }) {
  return (
    <View style={[s.pane1, { width, backgroundColor: bg }]}>
      {scroll ? <ScrollView contentContainerStyle={{ paddingBottom: 20 }} showsVerticalScrollIndicator={false}>{children}</ScrollView> : children}
    </View>
  );
}

/** .lr — строка списка: выбранная — зелёная подложка и полоска 3 слева. */
export function ListRow({ on, onPress, children, style, label, onLongPress }: {
  on?: boolean; onPress?: () => void; onLongPress?: () => void; children: ReactNode; style?: StyleProp<ViewStyle>; label?: string;
}) {
  return (
    <Press feedback="row" onPress={onPress} onLongPress={onLongPress} delayLongPress={450} accessibilityRole="button" accessibilityState={{ selected: !!on }}
      accessibilityLabel={label} style={[s.lr, on && s.lrOn, style]}>
      {on ? <View style={s.lrBar} /> : null}
      {children}
    </Press>
  );
}

/** .card — белая карточка с рамкой r12. */
export const DCard = ({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) => <View style={[s.card, style]}>{children}</View>;

/** .kv2 — «ключ — значение» 13, последняя строка без линии. */
export function KV2({ k, v, last }: { k: string; v: ReactNode; last?: boolean }) {
  return (
    <View style={[s.kv, last && { borderBottomWidth: 0 }]}>
      <Text style={resolveFont(s.kvK)} numberOfLines={1}>{k}</Text>
      {typeof v === 'string' ? <Text style={resolveFont(s.kvV)} numberOfLines={1}>{v}</Text> : v}
    </View>
  );
}

/** Мелкий текст 12/16 (.cap2). */
export const Cap2 = ({ children, style }: { children: ReactNode; style?: object }) => <Text style={resolveFont([s.cap2, style])}>{children}</Text>;

export const desk = StyleSheet.create({
  /** Строка двух колонок «панели» под строкой инструментов. */
  panes: { flex: 1, minHeight: 0, flexDirection: 'row' },
  /** .lr .t / .s */
  t: { fontSize: 14, lineHeight: 19, fontWeight: '600', color: palette.ink },
  s: { fontSize: 12, lineHeight: 16, color: palette.muted },
  /** Холст с сеткой 20 (.canvas). */
  canvas: {
    flex: 1, minHeight: 0, margin: 12, borderRadius: 12, backgroundColor: palette.white, borderWidth: 1, borderColor: dk.cardLine,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
});

const s = StyleSheet.create({
  shell: { flex: 1, flexDirection: 'row', backgroundColor: palette.ground },
  main: { flex: 1, minWidth: 0 },
  side: { width: SIDEBAR_W, backgroundColor: dk.side, paddingHorizontal: 10, gap: 2, borderRightWidth: 1, borderRightColor: dk.sideLine },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 2, paddingHorizontal: 8, paddingBottom: 12 },
  logo: { width: 26, height: 26, borderRadius: 7, overflow: 'hidden' },
  brandT: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: palette.ink },
  snew: { height: 34, borderRadius: 9, backgroundColor: palette.green, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginHorizontal: 2, marginBottom: 10 },
  snewT: { fontSize: 14, lineHeight: 19, fontWeight: '600', color: palette.white },
  si: { height: 32, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10 },
  siOn: { backgroundColor: palette.white, boxShadow: '0px 1px 2px rgba(33,32,31,0.08)' },
  siT: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 19, fontWeight: '500', color: dk.sideText },
  sb: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  sbT: { fontSize: 11, lineHeight: 14, fontWeight: '700', color: palette.white, fontVariant: ['tabular-nums'] },
  acc: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 10, paddingHorizontal: 8, marginTop: 6, borderTopWidth: 1, borderTopColor: dk.sideLine },
  accAv: { width: 28, height: 28, borderRadius: 14, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  accAvT: { fontSize: 11, lineHeight: 14, fontWeight: '600', color: palette.white },
  accName: { fontSize: 12, lineHeight: 15, fontWeight: '600', color: palette.ink },
  accCity: { fontSize: 12, lineHeight: 15, color: palette.muted },
  tbWrap: { backgroundColor: dk.tb, borderBottomWidth: 1, borderBottomColor: dk.line },
  tb: { height: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 },
  tt: { fontSize: 16, lineHeight: 21, fontWeight: '700', letterSpacing: -0.16, color: palette.ink, flexShrink: 1 },
  ts: { fontSize: 13, lineHeight: 17, color: palette.muted, flexShrink: 2 },
  btn: {
    height: 32, borderRadius: 8, backgroundColor: palette.white, borderWidth: 1, borderColor: dk.btnLine, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 11,
  },
  btnPri: { backgroundColor: palette.green, borderColor: palette.green },
  btnIc: { width: 32, paddingHorizontal: 0 },
  btnT: { fontSize: 13, lineHeight: 17, fontWeight: '600' },
  sgm: { flexDirection: 'row', backgroundColor: dk.seg, borderRadius: 8, padding: 2 },
  sg: { height: 28, borderRadius: 6, paddingHorizontal: 11, justifyContent: 'center' },
  sgOn: { backgroundColor: palette.white, boxShadow: '0px 1px 2px rgba(0,0,0,0.08)' },
  sgT: { fontSize: 13, lineHeight: 17, fontWeight: '600', color: palette.muted2 },
  pill: { height: 20, borderRadius: 6, paddingHorizontal: 7, justifyContent: 'center', alignSelf: 'flex-start' },
  pillT: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
  ph: { height: 40, justifyContent: 'center', paddingHorizontal: 14 },
  phT: { fontSize: 12, lineHeight: 16, fontWeight: '700', color: dk.th, textTransform: 'uppercase', letterSpacing: 0.48 },
  pane1: { borderRightWidth: 1, borderRightColor: dk.line, minHeight: 0 },
  lr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: dk.rowLine },
  lrOn: { backgroundColor: dk.sel },
  lrBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: palette.green },
  card: { backgroundColor: palette.white, borderWidth: 1, borderColor: dk.cardLine, borderRadius: 12 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: dk.kvLine },
  kvK: { fontSize: 13, lineHeight: 17, color: palette.muted, flexShrink: 1 },
  kvV: { fontSize: 13, lineHeight: 17, fontWeight: '600', color: palette.ink, fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right' },
  cap2: { fontSize: 12, lineHeight: 16, color: palette.muted },
});
