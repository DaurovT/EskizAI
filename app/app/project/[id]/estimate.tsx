/**
 * SCR-10 Смета мастера (Estimate.dc.html). Владелец: строки себестоимости по группам (тап — позиции), работа мастера и наценка
 * степперами (сразу сохраняются в цены цеха и пересчитывают смету), доход, цена клиенту в футере.
 * Сотрудник без доступа к себестоимости (SCR-38, StaffView.dc.html): суммы скрыты, только цена клиенту.
 */
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import { isMasterEstimate, uncertaintyText, type MasterEstimate, type MasterEstimateLine, type PricingOut } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatDate, formatRange, groupDigits, noCurrency, plural } from '../../../src/lib/format';
import { useSession } from '../../../src/state/session';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { BigTitle, Button, ButtonRow, Card, Loading, Press, Screen, T, Tag } from '../../../src/ui/kit';
import { palette, tones } from '../../../src/ui/theme';
import { StaffEstimateView } from '../../../src/screens/StaffEstimate';

type TagTone = 'est' | 'info' | 'ok' | 'n' | 'err';
interface EstRow { key: string; title: string; sub: string; tag?: { label: string; tone: TagTone }; value: string; lines: MasterEstimateLine[]; cost?: number }

const isReq = (l: MasterEstimateLine) => l.status === 'request' || l.status === 'nonstandard';
const isSheet = (l: MasterEstimateLine) => /^sheet[.:]/.test(l.key) || l.unit === 'лист';
const sumOf = (ls: MasterEstimateLine[], f: (l: MasterEstimateLine) => number) => ls.reduce((s, l) => s + f(l), 0);
const sourceOf = (ls: MasterEstimateLine[]) => {
  const n: Record<string, number> = {};
  for (const l of ls) if (l.source) n[l.source] = (n[l.source] ?? 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
};

export default function Estimate() {
  const { id, devStaff } = useLocalSearchParams<{ id: string; devStaff?: string }>();
  const { t, td, lang } = useT();
  const { isOwner } = useSession();
  const { data: e, error, loading, reload } = useResource(() => api.getEstimate(id), [id]);
  const { data: pricing0 } = useResource<PricingOut | null>(() => (isOwner ? api.getPricing() : Promise.resolve(null)), [isOwner]);
  const [pricing, setPricing] = useState<PricingOut | null>(null);
  useEffect(() => { if (pricing0) setPricing(pricing0); }, [pricing0]);
  const [open, setOpen] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const master = isMasterEstimate(e) ? e : null;
  const rows = useMemo(() => (master ? buildRows(master, t, td) : []), [master, t, td]);

  if (loading && !e) return <Loading />;
  if (!e) return <ErrorState error={error} onRetry={reload} />;
  // dev: вид сотрудника без себестоимости на данных владельца (?devStaff=1) — для сверки с StaffView.dc.html
  if (!master || (__DEV__ && devStaff)) return <StaffEstimateView id={id} estimate={e} />;

  // ---- работа и наценка: шаг 5 %, сохраняем через 400 мс после последнего нажатия и пересчитываем смету
  const matMarkup = pricing ? Math.round((pricing.markup_body + pricing.markup_fronts + pricing.markup_hardware) / 3) : null;
  const change = (patch: Partial<PricingOut>) => {
    if (!pricing) return;
    const next = { ...pricing, ...patch };
    setPricing(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await api.updatePricing({ labor_percent: next.labor_percent, markup_body: next.markup_body, markup_fronts: next.markup_fronts, markup_hardware: next.markup_hardware });
        reload();
      } catch (err) {
        showError(err, lang);
        if (pricing0) setPricing(pricing0);
      }
    }, 400);
  };
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  const stepLabor = (d: number) => pricing && change({ labor_percent: clamp(pricing.labor_percent + d, 150) });
  const stepMarkup = (d: number) => pricing && change({
    markup_body: clamp(pricing.markup_body + d, 100), markup_fronts: clamp(pricing.markup_fronts + d, 100), markup_hardware: clamp(pricing.markup_hardware + d, 100),
  });

  // ---- доход: работа мастера + наценка по группам (от себестоимости «от»)
  const cost = master.cost_materials.from;
  const share = cost / Math.max(1, sumOf(master.lines, (l) => l.cost));
  const mk = (c: string) => (pricing ? ({ body: pricing.markup_body, fronts: pricing.markup_fronts, hardware: pricing.markup_hardware, services: pricing.markup_services } as Record<string, number>)[c] : master.markup_percent[c]) ?? 0;
  const labor = pricing ? (pricing.labor_mode === 'percent' ? (cost * pricing.labor_percent) / 100 : pricing.labor_fixed) : null;
  const profit = labor == null ? null
    : labor + Object.entries(master.cost_by_category).reduce((s, [c, v]) => s + (v * share * mk(c)) / 100, 0);
  const costPlus = master.cost_materials.to > master.cost_materials.from || master.has_requests;

  return (
    <Screen
      gap={8}
      contentStyle={{ paddingTop: 0 }}
      footerBar
      footer={
        <>
          <View style={st.totalRow}>
            <T v="cap" style={{ fontSize: 15 }}>{e.exact ? t('est_client_exact') : t('est_client_before')}</T>
            <T v="bigN" style={st.total} numberOfLines={1}>{noCurrency(formatRange(e.total, lang))}</T>
          </View>
          {/* до замера: чем объясняется диапазон (с сервера, только мастеру) */}
          {!e.exact && uncertaintyText(e, lang) ? <T v="cap" color={palette.amberDeep} style={{ marginTop: -8, textAlign: 'right' }}>{uncertaintyText(e, lang)}</T> : null}
          <T v="cap" style={{ marginTop: -6 }}>{e.exact ? t('est_foot_hint_exact') : t('est_foot_hint')}</T>
          <ButtonRow>
            <Button v="secondary" title={t('est_measure')} iconNode={<MaterialCommunityIcons name="ruler" size={20} color={palette.ink} />}
              onPress={() => router.push(`/project/${id}/measure`)} style={{ paddingHorizontal: 18 }} />
            <Button title={t('est_send')} onPress={() => router.push(`/project/${id}/send`)} style={{ flex: 1 }} />
          </ButtonRow>
        </>
      }
    >
      <Stack.Screen options={{ title: '' }} />
      <BigTitle style={{ paddingTop: 0 }}>{t('est_title')}</BigTitle>

      <Card padded={false}>
        {rows.map((r, i) => (
          <View key={r.key}>
            <Press feedback="row" onPress={() => setOpen(open === r.key ? null : r.key)} accessibilityRole="button"
              accessibilityState={{ expanded: open === r.key }} style={[st.ln, i > 0 && st.sep]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T v="rt" numberOfLines={2}>{r.title}</T>
                <View style={st.rs}>
                  {r.tag ? <Tag label={r.tag.label} tone={r.tag.tone} /> : null}
                  <T v="rs" numberOfLines={1} style={{ flexShrink: 1 }}>{r.sub}</T>
                </View>
              </View>
              <T v="rv" num style={{ paddingTop: 1 }}>{r.value}</T>
            </Press>
            {open === r.key ? r.lines.map((l) => (
              <View key={l.key} style={st.detail}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T v="rs" color={palette.ink} numberOfLines={2}>{l.name}</T>
                  <T v="rs" num style={{ fontSize: 13, lineHeight: 17 }}>
                    {`${groupDigits(l.qty)} ${l.unit} × ${groupDigits(l.unit_price)}`}{l.stale ? ` · ${t('est_line_stale', { date: formatDate(l.priced_at, lang) })}` : ''}
                  </T>
                </View>
                <T v="rs" num color={palette.ink} style={{ fontWeight: '600' }}>{groupDigits(l.cost)}</T>
              </View>
            )) : null}
          </View>
        ))}
        <View style={[st.row, st.sep, { backgroundColor: palette.rowPress }]}>
          <T v="rt" style={{ flex: 1, fontWeight: '600' }}>{t('est_cost')}</T>
          <T v="rv" num style={st.strong}>{`${groupDigits(cost)}${costPlus ? '+' : ''}`}</T>
        </View>
      </Card>

      <Card padded={false}>
        {pricing?.labor_mode !== 'fixed' ? (
          <View style={[st.row, { minHeight: 54 }]}>
            <T v="rt" style={{ flex: 1 }}>{t('est_work')}</T>
            <Stepper value={pricing?.labor_percent ?? null} onMinus={() => stepLabor(-5)} onPlus={() => stepLabor(5)} lessLabel={t('est_less')} moreLabel={t('est_more')} />
          </View>
        ) : null}
        <View style={[st.row, { minHeight: 54 }, pricing?.labor_mode !== 'fixed' && st.sep]}>
          <T v="rt" style={{ flex: 1 }} numberOfLines={1}>{t('est_markup_mat')}</T>
          <Stepper value={matMarkup ?? master.markup_percent.body ?? null} onMinus={() => stepMarkup(-5)} onPlus={() => stepMarkup(5)} lessLabel={t('est_less')} moreLabel={t('est_more')} disabled={!pricing} />
        </View>
        {profit != null ? (
          <View style={[st.row, st.sep, { minHeight: 52 }]}>
            <T v="rs" style={{ flex: 1, fontSize: 16 }}>{t('est_profit')}</T>
            <T v="rv" num color={tones.green.fg} style={st.strong}>{`+ ${noCurrency(formatRange({ from: profit, to: profit }, lang))}`}</T>
          </View>
        ) : null}
      </Card>
    </Screen>
  );
}

function Stepper({ value, onMinus, onPlus, lessLabel, moreLabel, disabled }: {
  value: number | null; onMinus: () => void; onPlus: () => void; lessLabel: string; moreLabel: string; disabled?: boolean;
}) {
  return (
    <View style={st.stp}>
      <Press onPress={onMinus} disabled={disabled} accessibilityRole="button" accessibilityLabel={lessLabel} style={st.pm}>
        <T style={st.pmT}>−</T>
      </Press>
      <T num style={st.mono}>{value == null ? '—' : `${value}%`}</T>
      <Press onPress={onPlus} disabled={disabled} accessibilityRole="button" accessibilityLabel={moreLabel} style={st.pm}>
        <T style={st.pmT}>+</T>
      </Press>
    </View>
  );
}

type TFn = ReturnType<typeof useT>['t'];
type TdFn = ReturnType<typeof useT>['td'];

/** Строки сметы как в макете: листы · распил и кромка · фасады · фурнитура · каждая позиция «под запрос»/нестандарт отдельно. */
function buildRows(m: MasterEstimate, t: TFn, td: TdFn): EstRow[] {
  // декор фасадов, подсветка, доборы и панели — своими строками (core/estimate.py DECOR_GROUP, LIGHT_GROUP)
  const special = (l: MasterEstimateLine) => (l.group === 'Декор фасадов' || /^decor:(paint|milling|overlay|inlay)/.test(l.key) ? 'decor'
    : l.group === 'Подсветка' || /^decor:(led|sensor|power)/.test(l.key) ? 'light'
      : l.group === 'Доборы и панели' || /^fill:|wedge_cut|filler|false_panel/.test(l.key) ? 'fill' : null);
  const ok = m.lines.filter((l) => !isReq(l) && !special(l));
  const sheets = ok.filter((l) => l.category === 'body' && isSheet(l));
  const services = ok.filter((l) => l.category === 'services' || (l.category === 'body' && !isSheet(l)));
  const fronts = ok.filter((l) => l.category === 'fronts');
  const hw = ok.filter((l) => l.category === 'hardware');
  const tagOf = (ls: MasterEstimateLine[]): EstRow['tag'] =>
    ls.some((l) => l.stale) ? { label: t('est_tag_stale'), tone: 'est' }
      : ls.some((l) => l.status === 'analog') ? { label: td('est_ls_analog', 'аналог'), tone: 'est' } : undefined;
  const sub = (ls: MasterEstimateLine[], tail: string) => [sourceOf(ls), tail].filter(Boolean).join(' · ');
  const value = (ls: MasterEstimateLine[]) => groupDigits(sumOf(ls, (l) => l.cost));
  const rows: EstRow[] = [];
  // листы — строка на каждый декор (дорогие сверху)
  for (const name of [...new Set(sheets.map((l) => l.name))]) {
    const ls = sheets.filter((l) => l.name === name);
    const n = Math.round(sumOf(ls, (l) => l.qty));
    rows.push({ key: `sheets.${name}`, title: name, sub: sub(ls, `${n} ${plural(n, t('est_u_sheet'))}`), tag: tagOf(ls), value: value(ls), lines: ls, cost: sumOf(ls, (l) => l.cost) });
  }
  rows.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  if (services.length) {
    rows.push({ key: 'services', title: t('est_row_services'), sub: sub(services, `${services.length} ${plural(services.length, t('est_u_pos'))}`),
      tag: tagOf(services), value: value(services), lines: services });
  }
  if (fronts.length) {
    const n = Math.round(sumOf(fronts, (l) => (l.unit === 'шт' ? l.qty : 0))) || fronts.length;
    rows.push({ key: 'fronts', title: td('est_cat_fronts', 'Фасады'), sub: sub(fronts, `${n} ${t('est_u_pcs')}`), tag: tagOf(fronts), value: value(fronts), lines: fronts });
  }
  if (hw.length) {
    const n = hw.length;
    rows.push({ key: 'hardware', title: td('est_cat_hardware', 'Фурнитура'), sub: sub(hw, `${n} ${plural(n, t('est_u_pos'))}`), tag: tagOf(hw), value: value(hw), lines: hw });
  }
  for (const [k, title] of [['decor', t('est2_decor')], ['light', t('est2_light')], ['fill', t('est2_fill')]] as const) {
    const ls = m.lines.filter((l) => !isReq(l) && special(l) === k);
    if (ls.length) rows.push({ key: k, title, sub: sub(ls, `${ls.length} ${plural(ls.length, t('est_u_pos'))}`), tag: tagOf(ls), value: value(ls), lines: ls });
  }
  for (const l of m.lines.filter(isReq)) {
    rows.push({ key: l.key, title: l.name, sub: l.source,
      tag: l.status === 'request' ? { label: td('est_ls_request', 'под запрос'), tone: 'info' } : { label: td('est_ls_nonstandard', 'нестандарт'), tone: 'err' },
      value: l.cost ? groupDigits(l.cost) : '—', lines: [l] });
  }
  return rows;
}

const st = StyleSheet.create({
  ln: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, minHeight: 60, paddingVertical: 9, paddingHorizontal: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingVertical: 10, paddingHorizontal: 20 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  rs: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  detail: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 6, paddingLeft: 32, paddingRight: 20 },
  strong: { fontSize: 17, fontWeight: '700' },
  stp: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pm: { width: 36, height: 36, borderRadius: 12, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  pmT: { fontSize: 20, lineHeight: 24, fontWeight: '500' },
  mono: { minWidth: 42, textAlign: 'center', fontSize: 17, lineHeight: 22, fontWeight: '600' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  total: { fontSize: 26, lineHeight: 32, flexShrink: 1 },
});
