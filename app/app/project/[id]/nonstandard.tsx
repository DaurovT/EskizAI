/**
 * SCR-19 Нестандарт (Nonstandard.dc.html): фото клиента и ближайший вариант, отличия из разбора ИИ, «что важно клиенту»
 * → конструкторам EMAN или купить файлы и доработать самому.
 * SCR-34 Заявка (NonstandardStatus.dc.html): шаги отправлена → оценена → в работе → готово, оценка конструктора,
 * «Принять цену и срок», доработанные файлы.
 */
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import type { NonstandardOut, NonstandardStatus } from '../../../src/api/types';
import { SUPPORT_TG } from '../../../src/config';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatDayTime, formatMoney, plural } from '../../../src/lib/format';
import { mimeOf, utiOf } from '../../../src/lib/files';
import { useMeta } from '../../../src/state/projectMeta';
import { confirm, showError } from '../../../src/ui/dialogs';
import { Carcass } from '../../../src/ui/Illus';
import { Banner, Button, ButtonRow, Card, Field, ListItem, Loading, Press, Screen, T } from '../../../src/ui/kit';
import { palette, tones } from '../../../src/ui/theme';

export default function Nonstandard() {
  const { id, request, devStatus } = useLocalSearchParams<{ id: string; request?: string; devStatus?: NonstandardStatus | 'form' }>();
  const { t, lang } = useT();
  const meta = useMeta(id);
  const list = useResource(() => api.listNonstandard(id), [id]);
  const card = useResource(() => api.getProject(id), [id]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState(false);

  let requests = list.data ?? [];
  // dev: заявка в нужном статусе для сверки с макетом (?devStatus=estimated)
  if (__DEV__ && devStatus && devStatus !== 'form' && !requests.length) requests = [devRequest(id, devStatus)];
  const current = requests.find((r) => r.id === request) ?? requests.find((r) => r.status !== 'cancelled');
  let differences = meta.design?.differences ?? [];
  if (__DEV__ && devStatus === 'form' && !differences.length) differences = ['радиусный торец R300', 'фрезерованные фасады', 'ниша под ТВ'];

  const send = async (path: 'eman' | 'self') => {
    if (text.trim().length < 3) return Alert.alert(t('ns_required'));
    setBusy(path);
    try {
      const photos = (card.data?.photos ?? []).filter((p) => p.kind === 'source').map((p) => p.id);
      await api.sendNonstandard(id, { description: text.trim(), photo_ids: photos, differences: differences.length ? differences : null, path });
      setText('');
      setForm(false);
      Alert.alert(path === 'eman' ? t('ns_sent') : t('ns_sent_self'));
      if (path === 'self') router.push(`/project/${id}/files`);
      list.reload();
    } catch (e) { showError(e, lang); } finally { setBusy(null); }
  };

  const accept = async (r: NonstandardOut) => {
    if (!(await confirm(t('ns_accept'), t('ns_accept_confirm', { price: formatMoney(r.price ?? 0, lang), n: r.lead_days ?? '—' }), t('ns_accept'), t('cancel')))) return;
    setBusy(r.id);
    try { await api.acceptNonstandard(id, r.id); Alert.alert(t('ns_accepted')); list.reload(); } catch (e) { showError(e, lang); } finally { setBusy(null); }
  };

  const openFile = async (f: NonstandardOut['files'][number]) => {
    try {
      const file = await api.downloadNonstandardFile(id, f);
      const mime = mimeOf(file.mimeType, file.name);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: file.name, UTI: utiOf(mime) });
    } catch (e) { showError(e, lang); }
  };

  if (list.loading && !list.data) return <Loading />;

  // ---------- SCR-34: заявка ----------
  if (current && !form && current.path === 'eman') {
    const r = current;
    const steps = r.steps.length ? r.steps : [];
    const cur = Math.max(0, steps.map((s) => s.done).lastIndexOf(true));
    const p = card.data;
    const cta = r.status === 'sent' ? { title: t('ns_wait_quote'), off: true }
      : r.status === 'estimated' ? { title: t('ns_accept_both'), off: !r.can_accept, on: () => accept(r) }
        : r.status === 'in_work' ? { title: t('ns_wait_done'), off: true }
          : { title: t('ns_open_done'), off: false, on: () => router.push(`/project/${id}/editor`) };
    return (
      <Screen gap={8} contentStyle={{ paddingTop: 12 }} footer={
        <>
          <Button title={cta.title} disabled={cta.off} onPress={cta.on} loading={busy === r.id} />
          <ButtonRow>
            <Button v="secondary" title={t('ns_open_project')} onPress={() => router.push(`/project/${id}`)} style={st.softSm} textStyle={{ fontSize: 15 }} numberOfLines={1} />
            <Button v="secondary" title={t('ns_write')} onPress={() => Linking.openURL(`https://t.me/${SUPPORT_TG}`)} style={st.softSm} textStyle={{ fontSize: 15 }} numberOfLines={1} />
          </ButtonRow>
        </>
      }>
        <Stack.Screen options={{ title: '' }} />
        <View style={st.head}>
          <T v="bigPush">{t('ns_status_h1')}</T>
          {p ? <T v="sub" style={{ marginTop: 4, fontSize: 15 }} numberOfLines={1}>{[p.title, p.client?.name].filter(Boolean).join(' · ')}</T> : null}
        </View>
        <Card style={{ paddingBottom: 4, paddingVertical: 20, paddingHorizontal: 20 }}>
          {steps.map((s, i) => {
            const last = i === steps.length - 1;
            return (
              <View key={s.status} style={st.tl}>
                <View style={st.rail}>
                  <View style={[st.c, i < cur ? st.cDone : i === cur ? st.cCur : st.cTodo]} />
                  <View style={[st.ln, { backgroundColor: last ? 'transparent' : i < cur ? palette.green : palette.off }]} />
                </View>
                <View style={{ flex: 1, paddingBottom: 12 }}>
                  <T v="rt" color={i <= cur ? palette.ink : palette.muted}>{t(`nss_${s.status}` as 'nss_sent')}</T>
                  <T v="rs">{s.status === 'sent' ? formatDayTime(r.created_at, lang) : t(`ns_st_${s.status}_d` as 'ns_st_sent_d')}</T>
                </View>
              </View>
            );
          })}
        </Card>
        {r.price != null && r.status !== 'done' ? (
          <Card style={{ gap: 10, padding: 20 }}>
            <T v="h3">{t('ns_quote')}</T>
            <View style={st.kv}><T v="rs" style={{ fontSize: 16 }}>{t('ns_quote_price')}</T><T v="rv" num>{formatMoney(r.price, lang)}</T></View>
            {r.lead_days != null ? (
              <View style={st.kv}><T v="rs" style={{ fontSize: 16 }}>{t('ns_quote_lead')}</T><T v="rv">{t('ns_days', { n: r.lead_days, d: plural(r.lead_days, t('ns_days_n')) })}</T></View>
            ) : null}
            {r.designer_comment ? <View style={st.quote}><T style={st.quoteT}>{`«${r.designer_comment}»`}</T></View> : null}
          </Card>
        ) : null}
        {r.status === 'done' ? <Banner tone="ok" icon="checkmark" text={t('ns_done_ban')} textStyle={{ fontSize: 15, lineHeight: 21, fontWeight: '500' }} style={{ alignItems: 'flex-start' }} /> : null}
        {r.files.length ? (
          <Card padded={false}>
            {r.files.map((f) => <ListItem key={f.id} icon="document-attach-outline" title={f.name} subtitle={`${Math.max(1, Math.round(f.size / 1024))} КБ`} onPress={() => openFile(f)} />)}
          </Card>
        ) : null}
        <Button v="ghost" title={t('ns_new')} onPress={() => setForm(true)} />
      </Screen>
    );
  }

  // ---------- SCR-19: заявка на доработку ----------
  const photo = (card.data?.photos ?? []).find((p) => p.kind === 'source');
  return (
    <Screen gap={12} contentStyle={{ paddingTop: 10 }} footerStyle={{ paddingTop: 4 }}
      footer={<Button v="ghost" title={t('ns_keep')} onPress={() => (router.canGoBack() ? router.back() : router.replace(`/project/${id}/editor`))} />}>
      <Stack.Screen options={{ title: '' }} />
      <T v="bigPush" style={{ paddingHorizontal: 8, marginTop: -8 }}>{t('ns_h1')}</T>
      <View style={st.photos}>
        <View style={[st.ph2, { backgroundColor: '#C9B99A' }]}>
          {photo ? <Image source={{ uri: photo.url }} style={StyleSheet.absoluteFill} /> : null}
          <View style={st.lb}><T style={st.lbT}>{t('ns_client_photo')}</T></View>
        </View>
        <View style={[st.ph2, { backgroundColor: palette.wood, alignItems: 'center', justifyContent: 'center' }]}>
          <Carcass w={56} h={72} r={0} b={2} />
          <View style={st.lb}><T style={st.lbT}>{t('ns_closest_short')}</T></View>
        </View>
      </View>
      {differences.length ? (
        <View style={{ gap: 10 }}>
          <T style={st.h3}>{t('ns_mismatch')}</T>
          <View style={st.diffs}>{differences.map((d) => <View key={d} style={st.diff}><T style={st.diffT}>{d}</T></View>)}</View>
        </View>
      ) : null}
      <Field label={t('ns_important')} placeholder={t('ns_important_ph')} value={text} onChangeText={setText} multiline multilineMinHeight={84}
        style={{ fontSize: 16, lineHeight: 22, fontWeight: '400' }} />
      <View style={{ gap: 10 }}>
        <T style={st.h3}>{t('ns_how')}</T>
        <Card padded={false}>
          <Way icon="people-outline" tone="green" title={t('ns_way_eman')} text={t('ns_way_eman_d')} busy={busy === 'eman'} onPress={() => send('eman')} />
          <Way icon="document-outline" title={t('ns_way_self')} text={t('ns_way_self_d')} busy={busy === 'self'} onPress={() => send('self')} sep />
        </Card>
      </View>
      {requests.filter((r) => r.path === 'self').length ? <T v="cap" style={{ paddingHorizontal: 8 }}>{t('ns_sent_self')}</T> : null}
    </Screen>
  );
}

function Way({ icon, tone, title, text, onPress, busy, sep }: {
  icon: React.ComponentProps<typeof Ionicons>['name']; tone?: 'green'; title: string; text: string; onPress: () => void; busy?: boolean; sep?: boolean;
}) {
  const green = tone === 'green';
  return (
    <Press feedback="row" onPress={onPress} disabled={busy} accessibilityRole="button" style={[st.way, sep && st.sep]}>
      <View style={[st.wi, { backgroundColor: green ? tones.green.bg : palette.ground }]}>
        <Ionicons name={icon} size={22} color={green ? tones.green.fg : palette.ink} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T v="rt" color={green ? tones.green.fg : palette.ink}>{title}</T>
        <T v="rs" style={{ marginTop: 2 }}>{text}</T>
      </View>
      {busy ? <ActivityIndicator color={palette.chev} style={{ alignSelf: 'center' }} />
        : <Ionicons name="chevron-forward" size={18} color={palette.chev} style={{ alignSelf: 'center' }} />}
    </Press>
  );
}

/** Только для сверки с макетом в dev: заявка в заданном статусе (на сервер не уходит). */
function devRequest(projectId: string, status: NonstandardStatus): NonstandardOut {
  const order: NonstandardStatus[] = ['sent', 'estimated', 'in_work', 'done'];
  const labels = { sent: 'Отправлена', estimated: 'Оценена', in_work: 'В работе', done: 'Готово', cancelled: 'Отменена' };
  return {
    id: 'dev-ns', number: 1, project_id: projectId, description: 'Нишу сделаем из гнутого МДФ R250, остальное из ваших модулей', photo_ids: [], differences: [],
    path: 'eman', status, status_label: labels[status], steps: order.map((s, i) => ({ status: s, label: labels[s], done: order.indexOf(status) >= i })),
    price: status === 'sent' ? null : 1_500_000, lead_days: status === 'sent' ? null : 2, assignee: null, files: [],
    can_accept: status === 'estimated', can_cancel: status === 'sent', created_at: new Date(Date.now() - 2 * 86400_000).toISOString(),
    designer_comment: status === 'sent' ? null : 'Нишу сделаем из гнутого МДФ R250, остальное из ваших модулей',
  };
}

const st = StyleSheet.create({
  head: { paddingHorizontal: 8, paddingTop: 2, marginTop: -12 },
  softSm: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', paddingHorizontal: 12 },
  tl: { flexDirection: 'row', gap: 14, minHeight: 60 },
  rail: { width: 20, alignItems: 'center', paddingTop: 2 },
  c: { width: 20, height: 20, borderRadius: 10 },
  cDone: { backgroundColor: palette.green },
  cCur: { backgroundColor: palette.white, borderWidth: 5, borderColor: palette.green },
  cTodo: { borderWidth: 2, borderColor: palette.handle },
  ln: { flex: 1, width: 2, marginVertical: 4 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  quote: { backgroundColor: palette.ground, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14 },
  quoteT: { fontSize: 15, lineHeight: 21 },
  photos: { flexDirection: 'row', gap: 8, marginTop: -2 },
  ph2: { flex: 1, height: 140, borderRadius: 24, overflow: 'hidden' },
  lb: { position: 'absolute', left: 10, bottom: 10, backgroundColor: palette.white, borderRadius: 14, height: 28, justifyContent: 'center', paddingHorizontal: 10 },
  lbT: { fontSize: 13, lineHeight: 17, fontWeight: '500' },
  h3: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3, paddingHorizontal: 8 },
  diffs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  diff: { height: 30, borderRadius: 15, backgroundColor: palette.amberSoft, justifyContent: 'center', paddingHorizontal: 12 },
  diffT: { fontSize: 14, lineHeight: 19, fontWeight: '500', color: palette.amberDeep },
  way: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 14, paddingHorizontal: 16 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
  wi: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
