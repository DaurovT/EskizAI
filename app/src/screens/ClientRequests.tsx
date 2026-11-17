/**
 * SCR-58 «Просьбы клиентов» (ClientRequests.dc.html; планшет — TRequests.dc.html): клиент нажал «Хочу изменить…» на
 * странице ссылки с 3D. Список по всему цеху (или по проекту) с чипами «Новые · Все», карточка просьбы: проект и версия,
 * текст, «смотрел 3D / был в AR», «Изменить модель» (чат редактора с текстом просьбы), «Ответить» (Telegram клиента),
 * «Сделано» (PATCH /client-requests/{id}). Широкий планшет — список слева, просьба справа, боковая панель.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Linking, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import { ApiError } from '../api/errors';
import type { ClientRequestOut, ClientRequestPage, ClientRequestStatus } from '../api/types';
import { useResource } from '../hooks/useResource';
import { useT } from '../i18n';
import { askText, initials, isNew, requestCounts, shortWhen, telegramUrl, withStatus } from '../lib/clientRequests';
import { formatDayMonth, formatRange, plural } from '../lib/format';
import { showError } from '../ui/dialogs';
import { Cap2, DBtn, DCard, DesktopShell, DSeg, ListRow, Toolbar, desk, dk } from '../ui/Desktop';
import { ErrorState } from '../ui/ErrorState';
import { Button, ButtonRow, Card, Chip, EmptyState, IconButton, Loading, Press, Screen, T, resolveFont, toast } from '../ui/kit';
import { SketchThumb } from '../ui/ProductSketch';
import { useLayout } from '../ui/layout';
import { palette } from '../ui/theme';

type Filter = 'new' | 'all';

/** Просьбы цеха (или проекта). Старый сервер без GET /client-requests — по проекту, как раньше. */
function useRequests(projectId?: string) {
  return useResource(async (): Promise<ClientRequestPage> => {
    try {
      return await api.listWorkshopClientRequests(projectId ? { project_id: projectId } : undefined);
    } catch (e) {
      if (!projectId || !(e instanceof ApiError) || e.status !== 404) throw e;
      const items = await api.listClientRequests(projectId);
      return { items, new_count: items.filter(isNew).length, total: items.length };
    }
  }, [projectId]);
}

/** Действия с просьбой: в редактор, ответить, позвонить, «Сделано» (с мгновенной отметкой в списке). */
function useActions(data: ClientRequestPage | null, setData: (d: ClientRequestPage) => void) {
  const { t, lang } = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const toEditor = (r: ClientRequestOut) => {
    if (!r.project_id) return;
    router.push({ pathname: '/project/[id]/editor', params: { id: r.project_id, ask: askText(t('cr_ai_prefix'), r.text) } });
  };
  const reply = (r: ClientRequestOut) => {
    if (r.client_phone) Linking.openURL(telegramUrl(r.client_phone)).catch(() => undefined);
    else if (r.project_id) router.push(`/project/${r.project_id}`);
  };
  const call = (r: ClientRequestOut) => { if (r.client_phone) Linking.openURL(`tel:${r.client_phone}`).catch(() => undefined); };
  const setStatus = async (r: ClientRequestOut, status: ClientRequestStatus) => {
    if (!data) return false;
    const before = data;
    const patch = (x: ClientRequestOut) => (x.id === r.id ? withStatus(x, status) : x);
    const delta = status === 'done' ? -1 : 1;
    setData({ ...data, items: data.items.map(patch), new_count: Math.max(0, data.new_count + (isNew(r) === (status === 'done') ? delta : 0)) });
    setBusy(r.id);
    try {
      const fresh = await api.setClientRequestStatus(r.id, status);
      setData({ ...before, items: before.items.map((x) => (x.id === r.id ? { ...x, ...fresh } : x)),
        new_count: Math.max(0, before.new_count + (isNew(r) === (status === 'done') ? delta : 0)) });
      toast.show({ text: status === 'done' ? t('crq_done_toast') : t('crq_reopened'), tone: status === 'done' ? 'success' : undefined });
      return true;
    } catch (e) {
      setData(before);
      showError(e, lang);
      return false;
    } finally { setBusy(null); }
  };
  return { toEditor, reply, call, setStatus, busy };
}

const who = (r: ClientRequestOut, fallback: string) => r.client_name || fallback;

// ---------- телефон: список ----------

/** .rq — строка просьбы: зелёная точка у новой, кружок с инициалами, имя и время, проект, текст в «ёлочках» (2 строки). */
function RequestRow({ r, first, onPress }: { r: ClientRequestOut; first: boolean; onPress: () => void }) {
  const { t, lang } = useT();
  const name = who(r, t('crq_no_client'));
  return (
    <Press feedback="row" onPress={onPress} accessibilityRole="button"
      accessibilityLabel={[name, r.project_title, r.text, isNew(r) ? t('crq_new') : null].filter(Boolean).join(', ')}
      style={[ph.rq, !first && ph.rqLine]}>
      <View style={[ph.nd, !isNew(r) && { backgroundColor: 'transparent' }]} />
      <View style={ph.av}><Text style={resolveFont(ph.avT)}>{initials(r.client_name)}</Text></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={ph.meta}>
          <T v="rt" style={{ fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>{name}</T>
          <T v="rs" style={{ fontSize: 13 }}>{shortWhen(r.created_at, lang)}</T>
        </View>
        {r.project_title ? <T v="rs" numberOfLines={1}>{r.project_title}</T> : null}
        <T style={ph.q} numberOfLines={2}>{`«${r.text}»`}</T>
      </View>
    </Press>
  );
}

export function ClientRequestsList({ projectId }: { projectId?: string }) {
  const { t } = useT();
  const res = useRequests(projectId);
  const [filter, setFilter] = useState<Filter | null>(null);
  if (res.loading && !res.data) return <><ListHeader projectId={projectId} /><Loading /></>;
  if (!res.data) return <><ListHeader projectId={projectId} /><ErrorState error={res.error} onRetry={res.reload} /></>;
  const all = res.data.items;
  const c = requestCounts(all);
  // по умолчанию — «Новые», если они есть
  const f: Filter = filter ?? (c.fresh ? 'new' : 'all');
  const items = f === 'new' ? all.filter(isNew) : all;
  const open = (r: ClientRequestOut) => router.push(`/client-requests/${r.id}`);
  return (
    <Screen gap={8} contentStyle={{ paddingTop: 2 }} refreshControl={<RefreshControl refreshing={res.refreshing} onRefresh={res.refresh} />}>
      <ListHeader projectId={projectId} />
      {!all.length ? (
        <EmptyState icon="chatbubble-ellipses-outline" title={t('cr_empty')} text={t('cr_empty_note')} />
      ) : (
        <>
          <T v="cap" style={{ paddingHorizontal: 8 }}>{t('crq_hint')}</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Chip label={t('crq_new')} count={c.fresh} selected={f === 'new'} onPress={() => setFilter('new')} />
            <Chip label={t('crq_all')} count={c.all} selected={f === 'all'} onPress={() => setFilter('all')} />
          </View>
          {items.length ? (
            <Card padded={false}>
              {items.map((r, i) => <RequestRow key={r.id} r={r} first={i === 0} onPress={() => open(r)} />)}
            </Card>
          ) : <EmptyState compact icon="checkmark-done-outline" title={t('crq_empty_new')} text={t('crq_empty_new_text')} />}
        </>
      )}
    </Screen>
  );
}

const ListHeader = ({ projectId }: { projectId?: string }) => {
  const { t } = useT();
  return <Stack.Screen options={{ title: projectId ? t('cr_title') : t('crq_title'), headerLargeTitle: false }} />;
};

// ---------- телефон: просьба ----------

export function ClientRequestItem({ id }: { id: string }) {
  const { t, lang } = useT();
  const res = useRequests();
  const act = useActions(res.data, res.setData);
  const r = res.data?.items.find((x) => x.id === id) ?? null;
  if (res.loading && !res.data) return <Loading />;
  if (!res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!r) return <><Stack.Screen options={{ title: '' }} /><EmptyState icon="chatbubble-ellipses-outline" title={t('crq_gone')} /></>;
  const done = async () => { if (await act.setStatus(r, isNew(r) ? 'done' : 'new')) { if (isNew(r) && router.canGoBack()) router.back(); } };
  const whenFull = shortWhen(r.created_at, lang);
  return (
    <Screen gap={10} contentStyle={{ paddingTop: 2 }} footerStyle={{ gap: 8, paddingTop: 4 }} footer={
      <>
        <Button icon="pencil-outline" title={t('crq_edit_model')} onPress={() => act.toEditor(r)} disabled={!r.project_id} />
        <ButtonRow>
          <Button v="secondary" icon="paper-plane-outline" title={t('crq_reply')} onPress={() => act.reply(r)} style={{ flex: 1 }} />
          <Button v="secondary" icon={isNew(r) ? 'checkmark' : 'refresh-outline'} title={isNew(r) ? t('crq_done') : t('crq_reopen')}
            onPress={done} loading={act.busy === r.id} style={{ flex: 1 }} />
        </ButtonRow>
        <T v="cap" center>{t('crq_edit_note')}</T>
      </>
    }>
      <Stack.Screen options={{
        title: who(r, t('crq_no_client')), headerLargeTitle: false,
        headerRight: r.client_phone ? () => <IconButton icon="call-outline" label={t('crq_call')} onPress={() => act.call(r)} /> : undefined,
      }} />
      {r.project_id ? (
        <Card padded={false} onPress={() => router.push(`/project/${r.project_id}`)} style={{ borderRadius: 22 }} accessibilityLabel={r.project_title ?? undefined}>
          <View style={ph.proj}>
            <View style={ph.thumb}><Ionicons name="cube-outline" size={22} color={palette.ink} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T v="rt" style={{ fontWeight: '600' }} numberOfLines={1}>{r.project_title ?? ''}</T>
              <T v="rs" numberOfLines={1}>{[r.version_number ? t('crq_viewed_version', { n: r.version_number }) : null, whenFull].filter(Boolean).join(' · ')}</T>
            </View>
            <Ionicons name="chevron-forward" size={18} color={palette.chev} />
          </View>
        </Card>
      ) : null}
      <Card style={{ gap: 10, padding: 16 }}>
        <T v="rs" style={{ fontWeight: '600', color: palette.ink }}>{t('crq_want')}</T>
        <View style={ph.quote}><T selectable>{r.text}</T></View>
        <ViewChips r={r} />
        {!isNew(r) && r.done_at ? <T v="cap">{t('crq_done_at', { date: formatDayMonth(r.done_at, lang) })}</T> : null}
      </Card>
    </Screen>
  );
}

/** .vchip — «смотрел 3D · N раз», «был в AR». */
function ViewChips({ r, wide }: { r: ClientRequestOut; wide?: boolean }) {
  const { t, lang } = useT();
  const views = r.views ?? 0;
  const chips: { icon: 'eye-outline' | 'cube-outline'; label: string }[] = [
    ...(views ? [{ icon: 'eye-outline' as const, label: t('crq_views', { n: views, w: lang === 'uz' ? '' : plural(views, 'раз|раза|раз') }).trim() }] : []),
    ...(r.ar ? [{ icon: 'cube-outline' as const, label: t('crq_ar') }] : []),
  ];
  if (!chips.length) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
      {chips.map((c) => (
        <View key={c.icon} style={wide ? wd.vch : ph.vchip}>
          <Ionicons name={c.icon} size={wide ? 13 : 14} color={palette.muted2} />
          <Text style={resolveFont(wide ? wd.vchT : ph.vchipT)}>{c.label}</Text>
        </View>
      ))}
    </View>
  );
}

// ---------- широкий планшет (TRequests.dc.html) ----------

export function ClientRequestsWide({ selected }: { selected?: string }) {
  const { t, lang } = useT();
  const compact = useLayout().width < 1150;
  const res = useRequests();
  const act = useActions(res.data, res.setData);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [sel, setSel] = useState<string | null>(selected ?? null);
  const all = res.data?.items ?? [];
  const c = requestCounts(all);
  const f: Filter = filter ?? (c.fresh ? 'new' : 'all');
  const items = f === 'new' ? all.filter(isNew) : all;
  const cur = items.find((x) => x.id === sel) ?? all.find((x) => x.id === sel) ?? items[0] ?? null;
  const card = useResource(() => (cur?.project_id ? api.getProject(cur.project_id).catch(() => null) : Promise.resolve(null)), [cur?.project_id]);

  const done = async (r: ClientRequestOut) => {
    const next = items[items.findIndex((x) => x.id === r.id) + 1] ?? null;
    if (await act.setStatus(r, isNew(r) ? 'done' : 'new') && f === 'new' && isNew(r)) setSel(next?.id ?? null);
  };

  let body: React.ReactNode;
  if (res.loading && !res.data) body = <Loading />;
  else if (!res.data) body = <ErrorState error={res.error} onRetry={res.reload} />;
  else if (!all.length) body = <View style={{ flex: 1, justifyContent: 'center' }}><EmptyState align="center" icon="chatbubble-ellipses-outline" title={t('cr_empty')} text={t('cr_empty_note')} /></View>;
  else {
    const p = card.data;
    body = (
      <View style={desk.panes}>
        <View style={[wd.pane, { width: compact ? 300 : 340 }]}>
          <ScrollView refreshControl={<RefreshControl refreshing={res.refreshing} onRefresh={res.refresh} />}>
            {items.map((r) => (
              <ListRow key={r.id} on={cur?.id === r.id} onPress={() => setSel(r.id)} style={wd.lr}
                label={[who(r, t('crq_no_client')), r.project_title, r.text].filter(Boolean).join(', ')}>
                <View style={[wd.av, { width: 32, height: 32, borderRadius: 16 }]}><Text style={resolveFont([wd.avT, { fontSize: 12 }])}>{initials(r.client_name)}</Text></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 6 }}>
                    <Text style={resolveFont([desk.t, { flexShrink: 1 }])} numberOfLines={1}>{who(r, t('crq_no_client'))}</Text>
                    <Text style={resolveFont(desk.s)}>{shortWhen(r.created_at, lang)}</Text>
                  </View>
                  {r.project_title ? <Text style={resolveFont(desk.s)} numberOfLines={1}>{r.project_title}</Text> : null}
                  <Text style={resolveFont(wd.q)} numberOfLines={2}>{`«${r.text}»`}</Text>
                </View>
                {isNew(r) ? <View style={wd.dot} /> : null}
              </ListRow>
            ))}
            {!items.length ? <View style={{ padding: 20 }}><EmptyState compact icon="checkmark-done-outline" title={t('crq_empty_new')} text={t('crq_empty_new_text')} /></View> : null}
          </ScrollView>
        </View>
        {cur ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={wd.det}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={[wd.av, { width: 40, height: 40, borderRadius: 20 }]}><Text style={resolveFont(wd.avT)}>{initials(cur.client_name)}</Text></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={resolveFont(wd.name)} numberOfLines={1}>{who(cur, t('crq_no_client'))}</Text>
                <Cap2 style={{ fontSize: 13 }}>{[cur.project_title, cur.version_number ? t('crq_viewed_version', { n: cur.version_number }) : null, shortWhen(cur.created_at, lang)].filter(Boolean).join(' · ')}</Cap2>
              </View>
              {cur.client_phone ? <DBtn icon="call-outline" title={t('crq_call')} onPress={() => act.call(cur)} /> : null}
              {cur.client_phone ? <DBtn icon="paper-plane-outline" title="Telegram" onPress={() => act.reply(cur)} /> : null}
            </View>
            <Text style={resolveFont(wd.want)}>{t('crq_want')}</Text>
            <View style={wd.quote}><T style={{ fontSize: 15, lineHeight: 22 }} selectable>{cur.text}</T></View>
            <ViewChips r={cur} wide />
            {cur.project_id ? (
              <DCard style={wd.proj}>
                <View style={wd.projPic}><SketchThumb sketch={p?.sketch} kind={p?.product_type} size={56} /></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={resolveFont(desk.t)} numberOfLines={1}>{cur.project_title ?? ''}</Text>
                  <Cap2>{[cur.version_number ? t('crq_version', { n: cur.version_number }) : null, p?.price ? formatRange(p.price, lang).replace(/ (сум|so‘m)$/, '') : null].filter(Boolean).join(' · ')}</Cap2>
                </View>
                <DBtn title={t('crq_open_project')} onPress={() => router.push(`/project/${cur.project_id}`)} />
              </DCard>
            ) : null}
            <View style={{ flex: 1, minHeight: 24 }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <DBtn primary tall icon="pencil-outline" title={t('crq_edit_model')} onPress={() => act.toEditor(cur)} disabled={!cur.project_id} />
              <DBtn tall icon={isNew(cur) ? 'checkmark' : 'refresh-outline'} title={isNew(cur) ? t('crq_mark_done') : t('crq_reopen')}
                onPress={() => done(cur)} disabled={act.busy === cur.id} />
              <Cap2>{t('crq_edit_note')}</Cap2>
            </View>
          </ScrollView>
        ) : <View style={{ flex: 1 }} />}
      </View>
    );
  }
  return (
    <DesktopShell active="requests">
      <Stack.Screen options={{ headerShown: false }} />
      <Toolbar title={t('crq_title')} sub={t('crq_hint_wide')}>
        {all.length ? <DSeg value={f} onChange={setFilter} options={[{ value: 'new', label: t('crq_new'), n: c.fresh }, { value: 'all', label: t('crq_all'), n: c.all }]} /> : null}
      </Toolbar>
      {body}
    </DesktopShell>
  );
}

const ph = StyleSheet.create({
  rq: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 14, paddingHorizontal: 18 },
  rqLine: { borderTopWidth: 1, borderTopColor: palette.hair },
  nd: { width: 9, height: 9, borderRadius: 5, backgroundColor: palette.green, marginTop: 16 },
  av: { width: 40, height: 40, borderRadius: 20, backgroundColor: palette.segOnWhite, alignItems: 'center', justifyContent: 'center' },
  avT: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: palette.ink },
  meta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  q: { fontSize: 15, lineHeight: 20, color: palette.ink, marginTop: 4 },
  proj: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingVertical: 10, paddingHorizontal: 20 },
  thumb: { width: 56, height: 56, borderRadius: 16, backgroundColor: palette.wood, alignItems: 'center', justifyContent: 'center' },
  quote: { backgroundColor: palette.ground, borderRadius: 18, borderBottomLeftRadius: 6, paddingVertical: 12, paddingHorizontal: 14 },
  vchip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, borderRadius: 9, backgroundColor: palette.ground, paddingHorizontal: 10 },
  vchipT: { fontSize: 13, lineHeight: 17, fontWeight: '600', color: palette.muted2 },
});

const wd = StyleSheet.create({
  pane: { backgroundColor: dk.pane, borderRightWidth: 1, borderRightColor: dk.line },
  lr: { alignItems: 'flex-start', paddingVertical: 10 },
  av: { backgroundColor: palette.segOnWhite, alignItems: 'center', justifyContent: 'center' },
  avT: { fontSize: 15, lineHeight: 19, fontWeight: '600', color: palette.ink },
  q: { fontSize: 13, lineHeight: 18, color: dk.sideText, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.green, marginTop: 6 },
  det: { flexGrow: 1, paddingVertical: 18, paddingHorizontal: 22, gap: 12 },
  name: { fontSize: 18, lineHeight: 23, fontWeight: '700', color: palette.ink },
  want: { fontSize: 13, lineHeight: 17, fontWeight: '600', color: palette.ink },
  quote: {
    alignSelf: 'flex-start', maxWidth: 620, backgroundColor: palette.white, borderWidth: 1, borderColor: dk.cardLine,
    borderRadius: 14, borderBottomLeftRadius: 4, paddingVertical: 14, paddingHorizontal: 16,
  },
  vch: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 26, borderRadius: 7, backgroundColor: palette.white, borderWidth: 1, borderColor: dk.cardLine, paddingHorizontal: 9 },
  vchT: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: palette.muted2 },
  proj: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10, paddingHorizontal: 12, maxWidth: 620 },
  projPic: { width: 84, height: 64, borderRadius: 8, backgroundColor: '#FCFBF8', borderWidth: 1, borderColor: '#ECEAE5', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
});
