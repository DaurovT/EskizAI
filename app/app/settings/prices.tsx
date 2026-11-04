/**
 * SCR-32 Цены и смета (Settings.dc.html, владелец): работа мастера (% / сумма), наценки по категориям,
 * смета для клиента по умолчанию, что можно отправлять сотрудникам. Сохраняется сразу; значение — правка в шторке.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../src/api';
import type { EstimateView, PricingOut } from '../../src/api/types';
import { useResource } from '../../src/hooks/useResource';
import { useT, type DictKey } from '../../src/i18n';
import { groupDigits } from '../../src/lib/format';
import { showError } from '../../src/ui/dialogs';
import { ErrorState } from '../../src/ui/ErrorState';
import { NumberField } from '../../src/ui/NumberField';
import { Button, Card, Hairline, Loading, Press, Screen, Segmented, Sheet, SurfaceProvider, T, toast } from '../../src/ui/kit';
import { palette } from '../../src/ui/theme';

const VIEWS: EstimateView[] = ['total', 'short', 'detailed'];
type NumKey = 'labor_percent' | 'labor_fixed' | 'markup_body' | 'markup_fronts' | 'markup_hardware' | 'markup_services';
const MARKUPS: [NumKey, DictKey][] = [['markup_body', 'pr2_body'], ['markup_fronts', 'pr2_fronts'], ['markup_hardware', 'pr2_hw'], ['markup_services', 'pr2_services']];

function Row({ title, value, onPress, right }: { title: string; value?: string; onPress?: () => void; right?: React.ReactNode }) {
  return (
    <Press feedback="row" onPress={onPress} style={s.row} accessibilityRole="button" accessibilityLabel={value ? `${title}: ${value}` : title}>
      <T v="rt" style={{ flex: 1 }}>{title}</T>
      {value != null ? <T v="rv" num>{value}</T> : null}
      {right}
    </Press>
  );
}
const Check = ({ on }: { on: boolean }) => (
  <View style={[s.ck, on ? s.ckOn : s.ckOff]}>{on ? <Ionicons name="checkmark" size={16} color={palette.white} /> : null}</View>
);
const List = ({ children }: { children: React.ReactNode[] }) => (
  <Card padded={false}>{children.map((c, i) => <View key={i}>{i ? <Hairline /> : null}{c}</View>)}</Card>
);

export default function Prices() {
  const { t, lang } = useT();
  const { data, error, loading, reload } = useResource(() => api.getPricing(), []);
  const [p, setP] = useState<PricingOut | null>(null);
  const [edit, setEdit] = useState<NumKey | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => { if (data) setP(data); }, [data]);
  if (loading && !p) return <Loading />;
  if (!p) return <ErrorState error={error} onRetry={reload} />;

  const save = async (patch: Partial<PricingOut>) => {
    const prev = p;
    setP({ ...p, ...patch });
    try {
      setP(await api.updatePricing(patch));
      toast.show({ text: t('pr_saved') });
    } catch (e) {
      setP(prev);
      showError(e, lang);
    }
  };
  const open = (k: NumKey) => { setDraft(p[k]); setEdit(k); };
  const pct = (n: number) => `${n} %`;
  const staffMore = p.employee_estimate_views.includes('short') || p.employee_estimate_views.includes('detailed');
  const setStaff = (total: boolean, more: boolean) => {
    const next = VIEWS.filter((v) => (v === 'total' ? total : more));
    if (next.length) save({ employee_estimate_views: next });
  };
  const editLabel = edit === 'labor_percent' ? t('pr2_labor_pct_row') : edit === 'labor_fixed' ? t('pr_labor_fixed') : edit ? t(MARKUPS.find(([k]) => k === edit)![1]) : '';

  return (
    <Screen contentStyle={{ paddingTop: 10, gap: 12 }}>
      <Stack.Screen options={{ title: t('pr2_title') }} />
      <View style={s.sec}>
        <T style={s.lbl}>{t('pr_labor')}</T>
        <Card padded={false}>
          <SurfaceProvider value="white">
            <View style={{ paddingTop: 8, paddingHorizontal: 8 }}>
              <Segmented value={p.labor_mode} onChange={(v) => save({ labor_mode: v })}
                options={[{ value: 'percent', label: t('pr_labor_percent') }, { value: 'fixed', label: t('pr_labor_fixed') }]} />
            </View>
          </SurfaceProvider>
          {p.labor_mode === 'percent'
            ? <Row title={t('pr2_labor_pct_row')} value={pct(p.labor_percent)} onPress={() => open('labor_percent')} />
            : <Row title={t('pr_labor_fixed')} value={groupDigits(p.labor_fixed)} onPress={() => open('labor_fixed')} />}
        </Card>
      </View>
      <View style={s.sec}>
        <T style={s.lbl}>{t('pr2_markups')}</T>
        <List>{MARKUPS.map(([k, l]) => <Row key={k} title={t(l)} value={pct(p[k])} onPress={() => open(k)} />)}</List>
      </View>
      <View style={s.sec}>
        <T style={s.lbl}>{t('pr2_default')}</T>
        <List>{VIEWS.map((v) => (
          <Row key={v} title={t(`pr2_view_${v}` as DictKey)} onPress={() => save({ default_estimate_view: v })} right={<Check on={p.default_estimate_view === v} />} />
        ))}</List>
      </View>
      <View style={s.sec}>
        <T style={s.lbl}>{t('pr2_staff')}</T>
        <List>{[
          <Row key="t" title={t('pr2_view_total')} onPress={() => setStaff(!p.employee_estimate_views.includes('total'), staffMore)} right={<Check on={p.employee_estimate_views.includes('total')} />} />,
          <Row key="m" title={t('pr2_staff_more')} onPress={() => setStaff(p.employee_estimate_views.includes('total'), !staffMore)} right={<Check on={staffMore} />} />,
        ]}</List>
      </View>
      <T v="cap" style={{ paddingHorizontal: 8 }}>{t('pr2_note')}</T>

      <Sheet visible={!!edit} onClose={() => setEdit(null)} title={editLabel}>
        {edit ? (
          <NumberField label={editLabel} value={draft} step={edit === 'labor_fixed' ? 100_000 : 5} min={0} max={edit === 'labor_fixed' ? 500_000_000 : 1000}
            unit={edit === 'labor_fixed' ? (lang === 'uz' ? 'so‘m' : 'сум') : '%'} onChange={(v) => setDraft(v ?? 0)} />
        ) : null}
        <Button title={t('done')} onPress={() => { if (edit && draft != null && draft !== p[edit]) save({ [edit]: draft } as Partial<PricingOut>); setEdit(null); }} />
      </Sheet>
    </Screen>
  );
}

const s = StyleSheet.create({
  sec: { gap: 6 },
  lbl: { paddingHorizontal: 8, fontSize: 18, lineHeight: 24, fontWeight: '700', letterSpacing: -0.18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 44, paddingVertical: 5, paddingHorizontal: 20 },
  ck: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  ckOn: { backgroundColor: palette.ink },
  ckOff: { borderWidth: 2, borderColor: palette.handle },
});
