/**
 * SCR-13b Замер кухни (MeasureKitchen.dc.html): вкладки «Стены и окно» и «Коммуникации», план угла со стенами, окном
 * и выводами, плитки размеров (расхождение со шкафами — красным, изменённый потолок — янтарным). Расстояния — мм от угла
 * (у прямой кухни — от левого края стены). Сервер подгоняет ряды под стены, ставит мойку к воде и варку к газу,
 * убирает верхние модули с окна. Без сети замер уходит в очередь, как обычный (NFR-07).
 */
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { api } from '../api';
import type { KitchenSite, KitchenUtility, KitchenWall, MeasurementOut, ProductTree, ProjectCardOut, UtilityKind } from '../api/types';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/ru';
import { formatDate } from '../lib/format';
import { UTILITY_KINDS, cleanSite, initialSite, isCornerKitchen, newUtility, wallDiffs } from '../lib/kitchenMeasure';
import { updateMeta } from '../state/projectMeta';
import { showError } from '../ui/dialogs';
import { MeasureField } from '../ui/MeasureField';
import { Badge, Banner, Button, Card, Chip, ChipRow, Field, Press, Screen, Segmented, Sheet, T } from '../ui/kit';
import { palette } from '../ui/theme';

const KIND_LABEL: Record<UtilityKind, DictKey> = {
  water: 'mk_u_water', sewer: 'mk_u_sewer', gas: 'mk_u_gas', socket: 'mk_u_socket', vent: 'mk_u_vent',
};
/** Метка вывода на плане и в списке (.mk): буква и цвет. */
const MARK: Record<UtilityKind, { l: string; l_uz: string; c: string }> = {
  water: { l: 'В', l_uz: 'S', c: '#1F4FBF' }, sewer: { l: 'К', l_uz: 'K', c: '#55524D' }, gas: { l: 'Г', l_uz: 'G', c: '#E08A00' },
  socket: { l: 'Р', l_uz: 'R', c: '#387D50' }, vent: { l: 'ВК', l_uz: 'V', c: '#8E8B85' },
};
const ROWS = ['/base', '/base2', '/wall', '/wall2', '/wall_height'];

export function MeasureKitchen({ id, tree, card, offline, history, pending, initialTab = 'walls' }: {
  id: string; tree: ProductTree; card?: ProjectCardOut | null; offline: boolean; history: MeasurementOut[]; pending: number; initialTab?: 'walls' | 'utils';
}) {
  const { t, lang } = useT();
  const corner = isCornerKitchen(tree);
  const [tab, setTab] = useState<'walls' | 'utils'>(initialTab);
  const [site, setSite] = useState<KitchenSite>(() => initialSite(tree));
  const [start] = useState<KitchenSite>(() => initialSite(tree));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<number | null>(null);

  const patch = (p: Partial<KitchenSite>) => setSite((s) => ({ ...s, ...p }));
  const setUtil = (i: number, p: Partial<KitchenUtility>) =>
    setSite((s) => ({ ...s, utilities: s.utilities.map((u, k) => (k === i ? { ...u, ...p } : u)) }));
  const removeUtil = (i: number) => { setEdit(null); setSite((s) => ({ ...s, utilities: s.utilities.filter((_, k) => k !== i) })); };
  const addUtil = (kind: UtilityKind) => { setSite((s) => ({ ...s, utilities: [...s.utilities, newUtility(kind)] })); setEdit(site.utilities.length); };
  const wallOpts: { value: KitchenWall; label: string }[] = [{ value: 'a', label: t('mk_wall_a') }, { value: 'b', label: t('mk_wall_b') }];
  const letter = (w: KitchenWall) => t(w === 'a' ? 'mk_wall_letter_a' : 'mk_wall_letter_b');
  const fromLabel = corner ? t('mk_from_corner') : t('mk_from_left');
  const diffs = wallDiffs(tree, site);
  const diffOf = (w: KitchenWall) => diffs.find((d) => d.wall === w)?.diff ?? 0;
  const sign = (n: number) => (n > 0 ? `+${Math.round(n)}` : `−${Math.round(Math.abs(n))}`);
  const clientName = card?.client?.name?.split(' ')[0];

  const fix = async () => {
    setBusy(true);
    try {
      const m = await api.addMeasurement(id, { kitchen: cleanSite(site, corner), notes: notes.trim() || null, data: {}, apply_to_model: !offline });
      const queued = m.id.startsWith('pending-');
      let message = queued ? t('ms_queued') : t('ms_saved');
      if (!queued) {
        updateMeta(id, (mm) => ({ estimated: mm.estimated.filter((p) => !ROWS.some((r) => p === r || p.startsWith(`${r}/`))) }));
        if (m.applied_version_id) message = `${message}\n${t('ms_applied')}`;
        else if (m.apply_error) message = `${message}\n${t('ms_apply_error', { e: m.apply_error })}`;
        if (m.apply_notes?.length) message = `${message}\n\n${t('mk_done')}\n• ${m.apply_notes.join('\n• ')}`;
      }
      Alert.alert(message);
      router.back();
    } catch (e) {
      showError(e, lang);
    } finally {
      setBusy(false);
    }
  };

  const mark = (k: UtilityKind) => (lang === 'uz' ? MARK[k].l_uz : MARK[k].l);
  const eu = edit != null ? site.utilities[edit] : null;

  return (
    <Screen gap={10} contentStyle={{ paddingTop: 2 }} footerStyle={{ paddingTop: 6, gap: 2 }} footer={
      <>
        <Button title={t('mk_fix')} onPress={fix} loading={busy} disabled={!site.wall_a} />
        {/* MeasureKitchen.dc.html: ссылка на встройку кухни (SCR-50b) */}
        <Button v="ghost" title={t('mk2_builtin')} onPress={() => router.push(`/project/${id}/builtin`)} style={{ minHeight: 36 }} />
      </>
    }>
      <Stack.Screen options={{
        title: '',
        headerRight: card?.client_agreed_at && clientName ? () => (
          <Badge tone="green" label={t('mk_agreed', { name: clientName })} style={st.agreed} />
        ) : undefined,
      }} />
      <T v="big" style={st.h1}>{t('mk_title')}</T>
      <Segmented value={tab} onChange={setTab} options={[{ value: 'walls', label: t('mk_tab_walls') }, { value: 'utils', label: t('mk_tab_utils') }]} />
      <Plan site={site} corner={corner} showUtils={tab === 'utils'} letter={letter} mark={mark} windowLabel={(n) => t('mk_window', { n })} />

      {tab === 'walls' ? (
        <>
          <View style={st.g2}>
            <MeasureField size="m" label={corner ? t('mk_wall_a') : t('mk_wall_straight')} value={site.wall_a} unit={t('mm')} min={300} max={20000}
              onChange={(v) => patch({ wall_a: v ?? site.wall_a })} state={diffOf('a') ? 'err' : null}
              badge={diffOf('a') ? { label: sign(diffOf('a')), tone: 'red' } : null} style={st.cell} />
            {corner ? (
              <MeasureField size="m" label={t('mk_wall_b')} value={site.wall_b ?? null} unit={t('mm')} min={300} max={20000}
                onChange={(v) => patch({ wall_b: v })} state={diffOf('b') ? 'err' : null}
                badge={diffOf('b') ? { label: sign(diffOf('b')), tone: 'red' } : null} style={st.cell} />
            ) : null}
            <MeasureField size="m" label={t('mk_ceiling')} value={site.ceiling ?? null} unit={t('mm')} min={1800} max={5000} nullable
              onChange={(v) => patch({ ceiling: v })}
              state={start.ceiling && site.ceiling && start.ceiling !== site.ceiling ? 'est' : null}
              badge={start.ceiling && site.ceiling && start.ceiling !== site.ceiling ? { label: t('mk_was', { n: start.ceiling }), tone: 'amber' } : null} style={st.cell} />
            {site.window ? (
              <>
                <MeasureField size="m" label={corner ? t('mk_window_from') : t('mk_window_from_straight')} value={site.window.from_corner} unit={t('mm')} min={0} max={20000}
                  onChange={(v) => patch({ window: { ...site.window!, from_corner: v ?? 0 } })} style={st.cell} />
                <MeasureField size="m" label={t('mk_window_width')} value={site.window.width} unit={t('mm')} min={100} max={5000}
                  onChange={(v) => patch({ window: { ...site.window!, width: v ?? site.window!.width } })} style={st.cell} />
                <MeasureField size="m" label={t('mk_sill')} value={site.window.sill} unit={t('mm')} min={0} max={3000}
                  onChange={(v) => patch({ window: { ...site.window!, sill: v ?? site.window!.sill } })} style={st.cell} />
              </>
            ) : (
              <Press onPress={() => patch({ window: { wall: 'a', from_corner: 1000, width: 1200, sill: 900 } })} accessibilityRole="button" style={[st.cell, st.addWin]}>
                <T v="rt" color={palette.greenPress}>{`+ ${t('mk_window_add')}`}</T>
              </Press>
            )}
          </View>
          {diffs.map(({ wall, diff }) => (
            <Banner key={wall} tone="err" textStyle={BAN15} icon="warning-outline" style={{ alignItems: "flex-start" }} text={t(diff < 0 ? 'mk_diff_short' : 'mk_diff_long', { w: letter(wall), n: Math.round(Math.abs(diff)) })} />
          ))}
          {site.window ? (
            <View style={st.winRow}>
              {corner ? <Segmented value={site.window.wall} options={wallOpts} onChange={(w) => patch({ window: { ...site.window!, wall: w } })} style={{ flex: 1 }} /> : <View style={{ flex: 1 }} />}
              <Button v="ghost" small title={t('mk_no_window')} onPress={() => patch({ window: null })} />
            </View>
          ) : null}
          <Field label={t('ms_notes_shop')} value={notes} onChangeText={setNotes} multiline multilineMinHeight={68} style={{ fontSize: 16 }} />
        </>
      ) : (
        <>
          {site.utilities.length ? (
            <Card padded={false}>
              {site.utilities.map((u, i) => (
                <Press key={i} feedback="row" onPress={() => setEdit(i)} accessibilityRole="button" style={[st.ur, i > 0 && st.sep]}>
                  <View style={[st.mk, { backgroundColor: MARK[u.kind].c }]}><T style={[st.mkT, mark(u.kind).length > 1 && { fontSize: 11 }]}>{mark(u.kind)}</T></View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T v="rt" numberOfLines={1}>{t(KIND_LABEL[u.kind])}</T>
                    <T v="rs" numberOfLines={1}>
                      {u.kind === 'vent' && u.size ? `${t('mk_wall_only', { w: letter(u.wall) })} · ${u.size}`
                        : u.height != null ? t('mk_wall_h', { w: letter(u.wall), h: u.height }) : t('mk_wall_only', { w: letter(u.wall) })}
                    </T>
                  </View>
                  <T num style={st.pv}>{u.from_corner}{i === 0 ? <T v="rs">{` ${t('mk_from_short')}`}</T> : null}</T>
                </Press>
              ))}
            </Card>
          ) : <T v="sub" style={{ paddingHorizontal: 8 }}>{t('mk_empty')}</T>}
          <ChipRow>{UTILITY_KINDS.map((k) => <Chip key={k} icon="add" label={t(KIND_LABEL[k])} onPress={() => addUtil(k)} />)}</ChipRow>
          <T v="cap" style={{ paddingHorizontal: 8 }}>{corner ? t('mk_hint') : t('mk_hint_straight')}</T>
        </>
      )}

      {offline ? <Banner tone="est" textStyle={BAN15} icon="cloud-offline-outline" text={t('ms_queued')} /> : null}
      {pending ? <T v="cap" color={palette.amberDeep} style={{ paddingHorizontal: 8 }}>{t('ms_pending', { n: pending })}</T> : null}
      {history.length ? (
        <Card>
          <T v="lbl">{t('ms_history')}</T>
          {history.map((m) => {
            const k = m.kitchen;
            const dims = k ? `${t('mk_wall_letter_a')} ${k.wall_a}${k.wall_b ? ` · ${t('mk_wall_letter_b')} ${k.wall_b}` : ''}` : `${m.width ?? '—'}`;
            return <T key={m.id} v="rs" num style={{ marginTop: 4 }}>{formatDate(m.created_at, lang)}: {dims}{m.notes ? ` · ${m.notes}` : ''}</T>;
          })}
        </Card>
      ) : null}

      <Sheet visible={eu != null} onClose={() => setEdit(null)} title={eu ? t(KIND_LABEL[eu.kind]) : t('mk_edit')}
        footer={<Button title={t('mk_done_btn')} onPress={() => setEdit(null)} />}>
        {eu && edit != null ? (
          <>
            {corner ? <Segmented value={eu.wall} options={wallOpts} onChange={(w) => setUtil(edit, { wall: w })} /> : null}
            <View style={st.g2}>
              <MeasureField size="m" label={fromLabel} value={eu.from_corner} unit={t('mm')} min={0} max={20000} onChange={(v) => setUtil(edit, { from_corner: v ?? 0 })} style={st.cell} />
              <MeasureField size="m" label={t('mk_height')} value={eu.height ?? null} unit={t('mm')} min={0} max={4000} nullable onChange={(v) => setUtil(edit, { height: v })} style={st.cell} />
            </View>
            {eu.kind === 'vent' ? <Field label={t('mk_size')} value={eu.size ?? ''} onChangeText={(s) => setUtil(edit, { size: s.slice(0, 40) || null })} /> : null}
            <Button v="ghostDanger" title={t('mk_remove')} onPress={() => removeUtil(edit)} />
          </>
        ) : null}
      </Sheet>
    </Screen>
  );
}

/** План (.plan): стена А по верху, стена Б слева (угловая), окно голубым, выводы кружками на вкладке «Коммуникации». */
function Plan({ site, corner, showUtils, letter, mark, windowLabel }: {
  site: KitchenSite; corner: boolean; showUtils: boolean; letter: (w: KitchenWall) => string; mark: (k: UtilityKind) => string; windowLabel: (n: number) => string;
}) {
  const X = 40, Y = 34, LA = 300, LB = 118;
  const ka = LA / Math.max(1, site.wall_a);
  const kb = LB / Math.max(1, site.wall_b ?? 1);
  const win = site.window;
  // позиция вдоль стены → точка на плане (чуть внутрь комнаты)
  const at = (wall: KitchenWall, mm: number, i: number) => (wall === 'a' || !corner
    ? { left: X + Math.min(LA, mm * ka) - 12, top: Y + 12 + (i % 2) * 26 }
    : { left: X + 12 + (i % 2) * 26, top: Y + Math.min(LB, mm * kb) - 12 });
  return (
    <View style={st.plan} accessibilityRole="image">
      <View style={[st.w, { left: X, top: Y, width: LA, height: 6 }]} />
      {corner ? <View style={[st.w, { left: X, top: Y, width: 6, height: LB }]} /> : null}
      {win ? (
        win.wall === 'a' || !corner
          ? <View style={[st.win, { left: X + win.from_corner * ka, top: Y - 3, width: Math.max(8, win.width * ka), height: 12 }]} />
          : <View style={[st.win, { left: X - 3, top: Y + win.from_corner * kb, width: 12, height: Math.max(8, win.width * kb) }]} />
      ) : null}
      <T num style={[st.lab, { left: 96, top: 12 }]}>{`${letter('a')} ${site.wall_a}`}</T>
      {corner && site.wall_b ? <T num style={[st.lab, { left: 52, top: 132 }]}>{`${letter('b')} ${site.wall_b}`}</T> : null}
      {win ? <T num style={[st.lab, { left: 232, top: 12, color: palette.muted2, fontWeight: '500' }]}>{windowLabel(win.width)}</T> : null}
      {showUtils ? site.utilities.map((u, i) => (
        <View key={i} style={[st.pmk, at(u.wall, u.from_corner, i), { backgroundColor: MARK[u.kind].c }]}>
          <T style={[st.mkT, mark(u.kind).length > 1 && { fontSize: 11 }]}>{mark(u.kind)}</T>
        </View>
      )) : null}
    </View>
  );
}

const BAN15 = { fontSize: 15, lineHeight: 20 };
const st = StyleSheet.create({
  h1: { lineHeight: 34, letterSpacing: -0.6, paddingHorizontal: 8, paddingTop: 2, marginBottom: -2 },
  agreed: { height: 32, borderRadius: 16, paddingHorizontal: 12 },
  g2: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { flexGrow: 1, flexBasis: '45%' },
  addWin: { minHeight: 76, borderRadius: 20, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
  winRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  plan: { height: 168, borderRadius: 24, backgroundColor: palette.white, overflow: 'hidden' },
  w: { position: 'absolute', backgroundColor: palette.ink, borderRadius: 3 },
  win: { position: 'absolute', backgroundColor: '#8FB5E8', borderRadius: 2 },
  lab: { position: 'absolute', fontSize: 13, lineHeight: 16, fontWeight: '600', color: palette.blue },
  pmk: { position: 'absolute', width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: palette.white },
  mk: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  mkT: { fontSize: 12, lineHeight: 15, fontWeight: '700', color: palette.white },
  ur: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 16 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  pv: { fontSize: 15, lineHeight: 20, fontWeight: '600', textAlign: 'right' },
});
