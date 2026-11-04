/**
 * SCR-26 Фурнитура (Hardware.dc.html): итог по фурнитуре; вкладки «Ручки / Петли и направляющие».
 * Ручки: плитки «Скоба 128/160/192, Кнопка, Gola, Без ручек» с картинкой двери и разницей цены для клиента
 * (текущая — «сейчас · 0»), отделка — плашками металла (без ручек — бледно, «отделка не нужна»).
 * Петли и направляющие: позиции из сметы (цена или «под запрос») и замены по видам, подсветка — переход к зонам.
 * Замена — новая версия модели (отменяется в редакторе). Сотрудник без доступа к себестоимости видит только ↑/↓.
 */
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import { isMasterEstimate, type HardwareGroup, type HardwareOption } from '../../../src/api/types';
import { deltaText } from '../../../src/lib/hardware';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { groupDigits } from '../../../src/lib/format';
import { useOffline } from '../../../src/state/net';
import { useSession } from '../../../src/state/session';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Badge, Banner, Button, EmptyState, Loading, Press, Screen, T, toast } from '../../../src/ui/kit';
import { FitSegmented } from '../../../src/ui/Gradient';
import { palette } from '../../../src/ui/theme';

/** Значок варианта (.hth i): квадрат — кнопка/без ручек, полоска — скоба/профиль. */
const glyph = (v: string): [number, number] => (/gola|profile/.test(v) ? [30, 7] : /bar|скоб/.test(v) ? [28, 6] : /push|none/.test(v) ? [14, 14] : [12, 12]);
/** Цвет металла плашки (макет: градиент — здесь основной тон и блик). */
const FIN: Record<string, [string, string]> = {
  steel: ['#BFC2C4', '#E4E6E7'], black: ['#26272A', '#4A4B4E'], chrome: ['#D2D6D9', '#F7F8F9'], brass: ['#C9A75C', '#EBD493'], gold: ['#D9B44A', '#F4DE93'],
};
const HINGE_ORDER = ['corner_fill', 'lighting', 'hinge', 'hinge_class', 'slides', 'slides_class'];

export default function Hardware() {
  const { id, tab: tab0 } = useLocalSearchParams<{ id: string; tab?: string }>();
  const { t, td, lang } = useT();
  const offline = useOffline();
  const { seesCost } = useSession();
  const { data, error, loading, reload } = useResource(() => api.getHardware(id), [id]);
  const est = useResource(() => api.getEstimate(id).catch(() => null), [id]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'h' | 'k'>(tab0 === 'k' ? 'k' : 'h');
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;

  const lines = isMasterEstimate(est.data) ? est.data.lines.filter((l) => l.category === 'hardware') : [];
  const hwLines = lines.filter((l) => l.group !== 'Подсветка');
  const total = hwLines.filter((l) => l.status !== 'request').reduce((a, l) => a + l.cost, 0);
  const g = (key: string) => data.groups.find((x) => x.key === key) ?? null;
  const handles = g('handles'), finish = g('handle_finish');
  const sel = (grp: HardwareGroup | null) => (grp ? picked[grp.key] ?? grp.options.find((x) => x.current)?.value ?? null : null);
  const hSel = sel(handles);
  const noFin = hSel === 'none' || hSel === 'gola' && !finish;
  const fSel = sel(finish) ?? 'steel';
  const pending = data.groups.flatMap((grp) => {
    const v = picked[grp.key];
    const o = v ? grp.options.find((x) => x.value === v && !x.current) : null;
    // без ручек отделка не нужна (группа пропадёт после замены ручек)
    if (grp.key === 'handle_finish' && hSel === 'none') return [];
    return o ? [{ key: grp.key, o }] : [];
  });
  const sumDelta = pending.reduce((a, p) => a + (p.o.delta ?? 0), 0);
  const warn = pending.find((p) => p.o.note)?.o.note ?? (tab === 'h' ? handles?.options.find((o) => o.value === hSel && !o.current)?.note : undefined);

  const apply = async () => {
    if (!pending.length) return router.back();
    setBusy(true);
    try {
      // ручки — первыми: отделка применяется к новым ручкам
      for (const p of [...pending].sort((a, b) => (a.key === 'handles' ? -1 : b.key === 'handles' ? 1 : 0))) await api.applyHardware(id, p.key, p.o.value);
      setPicked({});
      await reload();
      est.reload();
      toast.show({ text: t('hw_applied'), tone: 'success', action: { label: t('card_open_editor'), onPress: () => router.push(`/project/${id}/editor`) } });
    } catch (e) { showError(e, lang); } finally { setBusy(false); }
  };
  const dl = (o: HardwareOption) => deltaText(o, (v) => groupDigits(v), seesCost);
  const hName = (o: HardwareOption) => td(`hw3_h_${o.value}`, o.label);
  const fName = (v: string) => t(`dc_f_${v as 'brass'}`);
  const pickedH = handles?.options.find((o) => o.value === hSel);
  const ctaTitle = pending.length ? [pickedH ? hName(pickedH) : null, !noFin && finish ? fName(fSel).toLowerCase() : null].filter(Boolean).join(' · ') || t('hw_replace_all') : t('hw_done');

  return (
    <Screen gap={8} contentStyle={{ paddingTop: 4 }}
      footer={<Button title={ctaTitle} value={pending.length && seesCost && sumDelta ? `${sumDelta > 0 ? '+' : '−'}${groupDigits(Math.abs(sumDelta))}` : undefined}
        onPress={apply} loading={busy} disabled={offline && pending.length > 0} />}>
      <Stack.Screen options={{ title: '' }} />
      <View style={s.head}>
        <T style={s.ttl}>{t('hw_title2')}</T>
        {seesCost && total ? <T num style={{ fontSize: 18, lineHeight: 24, fontWeight: '700' }}>{groupDigits(total)} <T style={{ fontSize: 18, fontWeight: '500', color: palette.muted }}>{lang === 'uz' ? 'so‘m' : 'сум'}</T></T> : null}
      </View>
      <FitSegmented value={tab} onChange={(v) => setTab(v)} options={[{ value: 'h', label: t('hw3_tab_handles') }, { value: 'k', label: t('hw3_tab_hinges') }]} />
      {!data.editable ? <Banner tone="est" icon="lock-closed-outline" text={t('hw_locked')} /> : null}

      {tab === 'h' ? (
        handles ? (
          <>
            <T style={s.sh}>{t('hw3_kind')}</T>
            <T v="cap" style={{ paddingHorizontal: 8, marginTop: -4 }}>{t('hw3_kind_note')}</T>
            <View style={s.hg}>
              {handles.options.map((o) => {
                const on = hSel === o.value;
                return (
                  <Press key={o.value} disabled={!o.available || !data.editable || busy} onPress={() => setPicked((p) => ({ ...p, handles: o.value }))}
                    accessibilityRole="radio" accessibilityState={{ selected: on, disabled: !o.available }} accessibilityLabel={hName(o)}
                    style={[s.hc, on && { backgroundColor: palette.ink }, !o.available && { opacity: 0.45 }]}>
                    <HandlePic kind={o.value} fin={noFin && o.value !== 'none' ? 'steel' : fSel} />
                    <T style={[s.nm, on && { color: palette.white }]} numberOfLines={1}>{hName(o)}</T>
                    <T num style={[s.dl, on && { color: palette.chev }]} numberOfLines={1}>{o.current ? t('hw3_now') : !o.available ? t('hw_unavailable') : dl(o)}</T>
                  </Press>
                );
              })}
            </View>
            {finish || hSel === 'none' ? (
              <>
                <T style={s.sh}>{t('hw3_finish')}</T>
                <View style={s.fin}>
                  {(finish?.options ?? (['steel', 'black', 'chrome', 'brass', 'gold'].map((v) => ({ value: v, label: v, current: false, delta: null, available: false, note: '' })) as HardwareOption[])).map((o) => {
                    const on = !noFin && fSel === o.value;
                    return (
                      <Press key={o.value} feedback="opacity" disabled={noFin || !o.available || !data.editable || busy} onPress={() => setPicked((p) => ({ ...p, handle_finish: o.value }))}
                        accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={fName(o.value)} style={[s.fi, noFin && { opacity: 0.35 }]}>
                        <View style={[s.ring, on && s.ringOn]}>
                          <View style={[s.metal, { backgroundColor: (FIN[o.value] ?? FIN.steel)[0] }]}><View style={[s.shine, { backgroundColor: (FIN[o.value] ?? FIN.steel)[1] }]} /></View>
                        </View>
                        <T style={[s.fiT, on && { color: palette.ink, fontWeight: '600' }]} numberOfLines={1}>{fName(o.value)}</T>
                      </Press>
                    );
                  })}
                </View>
              </>
            ) : null}
            {warn && hSel !== 'none' ? <Banner tone="est" icon="warning-outline" text={warn} /> : null}
            {hSel === 'none' ? <T v="cap" style={{ paddingHorizontal: 8 }}>{t('hw3_nofin')}</T> : null}
          </>
        ) : <EmptyState icon="hardware-chip-outline" title={t('hw_empty')} compact />
      ) : (
        <>
          {hwLines.length || data.items.length ? (
            <View style={s.sheet}>
              {hwLines.length ? hwLines.map((l) => (
                <View key={l.key} style={s.row}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T v="rt" numberOfLines={2}>{l.name}</T>
                    <T v="rs">{`${groupDigits(l.qty)} ${l.unit}`}</T>
                  </View>
                  {l.status === 'request' ? <Badge label={t('hw_request')} tone="blue" /> : seesCost ? <T v="rv" num>{groupDigits(l.cost)}</T> : null}
                </View>
              )) : data.items.map((h) => (
                <View key={`${h.kind}-${h.name}`} style={s.row}><View style={{ flex: 1 }}><T v="rt">{h.name}</T><T v="rs">{`${h.qty} шт`}</T></View></View>
              ))}
            </View>
          ) : null}
          <T v="cap" style={{ paddingHorizontal: 8 }}>{t('hw3_hinges_note')}</T>
          {[...data.groups].filter((x) => HINGE_ORDER.includes(x.key)).sort((a, b) => HINGE_ORDER.indexOf(a.key) - HINGE_ORDER.indexOf(b.key)).map((grp) => (
            <View key={grp.key} style={{ gap: 6 }}>
              <T style={s.sh}>{grp.key === 'lighting' ? t('lt_title') : t('hw_replace', { g: grp.title.toLowerCase() })}</T>
              {grp.options.map((o) => {
                const on = sel(grp) === o.value;
                const [w, h] = glyph(o.value);
                const d = o.current ? t('hw_current') : dl(o);
                const dc = on ? palette.white : o.current ? palette.muted : (o.delta ?? 0) < 0 ? palette.greenDeep : palette.ink;
                return (
                  <Press key={o.value} disabled={!o.available || !data.editable || busy} onPress={() => setPicked((p) => ({ ...p, [grp.key]: o.value }))}
                    accessibilityRole="radio" accessibilityState={{ selected: on, disabled: !o.available }} accessibilityLabel={o.label}
                    style={[s.opt, on && { backgroundColor: palette.ink }, !o.available && { opacity: 0.45 }]}>
                    <View style={[s.hth, on && { backgroundColor: '#3A3938' }]}><View style={{ width: w, height: h, borderRadius: 3, backgroundColor: on ? palette.wood : palette.ink }} /></View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T style={{ fontSize: 16, lineHeight: 21, fontWeight: '600', color: on ? palette.white : palette.ink }} numberOfLines={1}>{o.label}</T>
                      {o.note || !o.available ? <T style={{ fontSize: 14, lineHeight: 19, color: on ? palette.chev : palette.muted, marginTop: 2 }} numberOfLines={1}>{!o.available ? t('hw_unavailable') : o.note}</T> : null}
                    </View>
                    <T num style={{ fontSize: 16, fontWeight: '600', color: dc }}>{d}</T>
                  </Press>
                );
              })}
              {grp.key === 'lighting' ? <Button v="ghost" title={t('hw2_light_more')} iconRight="chevron-forward" onPress={() => router.push(`/project/${id}/lighting`)} style={{ alignSelf: 'flex-start' }} /> : null}
            </View>
          ))}
          {warn ? <Banner tone="est" icon="warning-outline" text={warn} /> : null}
        </>
      )}
    </Screen>
  );
}

/** Картинка плитки (.hc .pic): дверь в «дереве», ручка нужного вида и цвета. */
function HandlePic({ kind, fin }: { kind: string; fin: string }) {
  const c = (FIN[fin] ?? FIN.steel)[0];
  const bar = /^bar_(\d+)/.exec(kind);
  const h = bar ? ({ 128: 30, 160: 38, 192: 44 } as Record<string, number>)[bar[1]] ?? 34 : 0;
  const top = bar ? ({ 128: 18, 160: 14, 192: 11 } as Record<string, number>)[bar[1]] ?? 14 : 0;
  return (
    <View style={s.pic}>
      <View style={s.door}>
        {Array.from({ length: 12 }, (_, i) => <View key={i} style={{ position: 'absolute', left: 7 + i * 9, top: 0, bottom: 0, width: 2, backgroundColor: '#DCC59F' }} />)}
      </View>
      {bar ? <View style={[s.h, { left: '68%', top, width: 5, height: h, borderRadius: 3, backgroundColor: c }]} /> : null}
      {kind === 'knob' ? <View style={[s.h, { left: '70%', top: 30, width: 10, height: 10, borderRadius: 5, backgroundColor: c }]} /> : null}
      {kind === 'gola' ? <View style={{ position: 'absolute', left: 14, right: 14, top: 8, height: 6, backgroundColor: palette.ink }} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingRight: 8 },
  ttl: { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.75, paddingHorizontal: 8 },
  sh: { fontSize: 19, lineHeight: 24, fontWeight: '700', letterSpacing: -0.3, paddingTop: 4, paddingHorizontal: 8 },
  hg: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hc: { width: '31.6%', flexGrow: 1, backgroundColor: palette.white, borderRadius: 20, paddingTop: 8, paddingHorizontal: 8, paddingBottom: 10, gap: 6 },
  pic: { height: 62, borderRadius: 14, backgroundColor: palette.wood, overflow: 'hidden' },
  door: { position: 'absolute', left: 14, right: 14, top: 8, bottom: 0, backgroundColor: '#E6D3B1', borderWidth: 2, borderBottomWidth: 0, borderColor: palette.ink, borderTopLeftRadius: 3, borderTopRightRadius: 3, overflow: 'hidden' },
  h: { position: 'absolute', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } },
  nm: { fontSize: 14, lineHeight: 18, fontWeight: '600', paddingHorizontal: 2 },
  dl: { fontSize: 13, lineHeight: 16, color: palette.muted, paddingHorizontal: 2 },
  fin: { flexDirection: 'row', gap: 10, backgroundColor: palette.white, borderRadius: 22, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 10, justifyContent: 'space-between' },
  fi: { flex: 1, alignItems: 'center', gap: 5 },
  ring: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', margin: -5, borderWidth: 2, borderColor: 'transparent' },
  ringOn: { borderColor: palette.ink },
  metal: { width: 38, height: 38, borderRadius: 19, overflow: 'hidden' },
  shine: { position: 'absolute', left: 7, top: 5, width: 14, height: 9, borderRadius: 7, opacity: 0.45 },
  fiT: { fontSize: 13, lineHeight: 16, color: palette.muted },
  sheet: { backgroundColor: palette.white, borderRadius: 28, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingVertical: 8, paddingHorizontal: 20, borderTopWidth: 1, borderTopColor: palette.hair, marginTop: -1 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 62, paddingVertical: 8, paddingLeft: 10, paddingRight: 18, borderRadius: 20, backgroundColor: palette.white },
  hth: { width: 44, height: 44, borderRadius: 14, backgroundColor: palette.wood, alignItems: 'center', justifyContent: 'center' },
});
