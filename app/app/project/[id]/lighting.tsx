/**
 * SCR-49 Подсветка (Lighting.dc.html): места подсветки для этого изделия с длиной ленты (из 3D или по размерам),
 * места другого типа изделий — бледно; цвет света 3000/4000/6000 K плашками «тёплый → холодный», датчик
 * (нет / дверь / движение / кнопка) — для всех мест (`lighting[]`). Состав и сумма — по подсказкам цен
 * GET /catalog/lighting-zones (себестоимость за м и за датчик), блок питания — по смете. Применение — новая версия.
 */
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import { isMasterEstimate, type LightingItem, type ProductTree } from '../../../src/api/types';
import type { ViewerModel } from '@mebel/viewer';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { groupDigits, plural } from '../../../src/lib/format';
import { useOffline } from '../../../src/state/net';
import { requestEvening } from '../../../src/state/evening';
import { useSession } from '../../../src/state/session';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { FitSegmented, HGradient, SmallToggle } from '../../../src/ui/Gradient';
import { Button, Loading, Press, Screen, T, toast } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

/** Места подсветки по типу изделия (как LIGHTING_OPTIONS ядра). */
const WARDROBE = ['niche', 'inside_top', 'wardrobe_rod'];
const KITCHEN = ['under_wall', 'plinth'];
export const TEMP_STOPS: Record<number, string[]> = { 3000: ['#FFC977', '#FFE2B0'], 4000: ['#FFF1D6', '#FFFFFF'], 6000: ['#DDEBFF', '#F4F8FF'] };
const SENSORS = ['none', 'door', 'motion', 'touch'] as const;
const m1 = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');

/** Длина ленты места, м: по профилям 3D, иначе по размерам изделия. */
export function zoneLength(zone: string, tree: ProductTree, viewer?: ViewerModel | null): number {
  const ls = (viewer?.lights ?? []).filter((l) => (l as { zone?: string }).zone === zone);
  if (ls.length) return ls.reduce((a, l) => a + Math.hypot(l.to[0] - l.from[0], l.to[1] - l.from[1], l.to[2] - l.from[2]), 0) / 1000;
  const W = (tree.width ?? 1600) - 32;
  const secs = tree.sections ?? [];
  const sec = secs.length ? W / secs.length : W;
  const row = (r: string) => ((tree[r] as { width?: number }[] | undefined) ?? []).reduce((a, x) => a + (x.width ?? 0), 0);
  switch (zone) {
    case 'niche': return sec / 1000;
    case 'wardrobe_rod': return (Math.max(1, secs.filter((x) => (x.fill ?? []).some((f) => f.kind === 'rod')).length) * sec) / 1000;
    case 'under_wall': return row('wall') / 1000;
    case 'plinth': return (tree.type === 'kitchen' ? row('base') : W) / 1000;
    default: return W / 1000;
  }
}

export default function Lighting() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, td, lang } = useT();
  const offline = useOffline();
  const { seesCost } = useSession();
  const model = useResource(() => api.getModel(id), [id]);
  const card = useResource(() => api.getProject(id).catch(() => null), [id]);
  const cat = useResource(() => api.getLightingZones(), [], { refetchOnFocus: false });
  const est = useResource(() => (seesCost ? api.getEstimate(id).catch(() => null) : Promise.resolve(null)), [id, seesCost]);
  const [draft, setDraft] = useState<ProductTree | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (model.data) setDraft(model.data.version.tree); }, [model.data?.version.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if ((model.loading && !draft) || (cat.loading && !cat.data)) return <Loading />;
  if (!draft || !cat.data) return <ErrorState error={model.error ?? cat.error} onRetry={() => { model.reload(); cat.reload(); }} />;
  const c = cat.data;
  const viewer = model.data!.version.viewer;
  const kitchen = draft.type === 'kitchen';
  const items = (draft.lighting as LightingItem[] | undefined) ?? [];
  const base = (model.data!.version.tree.lighting as LightingItem[] | undefined) ?? [];
  const dirty = JSON.stringify(items) !== JSON.stringify(base);
  const known = new Set(c.zones.map((z) => z.id));
  const own = (kitchen ? KITCHEN : WARDROBE).filter((z) => known.has(z));
  // включённые места, которых нет в коротком списке (например «под полками»), — тоже показываем
  for (const it of items) if (!own.includes(it.zone)) own.push(it.zone);
  const other = (kitchen ? WARDROBE : KITCHEN).filter((z) => known.has(z) && !own.includes(z));
  const temp = items[0]?.temp ?? 3000;
  const sensor = (items[0]?.sensor ?? 'none') as (typeof SENSORS)[number];
  const len = items.reduce((a, it) => a + zoneLength(it.zone, draft, viewer), 0);
  const name = (z: string) => td(`lt_z_${z}`, c.zones.find((x) => x.id === z)?.[lang === 'uz' ? 'name_uz' : 'name'] ?? z);

  const toggle = (zone: string, on: boolean) => setDraft({ ...draft, lighting: on
    ? [...items, { zone, target: 'all', temp, sensor, mount: 'groove' }]
    : items.filter((x) => x.zone !== zone) });
  const setAll = (p: Partial<LightingItem>) => setDraft({ ...draft, lighting: items.map((x) => ({ ...x, ...p })) });
  const apply = async () => {
    if (!dirty) return router.back();
    setSaving(true);
    try {
      await api.saveModel(id, { tree: draft, source: 'manual', label: t('lt_applied'), reject_on_errors: true });
      toast.show({ text: t('lt_applied'), tone: 'success' });
      if (items.length) requestEvening(id);
      router.back();
    } catch (e) { showError(e, lang); } finally { setSaving(false); }
  };

  // состав: лента и профиль за м, датчик — на каждое место, блок питания — из сметы (подбирает ядро)
  const ph = c.price_hint;
  const n = items.length;
  const r100 = (v: number) => Math.round(v / 100) * 100;
  const pTape = n && ph?.strip ? r100(ph.strip.price * len) : 0;
  const pProf = n && ph?.profile ? r100(ph.profile.price * len) : 0;
  const sHint = c.sensors.find((x) => x.id === sensor)?.price_hint;
  const pSens = n && sHint ? sHint.price * n : 0;
  const watts = n ? (len * 9.6 * 1.25 <= 30 ? 30 : len * 9.6 * 1.25 <= 60 ? 60 : 100) : 0;
  const psuLine = isMasterEstimate(est.data) ? est.data.lines.find((l) => /power/.test(l.key)) : null;
  const pPsu = n && psuLine ? psuLine.cost : 0;
  const total = pTape + pProf + pSens + pPsu;
  const title = [card.data?.title, card.data?.client?.name].filter(Boolean).join(' · ');
  const money = (v: number) => (seesCost ? groupDigits(v) : '');

  const zoneRow = (z: string, dim: boolean) => {
    const on = !dim && items.some((x) => x.zone === z);
    return (
      <View key={z} style={s.lr}>
        <T v="rt" style={{ flex: 1, fontSize: 15 }} numberOfLines={1}>{name(z)}</T>
        {!dim || zoneLength(z, draft, viewer) > 0.05 ? <T num style={s.m}>{t('lt_m', { m: m1(zoneLength(z, draft, viewer)) })}</T> : null}
        <SmallToggle value={on} disabled={dim} onValueChange={(v) => toggle(z, v)} accessibilityLabel={name(z)} />
      </View>
    );
  };

  return (
    <Screen gap={8} contentStyle={{ paddingTop: 2 }} footerBar footerStyle={s.bbar}
      footer={
        <>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="cap" style={{ fontSize: 13, lineHeight: 16 }} numberOfLines={1}>{t('lt_sum_label', { n: n ? `${n} ${plural(n, t('lt_places'))}` : t('lt_off') })}</T>
            {seesCost ? <T num style={s.total} numberOfLines={1}>{total ? `+ ${groupDigits(total)}` : '0'} <T style={{ fontSize: 15, fontWeight: '400', color: palette.muted }}>{lang === 'uz' ? 'so‘m' : 'сум'}</T></T> : null}
          </View>
          <Button title={t('bi_apply')} onPress={apply} loading={saving} disabled={dirty && offline} style={{ paddingHorizontal: 26, flexGrow: 0 }} />
        </>
      }>
      <Stack.Screen options={{ title: '', headerRight: title ? () => <View style={s.pill}><T style={s.pillT} numberOfLines={1}>{title}</T></View> : undefined }} />
      <T style={s.ttl}>{t('lt_title')}</T>
      <View style={s.sh}><T style={s.shT}>{kitchen ? t('lt_kitchen') : t('lt_wardrobe')}</T><T num style={s.shS}>{t('lt_tape_m', { m: m1(len) })}</T></View>
      <View style={s.sheet}>{own.map((z) => zoneRow(z, false))}</View>
      {other.length ? (
        <>
          <View style={s.sh}><T style={s.shT}>{kitchen ? t('lt_wardrobe') : t('lt_kitchen')}</T><T style={s.shS}>{kitchen ? t('lt_for_wardrobe') : t('lt_for_kitchen')}</T></View>
          <View style={[s.sheet, { opacity: 0.55 }]}>{other.map((z) => zoneRow(z, true))}</View>
        </>
      ) : null}

      <View style={s.sh}><T style={s.shT}>{t('lt_color')}</T></View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {c.temps.map((tp) => {
          const on = temp === tp.value;
          return (
            <Press key={tp.value} onPress={() => setAll({ temp: tp.value })} accessibilityRole="radio" accessibilityState={{ selected: on }} style={[s.ct, on && s.ctOn]}>
              <HGradient stops={TEMP_STOPS[tp.value] ?? ['#FFFFFF', '#FFFFFF']} style={{ height: 10, borderRadius: 5 }} />
              <T style={{ fontSize: 14, lineHeight: 17, fontWeight: '600' }}>{td(`lt_t_${tp.value}`, lang === 'uz' ? tp.name_uz : tp.name)}</T>
              <T num style={{ fontSize: 12, lineHeight: 14, color: palette.muted }}>{tp.value} K</T>
            </Press>
          );
        })}
      </View>
      <View style={s.sh}><T style={s.shT}>{t('lt_sensor_h')}</T><T style={s.shS}>{t('lt_sensor_how')}</T></View>
      <FitSegmented value={sensor} onChange={(v) => setAll({ sensor: v })} options={SENSORS.map((x) => ({ value: x, label: t(`lt_s2_${x}`) }))} />
      <View style={s.pl}>
        {[
          [t('lt_p_tape', { k: temp, m: m1(len) }), money(pTape)],
          [t('lt_p_profile'), money(pProf)],
          [t(`lt_sn_${sensor}`), money(pSens)],
          [n ? t('lt_p_psu', { w: watts }) : t('lt_p_nopsu'), psuLine || !n ? money(pPsu) : '—'],
        ].map(([k, v]) => (
          <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <T style={s.plK} numberOfLines={1}>{k}</T>
            {v ? <T num style={s.plV}>{v}</T> : null}
          </View>
        ))}
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  pill: { height: 32, borderRadius: 9, backgroundColor: palette.white, paddingHorizontal: 10, justifyContent: 'center', maxWidth: 240 },
  pillT: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: palette.muted2 },
  ttl: { fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.65, paddingHorizontal: 4 },
  sh: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: 4 },
  shT: { fontSize: 17, lineHeight: 22, fontWeight: '700' },
  shS: { fontSize: 13, fontWeight: '500', color: palette.muted },
  sheet: { backgroundColor: palette.white, borderRadius: 28, overflow: 'hidden' },
  lr: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingVertical: 6, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: palette.hair, marginTop: -1 },
  m: { fontSize: 14, color: palette.muted },
  ct: { flex: 1, borderRadius: 16, backgroundColor: palette.white, paddingTop: 8, paddingHorizontal: 8, paddingBottom: 10, gap: 6 },
  ctOn: { borderWidth: 2, borderColor: palette.ink, paddingTop: 6, paddingHorizontal: 6, paddingBottom: 8 },
  pl: { backgroundColor: palette.white, borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14 },
  plK: { flex: 1, fontSize: 13, lineHeight: 19, color: palette.muted2 },
  plV: { fontSize: 13, lineHeight: 19, fontWeight: '500' },
  bbar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 14, paddingHorizontal: 16 },
  total: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3 },
});
