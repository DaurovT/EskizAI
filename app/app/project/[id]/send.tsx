/**
 * SCR-12 Отправка клиенту (Send.dc.html): вид сметы (итог / короткая / подробная), карточка «как увидит клиент»
 * (GET …/estimate/client?view=), язык и срок ссылки; «Отправить в Telegram» (deep link), «Копировать», «КП в PDF».
 */
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import { uncertaintyText, type EstimateView, type Lang, type ShareLinkOut } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { translate, useT } from '../../../src/i18n';
import { shareToTelegram } from '../../../src/lib/contact';
import { formatRange, noCurrency, plural } from '../../../src/lib/format';
import { syncPushToken } from '../../../src/services/push';
import { useSession } from '../../../src/state/session';
import { useOffline } from '../../../src/state/net';
import { showError } from '../../../src/ui/dialogs';
import { Carcass } from '../../../src/ui/Illus';
import { Badge, Banner, Button, ButtonRow, Card, Loading, Press, Screen, Segmented, T, Tile } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

const VIEWS: EstimateView[] = ['total', 'short', 'detailed'];
const DAYS = [7, 30, 90];

export default function Send() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useT();
  const { workshop, isOwner } = useSession();
  const offline = useOffline();
  const card = useResource(() => api.getProject(id), [id]);
  const allowed = isOwner ? VIEWS : workshop?.employee_estimate_views ?? ['total'];
  const [view, setView] = useState<EstimateView>(workshop?.default_estimate_view ?? 'short');
  const showPrice = true;
  const [linkLang, setLinkLang] = useState<Lang>(lang);
  const [days, setDays] = useState(30);
  const [link, setLink] = useState<ShareLinkOut | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useResource(() => api.getClientEstimate(id, view), [id, view]);
  useEffect(() => { if (!allowed.includes(view)) setView(allowed[0]); }, [allowed, view]);

  const ensureLink = async (): Promise<ShareLinkOut | null> => {
    if (link && link.estimate_view === view && link.show_price === showPrice && link.language === linkLang) return link;
    setBusy(true);
    try {
      const l = await api.createShareLink(id, { language: linkLang, estimate_view: view, show_price: showPrice, expires_in_days: days });
      setLink(l);
      card.reload();
      syncPushToken(true).catch(() => undefined); // момент ценности: «клиент открыл ссылку» придёт push-ом
      return l;
    } catch (e) {
      showError(e, lang);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const telegram = async () => {
    const l = await ensureLink();
    if (l) shareToTelegram(l.url, translate(linkLang, 'send_message', { url: l.url }));
  };
  const copy = async () => {
    const l = await ensureLink();
    if (l) { await Clipboard.setStringAsync(l.url); Alert.alert(t('copied'), l.url); }
  };

  if (card.loading && !card.data) return <Loading />;
  const p = card.data;
  const e = preview.data;
  const tl = (k: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(linkLang, k, params);
  const groupName = (g: { name: string; name_uz?: string }) => (linkLang === 'uz' && g.name_uz ? g.name_uz : g.name);
  const amount = (r: { from: number; to: number }) => noCurrency(formatRange(r, linkLang));
  const total = e ? formatRange(e.total, linkLang) : '';
  const totalNum = noCurrency(total);
  const totalCur = total.slice(totalNum.length).trim();

  return (
    <Screen gap={10} contentStyle={{ paddingTop: 4 }} footer={
      <>
        <Button icon="paper-plane-outline" title={t('send_telegram')} onPress={telegram} loading={busy} disabled={offline} />
        <ButtonRow>
          <Button v="secondary" icon="link-outline" title={t('send_copy')} onPress={copy} disabled={offline || busy} style={{ flex: 1 }} textStyle={{ fontSize: 16 }} />
          <Button v="secondary" icon="document-outline" title={t('send_kp')} style={{ flex: 1 }} textStyle={{ fontSize: 16 }}
            onPress={() => router.push({ pathname: '/project/[id]/file/[kind]', params: { id, kind: 'offer_pdf', title: t('send_kp') } })} />
        </ButtonRow>
      </>
    } footerStyle={{ paddingTop: 6 }}>
      <Stack.Screen options={{ title: '' }} />
      <T v="big" style={st.h1}>{t('send_h1')}</T>
      {e?.has_stale ? (
        <Banner tone="est" icon="time-outline" title={t('send_stale')} text={t('send_stale_hint')}
          action={{ label: t('send_stale_action'), onPress: () => router.push(`/project/${id}/estimate`) }} />
      ) : null}
      <T v="h3" style={st.hd}>{t('send_view')}</T>
      <Segmented value={view} onChange={setView} options={allowed.map((v) => ({ value: v, label: t(`view_${v}`) }))} />
      {!isOwner ? <T v="cap" style={{ paddingHorizontal: 8 }}>{t('send_employee_views')}</T> : null}

      {/* как увидит клиент */}
      <Card padded={false}>
        <View style={st.prev}>
          <Carcass w={80} h={68} r={26} b={3} />
          <View style={st.pill}>
            <Ionicons name="eye-outline" size={16} color={palette.ink} />
            <T style={st.pillT}>{t('send_as_client')}</T>
          </View>
        </View>
        <View style={{ paddingTop: 12, paddingHorizontal: 20, paddingBottom: 16 }}>
          <View style={st.titleRow}>
            <T v="rt" style={{ fontWeight: '600', flex: 1 }} numberOfLines={1}>{p?.title}</T>
            <Badge tone="blue" label={tl('send_3d')} />
          </View>
          {preview.loading && !e ? <Loading /> : e ? (
            <>
              {view === 'short' && e.materials ? <Line k={tl('send_materials')} v={amount(e.materials)} /> : null}
              {view === 'detailed' ? (e.groups ?? []).map((g) => <Line key={g.key ?? g.name} k={groupName(g)} v={amount(g)} />) : null}
              {view !== 'total' && e.work ? <Line k={tl('est_work')} v={amount(e.work)} /> : null}
              {(e.requests ?? []).map((r) => <T key={r.name} v="cap" color={palette.amberDeep} style={{ paddingVertical: 2 }}>{tl('send_requests', { name: r.name })}</T>)}
              <View style={[st.pl, st.tot, view === 'total' && { marginTop: 0, borderTopWidth: 0 }]}>
                <T style={{ fontSize: 16, lineHeight: 21, fontWeight: '600' }}>{tl('send_total')}</T>
                <T num style={st.totV} numberOfLines={1}>{totalNum}{totalCur ? <T style={st.cur}>{` ${totalCur}`}</T> : null}</T>
              </View>
            </>
          ) : <T v="rs">{t('est_unavailable')}</T>}
        </View>
      </Card>
      {/* только мастеру, вне превью клиента: чем объясняется диапазон до замера */}
      {e && !e.exact && uncertaintyText(e, lang) ? <T v="cap" color={palette.amberDeep} style={{ paddingHorizontal: 8, marginTop: -2 }}>{`${t('ed_before_measure')} · ${uncertaintyText(e, lang)}`}</T> : null}

      {/* язык и срок ссылки */}
      <Card padded={false}>
        <View style={st.row}>
          <Tile icon="globe-outline" style={st.tile} />
          <T v="rt" style={{ flex: 1 }}>{t('send_language')}</T>
          <View style={st.lang2} accessibilityRole="radiogroup">
            {(['ru', 'uz'] as Lang[]).map((l) => (
              <Press key={l} feedback="opacity" onPress={() => setLinkLang(l)} accessibilityRole="radio" accessibilityState={{ selected: linkLang === l }}
                style={[st.lang2i, linkLang === l && { backgroundColor: palette.ink }]}>
                <T style={[st.lang2t, linkLang === l && { color: palette.white }]}>{l === 'ru' ? 'Рус' : 'O‘zb'}</T>
              </Press>
            ))}
          </View>
        </View>
        <Press feedback="row" onPress={() => setDays(DAYS[(DAYS.indexOf(days) + 1) % DAYS.length])} accessibilityRole="button" style={[st.row, st.sep]}>
          <Tile icon="time-outline" style={st.tile} />
          <T v="rt" style={{ flex: 1 }}>{t('send_valid')}</T>
          <T v="rv" style={{ fontWeight: '500' }}>{`${days} ${plural(days, t('send_days_n'))}`}</T>
        </Press>
      </Card>
    </Screen>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <View style={st.pl}>
      <T style={st.plK} numberOfLines={1}>{k}</T>
      <T num style={st.plV}>{v}</T>
    </View>
  );
}

const st = StyleSheet.create({
  h1: { lineHeight: 34, letterSpacing: -0.6, paddingHorizontal: 8, paddingTop: 2, marginBottom: -2 },
  hd: { marginTop: 4, paddingHorizontal: 8, letterSpacing: -0.18 },
  prev: { height: 104, backgroundColor: palette.wood, flexDirection: 'row', alignItems: 'center', paddingLeft: 36 },
  pill: { position: 'absolute', right: 12, bottom: 12, height: 36, borderRadius: 18, backgroundColor: palette.white, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 },
  pillT: { fontSize: 14, lineHeight: 19, fontWeight: '500' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 },
  pl: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, paddingVertical: 4 },
  plK: { flex: 1, fontSize: 15, lineHeight: 21 },
  plV: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  tot: { paddingTop: 10, marginTop: 6, borderTopWidth: 1, borderTopColor: palette.hair },
  totV: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3 },
  cur: { fontSize: 15, fontWeight: '500', color: palette.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingVertical: 8, paddingHorizontal: 20 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  tile: { width: 40, height: 40 },
  lang2: { flexDirection: 'row', backgroundColor: palette.segOnWhite, borderRadius: 20, padding: 3, gap: 2 },
  lang2i: { height: 34, minWidth: 48, borderRadius: 17, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  lang2t: { fontSize: 14, lineHeight: 19, fontWeight: '500' },
});
