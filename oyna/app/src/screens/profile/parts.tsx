/**
 * Общее для экранов входа, цеха, профиля, каталога и клиентов (кандидаты в src/ui/kit.tsx):
 * XIcon — иконки макета, которых нет в src/ui/Icon.tsx; Tag (.tag), Ban (.ban), SearchBox (.search), Check (.ck),
 * Tile (.tile), Label (.lbl), Dot (.dot), WindowArt (картинка окна на «Цех готов»), plural / unitTitle / ROLE_TITLE.
 */
import { ReactNode, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleProp, TextInput, View, ViewStyle } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { num } from '@/lib/format';
import { C, F, TAG } from '@/theme';
import { Icon } from '@/ui/Icon';
import { Card, Chip, Note, Row, Txt } from '@/ui/kit';

// ---------- иконки макета ----------
type Shape = { d?: string; circle?: [number, number, number]; rect?: [number, number, number, number, number] };
const X: Record<string, Shape[]> = {
  lock: [{ rect: [5, 10.5, 14, 10, 2] }, { d: 'M8 10.5V8a4 4 0 0 1 8 0v2.5' }],
  photo: [{ d: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z' }, { circle: [12, 12.5, 3.2] }],
  gear: [{ circle: [12, 12, 3] }, { d: 'M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6' }],
  house: [{ d: 'M4 11l8-6.5 8 6.5' }, { d: 'M6 9.5V19.5h12V9.5' }],
  frame: [{ rect: [4, 3.5, 16, 17, 1.5] }, { d: 'M12 3.5v17M4 12h8' }],
  grid: [{ rect: [4, 4, 7, 7, 1.5] }, { rect: [13, 4, 7, 7, 1.5] }, { rect: [4, 13, 7, 7, 1.5] }, { rect: [13, 13, 7, 7, 1.5] }],
  tag: [{ d: 'M4 12.5V5.5A1.5 1.5 0 0 1 5.5 4h7l7.5 7.5-8.5 8.5z' }, { circle: [9, 9, 1.5] }],
  cube: [{ d: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z' }, { d: 'M4 7.5L12 12l8-4.5M12 12v9' }],
  team: [{ circle: [9, 8.5, 3.5] }, { d: 'M3 19c.8-3.2 3.2-5 6-5s5.2 1.8 6 5' }, { d: 'M15.5 5.3a3.5 3.5 0 0 1 0 6.4M17.5 14.4c1.7.7 3 2.3 3.5 4.6' }],
  chat: [{ d: 'M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.5V17h-.5A1.5 1.5 0 0 1 4 15.5z' }],
  alert: [{ d: 'M12 4l9 16H3z' }, { d: 'M12 10v4.5M12 17.5v.01' }],
  tick: [{ d: 'M5 12.5l4.5 4.5L19 7' }],
  logout: [{ d: 'M10 5H6a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 6 19h4' }, { d: 'M14 8l4 4-4 4M18 12H9' }],
  dollar: [{ circle: [12, 12, 9] }, { d: 'M14.8 9.2c-.5-1-1.5-1.5-2.8-1.5-1.6 0-2.7.8-2.7 2 0 2.8 5.6 1.6 5.6 4.5 0 1.3-1.2 2.1-2.9 2.1-1.4 0-2.5-.6-3-1.6M12 6v1.7M12 16.3V18' }],
};
export type XIconName = keyof typeof X;

export function XIcon({ name, size = 22, color = C.ink, stroke = 2.2 }: { name: XIconName; size?: number; color?: string; stroke?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {X[name].map((sh, i) => sh.d ? <Path key={i} d={sh.d} />
        : sh.circle ? <Circle key={i} cx={sh.circle[0]} cy={sh.circle[1]} r={sh.circle[2]} />
          : sh.rect ? <Rect key={i} x={sh.rect[0]} y={sh.rect[1]} width={sh.rect[2]} height={sh.rect[3]} rx={sh.rect[4]} /> : null)}
    </Svg>
  );
}

// ---------- мелкие детали макета ----------
/** .tag est / info / ok / n / err */
export function Tag({ kind = 'est', children }: { kind?: keyof typeof TAG; children: ReactNode }) {
  const c = TAG[kind];
  return (
    <View style={{ height: 24, paddingHorizontal: 9, borderRadius: 8, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' }}>
      <Txt size={13} w={600} color={c.fg} style={{ lineHeight: 17 }}>{children}</Txt>
    </View>
  );
}

/** .st c-* — тонированная плашка (gray/red/blue/green/amber) */
const ST = { gray: ['#F2F1EE', '#55524D'], red: ['#FFE7E4', '#A1221A'], blue: ['#E3EEFC', '#154A99'], green: ['#E6F1EA', '#275C3A'], amber: ['#FFF0D4', '#8A4B00'] } as const;
export function St({ c = 'gray', children }: { c?: keyof typeof ST; children: ReactNode }) {
  return (
    <View style={{ height: 26, paddingHorizontal: 10, borderRadius: 9, backgroundColor: ST[c][0], alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' }}>
      <Txt size={13} w={600} color={ST[c][1]} style={{ lineHeight: 18 }}>{children}</Txt>
    </View>
  );
}

/** .ban est / info / err / ok */
const BAN = { est: [C.estBg, C.estFg], info: [C.accentSoft, C.accentDeep], err: [C.errBg, C.errFg], ok: [C.okBg, C.okFg] } as const;
export function Ban({ kind = 'est', title, text, icon = true, style, onPress }: {
  kind?: keyof typeof BAN; title?: string; text?: string; icon?: boolean; style?: StyleProp<ViewStyle>; onPress?: () => void;
}) {
  const [bg, fg] = BAN[kind];
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={[{ borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', gap: 12, alignItems: 'flex-start', backgroundColor: bg }, style]}>
      {icon ? <View style={{ paddingTop: 1 }}><XIcon name="alert" size={20} color={fg} stroke={2.3} /></View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {title ? <Txt size={16} w={600} color={fg} style={{ lineHeight: 21 }}>{title}</Txt> : null}
        {text ? <Txt size={14} color={fg} style={{ lineHeight: 19 }}>{text}</Txt> : null}
      </View>
    </Pressable>
  );
}

/** .search — поле поиска (белое; внутри белой карточки — серое: gray) */
export function SearchBox({ value, onChange, placeholder, gray, style }: { value: string; onChange: (v: string) => void; placeholder: string; gray?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ height: 48, borderRadius: 16, backgroundColor: gray ? C.soft : C.card, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 }, style]}>
      <Icon name="search" size={20} color={C.faint} />
      <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.faint} returnKeyType="search"
        autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing"
        style={{ flex: 1, fontFamily: F.regular, fontSize: 16, color: C.ink, paddingVertical: 0 }} />
    </View>
  );
}

/** .ck — квадратная галочка выбора */
export function Check({ on }: { on: boolean }) {
  return (
    <View style={[{ width: 24, height: 24, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
      on ? { backgroundColor: C.accent } : { borderWidth: 2, borderColor: '#C9C6C0' }]}>
      {on ? <XIcon name="tick" size={16} color="#fff" stroke={2.6} /> : null}
    </View>
  );
}

/** .tile — квадрат 44 с иконкой */
export function Tile({ children, bg = C.soft }: { children: ReactNode; bg?: string }) {
  return <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>{children}</View>;
}

/** .lbl — подпись группы над карточкой */
export const Label = ({ children }: { children: ReactNode }) => (
  <Txt size={15} w={600} color={C.muted} style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>{children}</Txt>
);

export const Dot = ({ color = C.amber }: { color?: string }) => <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;

/** Картинка окна (макет Setup6) */
export function WindowArt() {
  return (
    <Svg width={74} height={82} viewBox="0 0 74 82">
      <Rect x={2} y={2} width={70} height={78} fill="#fff" stroke={C.ink} strokeWidth={2.5} />
      <Rect x={7} y={7} width={60} height={68} fill="none" stroke={C.ink} strokeWidth={1.5} />
      <Rect x={9} y={9} width={24} height={64} fill="#fff" stroke={C.ink} strokeWidth={1.5} />
      <Rect x={13.5} y={13.5} width={15} height={55} fill="#DCE9F1" stroke={C.ink} strokeWidth={1} />
      <Path d="M28.5 13.5L13.5 41.0L28.5 68.5" fill="none" stroke="#55524D" strokeWidth={1.3} strokeDasharray="5 4" />
      <Path d="M13.5 13.5L21.0 68.5L28.5 13.5" fill="none" stroke="#55524D" strokeWidth={1.3} strokeDasharray="5 4" />
      <Rect x={29.6} y={33} width={3} height={16} rx={1.5} fill={C.ink} />
      <Rect x={42} y={10} width={22} height={62} fill="#DCE9F1" stroke={C.ink} strokeWidth={1} />
    </Svg>
  );
}

// ---------- текст ----------
/** plural(4, 'попытка', 'попытки', 'попыток') → «попытки» */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export const UNIT_TITLE: Record<string, string> = { bar: 'хлыст', m: 'м', kg: 'кг', pcs: 'шт', m2: 'м²', pack: 'уп.', order: 'заказ', floor: 'этаж' };
export const unitTitle = (u?: string | null) => (u ? UNIT_TITLE[u] ?? u : '');

export const MATERIAL_TITLE: Record<string, string> = { pvc: 'ПВХ', alu_cold: 'Холодный алюминий', alu_thermo: 'Тёплый алюминий' };

export const ROLE_TITLE: Record<string, string> = {
  frame: 'рама', sash: 'створка', mullion: 'импост', door_frame: 'рама двери', door_sash: 'створка двери', door_mullion: 'импост двери',
  shtulp: 'штульп', threshold: 'порог', bead_single: 'штапик (стекло)', bead_igu: 'штапик', bead_triple: 'штапик (3 стекла)', lambri: 'ламбри',
  reinforcement: 'армирование', connector: 'соединитель', joint_profile: 'соединительный профиль', coupling_profile: 'расширитель',
  thermo_insert: 'термовставка', fit_hinge: 'петля', fit_handle: 'ручка', fit_lock: 'замок', fit_scissors: 'ножницы', fit_drive: 'привод',
  fit_set: 'фурнитура', fit_cap: 'накладка', seal: 'уплотнитель', sill: 'подоконник', sill_cap: 'заглушка подоконника',
  mosquito_profile: 'москитный профиль', corner_cleat: 'уголок', machine: 'станок', other: 'нужна разметка',
};

export const ROLE_NAME: Record<string, string> = {
  owner: 'владелец', manager: 'менеджер', measurer: 'замерщик', installer: 'монтажник', production: 'производство',
};

/** «наценка 30% на себестоимость» / «маржа 25% в цене» / «+50 000 сум за м²» */
export function markupText(kind?: string | null, value?: number | null): string {
  const v = Number(value ?? 0);
  if (kind === 'margin') return `маржа ${v}% в цене`;
  if (kind === 'per_m2') return `+${num(v)} сум за м²`;
  return `наценка ${v}% на себестоимость`;
}

/** Цифры из строки (номер, сумма) */
export const digits = (s: string) => s.replace(/\D/g, '');
/** «12 010,45» → 12010.45 */
export function parseNum(s: string): number | null {
  const t = s.replace(/\s/g, '').replace(',', '.').replace(/[^0-9.]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ---------- ответы API, которых нет в src/api/types.ts ----------
/** GET /oyna/systems */
export type SystemRow = {
  code: string; brand: string; series: string; material: string; depth_mm: number | null; chambers: number | null;
  demo_passport: boolean; colors: string[]; fitting_groove: string; fittings: string[];
};
/** GET /oyna/fx/usd */
export type Fx = { rate: number | null; date?: string; source: 'cbu' | 'fixed' | 'unavailable' };

/** «60 мм · 4 камеры · белый, ламинация» */
export function systemSub(s: SystemRow): string {
  const parts: string[] = [];
  if (s.depth_mm) parts.push(`${s.depth_mm} мм`);
  if (s.chambers) parts.push(`${s.chambers} ${plural(s.chambers, 'камера', 'камеры', 'камер')}`);
  if (s.colors.length) parts.push(s.colors.map((c) => c.toLowerCase()).join(', '));
  return parts.join(' · ') || MATERIAL_TITLE[s.material] || '';
}

/** Выбор систем: поиск, фильтр по материалу, группы по бренду (Setup2 и «Системы» в профиле). */
export function filterSystems(list: SystemRow[], material: string, q: string): { brand: string; rows: SystemRow[] }[] {
  const needle = q.trim().toLowerCase();
  const groups = new Map<string, SystemRow[]>();
  for (const s of list) {
    if (material && s.material !== material) continue;
    if (needle && !`${s.brand} ${s.series}`.toLowerCase().includes(needle)) continue;
    groups.set(s.brand, [...(groups.get(s.brand) ?? []), s]);
  }
  return [...groups.entries()].map(([brand, rows]) => ({ brand, rows }));
}

const MATERIALS = [{ value: 'pvc', title: 'ПВХ' }, { value: 'alu_cold', title: 'Холодный алюминий' }, { value: 'alu_thermo', title: 'Тёплый алюминий' }];

/** Список систем с галочками (макет Setup2): поиск, чипсы материала, группы по бренду, метка демо-паспорта. */
export function SystemPicker({ list, selected, onToggle, disabled }: {
  list: SystemRow[]; selected: string[]; onToggle?: (code: string) => void; disabled?: boolean;
}) {
  const [q, setQ] = useState('');
  const [material, setMaterial] = useState('pvc');
  const groups = filterSystems(list, material, q);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ paddingHorizontal: 12 }}><SearchBox value={q} onChange={setQ} placeholder="Akfa, Lega, Ekopen…" /></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}>
        {MATERIALS.map((m) => {
          const n = list.filter((s) => s.material === m.value && selected.includes(s.code)).length;
          return <Chip key={m.value} title={n ? `${m.title} · ${n}` : m.title} on={material === m.value} onPress={() => setMaterial(m.value)} />;
        })}
      </ScrollView>
      {groups.length === 0 ? <Note style={{ paddingHorizontal: 20 }}>Ничего не нашли</Note> : null}
      {groups.map((g) => (
        <View key={g.brand}>
          <Txt size={15} w={600} color={C.muted} style={{ paddingHorizontal: 20, paddingTop: 2, paddingBottom: 8 }}>{g.brand}</Txt>
          <Card>
            {g.rows.map((s, i) => (
              <Row key={s.code} first={i === 0} chevron={false} onPress={disabled || !onToggle ? undefined : () => onToggle(s.code)}
                left={<Check on={selected.includes(s.code)} />}
                label={`${s.brand} ${s.series}`} sub={systemSub(s)}
                right={s.demo_passport ? <Tag kind="est">ДЕМО</Tag> : undefined} />
            ))}
          </Card>
        </View>
      ))}
    </View>
  );
}

/** Содержимое нижнего листа: прокрутка + подъём над клавиатурой. */
export function SheetBody({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 12, gap: 10 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      {footer ? <View style={{ paddingHorizontal: 12, paddingTop: 8, gap: 8 }}>{footer}</View> : null}
    </KeyboardAvoidingView>
  );
}
