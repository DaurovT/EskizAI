/**
 * SCR-27 Карточка проекта: статус-лента, следующий шаг (кнопка из actions[0] / next_step), клиент, итог,
 * переходы к модели, смете, файлам, версиям, ссылкам; меню: архив, удалить, отменить.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../src/api';
import { STATUS_FLOW, type ActionOut, type ProjectCardOut } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatDayMonth, formatRange } from '../../../src/lib/format';
import { displayTitle, sizeTitle } from '../../../src/lib/projectTitle';
import { rememberPrice } from '../../../src/state/prices';
import { useSession } from '../../../src/state/session';
import { useOffline } from '../../../src/state/net';
import { confirm, showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Carcass } from '../../../src/ui/Illus';
import { LangSwitch } from '../../../src/ui/LangSwitch';
import { Banner, Button, Card, Dialog, Field, Footer, Gap, Group, IconButton, ListItem, Loading, MenuItem, OfflineBanner, Sheet, T, type IconName } from '../../../src/ui/kit';
import { palette, space } from '../../../src/ui/theme';

export default function ProjectCard() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, td, lang } = useT();
  const { isOwner, canOrder, seesCost } = useSession();
  const offline = useOffline();
  const { data: p, setData, error, loading, reload } = useResource(() => api.getProject(id), [id]);
  const versions = useResource(() => api.listVersions(id).catch(() => []), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [delDialog, setDelDialog] = useState(false);
  const [cancelSheet, setCancelSheet] = useState(false);
  const [reason, setReason] = useState('');
  const [clientSheet, setClientSheet] = useState(false);
  const [titleSheet, setTitleSheet] = useState(false);
  const [title, setTitle] = useState('');
  const clients = useResource(() => api.listClients(), [], { enabled: clientSheet });
  const orders = useResource(() => api.listOrders().then((all) => all.filter((o) => o.project_id === id)), [id]);
  const priceRequests = useResource(() => (seesCost ? api.listPriceRequests(id).catch(() => []) : Promise.resolve([])), [id]);
  const nonstandard = useResource(() => api.listNonstandard(id).catch(() => []), [id]);

  useEffect(() => { if (p) rememberPrice(p); }, [p]);
  if (loading && !p) return <Loading />;
  if (!p) return <ErrorState error={error} onRetry={reload} />;

  const exec = async (key: string, fn: () => Promise<ProjectCardOut | void>) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r) setData(r);
      else reload();
    } catch (e) {
      showError(e, lang);
    } finally {
      setBusy(null);
    }
  };

  const doAction = async (a: ActionOut) => {
    switch (a.code) {
      case 'sketch':
        if (!p.current_version_id) return router.push(`/project/${id}/breakdown`);
        return exec(a.code, () => api.toSketch(id));
      case 'share': return router.push(`/project/${id}/send`);
      case 'measure': return router.push(`/project/${id}/measure`);
      case 'contract':
        if (await confirm(td('act_contract', a.label), t('card_contract_confirm'), t('confirm'), t('cancel'))) exec(a.code, () => api.toContract(id));
        return;
      case 'order': {
        if (p.is_example) return Alert.alert(t('example_badge'));
        if (!canOrder) return Alert.alert(t('oc_owner_only'));
        const existing = (orders.data ?? []).find((o) => o.status !== 'cancelled');
        return existing ? router.push(`/order/${existing.id}`) : router.push(`/project/${id}/order`);
      }
      case 'deliver':
      case 'deliver_self_bought':
        if (await confirm(td(`act_${a.code}`, a.label), t('card_deliver_confirm'), t('confirm'), t('cancel'))) exec(a.code, () => api.deliver(id, a.code === 'deliver_self_bought'));
        return;
      case 'cancel': return setCancelSheet(true);
      case 'unarchive': return exec(a.code, () => api.unarchiveProject(id));
      default: return Alert.alert(a.label);
    }
  };

  const selfBought = p.actions.find((a) => a.code === 'deliver_self_bought');
  const primary = p.actions.find((a) => a.code !== 'cancel' && a.code !== 'deliver_self_bought');
  const extra = p.actions.filter((a) => a !== primary && a !== selfBought && a.code !== 'cancel');
  const est = p.estimate;
  const stIdx = Math.max(0, STATUS_FLOW.indexOf(p.status));
  const size = p.model_summary?.size_mm;
  // сгенерированное по дате название — типом и габаритом (Ш×Г×В)
  const shownTitle = displayTitle(p.title, sizeTitle(p.product_type ? td(`pk_${p.product_type}`, t('new_title_sketch')) : t('new_title_sketch'), size ? [size[0], size[2], size[1]] : null));
  const current = versions.data?.find((v) => v.is_current) ?? versions.data?.[0];
  const activeOrders = (orders.data ?? []).filter((o) => o.status !== 'cancelled');
  const openEditor = () => router.push(`/project/${id}/editor`);
  const duplicate = async () => {
    setMenu(false);
    setBusy('dup');
    try {
      // сервер копирует дерево текущей версии, клиента и фото; лимит — как у нового проекта (при эскизе)
      const copy = await api.duplicateProject(id);
      router.push(`/project/${copy.id}`);
    } catch (e) {
      showError(e, lang);
    } finally {
      setBusy(null);
    }
  };
  const mi = (icon: IconName, title: string, onPress: () => void, red?: boolean) => <MenuItem icon={icon} title={title} red={red} onPress={() => { setMenu(false); onPress(); }} />;

  return (
    <SafeAreaView style={st.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={st.hdr}>
        <IconButton icon="chevron-back" label={t('back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <View style={{ flex: 1 }} />
        <LangSwitch itemStyle={{ minWidth: 48, paddingHorizontal: 10 }} />
        <IconButton icon="ellipsis-horizontal" label={t('pc_more')} onPress={() => setMenu(true)} />
      </View>
      <OfflineBanner />
      <ScrollView contentContainerStyle={st.body}>
        {p.is_example ? <Banner tone="est" text={t('example_badge')} /> : null}
        <Card padded={false} onPress={p.current_version_id ? openEditor : () => router.push(`/project/${id}/breakdown`)} accessibilityLabel={p.title}>
          <View style={st.sum}>
            <View style={st.thumb}><Carcass w={56} h={66} r={20} b={2} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={st.title} numberOfLines={2}>{shownTitle}</T>
              {/* Ш × Г × В, как в макете */}<T v="rs" num style={{ marginTop: 2 }}>{[size ? [size[0], size[2], size[1]].map((x) => Math.round(x)).join(' × ') : null, formatDayMonth(p.created_at, lang)].filter(Boolean).join(' · ')}</T>
              <T num style={st.price}>{est ? formatRange(est.total, lang) : p.current_version_id ? t('est_unavailable') : t('card_no_model')}</T>
              <View style={st.pill}>
                <Ionicons name={p.current_version_id ? 'cube-outline' : 'sparkles-outline'} size={16} color={palette.ink} />
                <T style={{ fontSize: 14, lineHeight: 18, fontWeight: '500' }}>{p.current_version_id ? t('pc_open_3d') : t('card_build_model')}</T>
              </View>
            </View>
          </View>
        </Card>
        <Card style={{ paddingVertical: 16, paddingHorizontal: 20, gap: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <T style={st.stName}>{td(`st_${p.status}`, p.status_label)}</T>
            {p.status !== 'cancelled' ? <T v="rs" num>{t('pc_step_of', { n: stIdx + 1, total: STATUS_FLOW.length })}</T> : null}
          </View>
          {p.status !== 'cancelled' ? (
            <View style={st.prog} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              {STATUS_FLOW.map((sKey, i) => <View key={sKey} style={[st.seg, { backgroundColor: i < stIdx ? palette.green : i === stIdx ? '#A9CDB5' : palette.off }]} />)}
            </View>
          ) : null}
          <View style={st.next}>
            <Ionicons name="sparkles-outline" size={20} color={palette.greenDeep} style={{ marginTop: 1 }} />
            <View style={{ flex: 1 }}>
              <T style={{ fontSize: 13, lineHeight: 17 }} color={palette.greenDeep}>{t('pc_next')}</T>
              <T style={{ fontSize: 15, lineHeight: 21, fontWeight: '500' }} color="#1F4A2F">{p.next_step}</T>
            </View>
          </View>
        </Card>
        <Group>
          <ListItem compact chevron icon="people-outline" title={t('card_client')} right={<RowVal text={p.client?.name ?? t('card_add_client')} />}
            onPress={() => (p.client ? router.push(`/client/${p.client.id}`) : setClientSheet(true))} />
          {p.current_version_id ? (
            <ListItem compact chevron icon="document-outline" title={t('card_estimate')} right={est ? <RowVal strong text={formatRange(est.total, lang).replace(/ (сум|so‘m)$/, '')} /> : undefined}
              onPress={() => router.push(`/project/${id}/estimate`)} />
          ) : null}
          {p.current_version_id ? (
            <ListItem compact chevron icon="layers-outline" title={t('pc_versions')}
              right={current ? <RowVal text={`v${current.number} · ${p.frozen_version_id ? t('pc_frozen') : t('pc_draft')}`} /> : undefined}
              onPress={() => router.push(`/project/${id}/versions`)} />
          ) : null}
          {priceRequests.data?.length ? (
            <ListItem compact chevron icon="pricetag-outline" title={t('card_price_requests')}
              right={<RowVal text={t('card_price_requests_sub', { priced: priceRequests.data.filter((r) => r.status === 'priced').length, pending: priceRequests.data.filter((r) => r.status === 'pending').length })} />}
              onPress={() => router.push(`/project/${id}/price-requests`)} />
          ) : null}
          {nonstandard.data?.length ? (
            <ListItem compact chevron icon="construct-outline" title={t('card_nonstandard')} right={<RowVal text={td(`nss_${nonstandard.data[0].status}`, nonstandard.data[0].status_label)} />}
              onPress={() => router.push(`/project/${id}/nonstandard`)} />
          ) : null}
          <ListItem compact chevron icon="cube-outline" title={t('pc_orders')} right={<RowVal text={activeOrders.length ? activeOrders.map((o) => `№ ${o.number}`).join(', ') : t('pc_none')} />}
            onPress={() => (activeOrders[0] ? router.push(`/order/${activeOrders[0].id}`) : doAction({ code: 'order', label: t('act_order'), to_status: null }))} />
          {p.current_version_id ? <ListItem compact chevron icon="download-outline" title={t('pc_files')} onPress={() => router.push(`/project/${id}/files`)} /> : null}
        </Group>
      </ScrollView>
      <Footer style={{ paddingTop: 6 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button v="secondary" icon="link-outline" title="" accessibilityLabel={t('pc_link')} onPress={() => router.push(`/project/${id}/send`)} style={{ width: 56, paddingHorizontal: 0 }} />
          {primary ? (
            <Button title={td(`act_${primary.code}`, primary.label)} onPress={() => doAction(primary)} loading={busy === primary.code} style={{ flex: 1 }}
              disabled={offline && !['share', 'measure'].includes(primary.code)} />
          ) : (
            <Button title={t('pc_dup')} onPress={duplicate} loading={busy === 'dup'} style={{ flex: 1 }} />
          )}
        </View>
        {selfBought ? <Button v="ghost" title={t('pc_self_bought')} onPress={() => doAction(selfBought)} loading={busy === selfBought.code} /> : null}
      </Footer>

      <Sheet variant="gray" visible={menu} onClose={() => setMenu(false)}>
        <Group>
          {mi('copy-outline', t('pc_dup'), duplicate)}
          {p.current_version_id ? mi('layers-outline', t('pc_versions'), () => router.push(`/project/${id}/versions`)) : null}
          {!p.archived_at ? mi('archive-outline', t('card_archive'), () => exec('archive', () => api.archiveProject(id))) : null}
          {mi('link-outline', t('pc_link'), () => router.push(`/project/${id}/send`))}
          {mi('create-outline', t('pc_rename'), () => { setTitle(p.title); setTitleSheet(true); })}
          {mi('resize-outline', t('card_measure'), () => router.push(`/project/${id}/measure`))}
          {p.current_version_id ? mi('color-palette-outline', t('card_materials'), () => router.push(`/project/${id}/materials`)) : null}
          {p.current_version_id ? mi('hardware-chip-outline', t('card_hardware'), () => router.push(`/project/${id}/hardware`)) : null}
          {!nonstandard.data?.length ? mi('construct-outline', t('card_nonstandard'), () => router.push(`/project/${id}/nonstandard`)) : null}
          {extra.map((a) => <MenuItem key={a.code} icon="arrow-forward-outline" title={td(`act_${a.code}`, a.label)} onPress={() => { setMenu(false); doAction(a); }} />)}
        </Group>
        {p.actions.some((a) => a.code === 'cancel') || isOwner ? (
          <Group>
            {p.actions.some((a) => a.code === 'cancel') ? mi('close-outline', t('act_cancel'), () => setCancelSheet(true), true) : null}
            {isOwner ? mi('trash-outline', t('delete'), () => setDelDialog(true), true) : null}
          </Group>
        ) : null}
        <Button v="secondary" title={t('close')} onPress={() => setMenu(false)} />
      </Sheet>

      {/* Misc.dc.html: удалить или убрать в архив */}
      <Dialog visible={delDialog} onClose={() => setDelDialog(false)} title={t('pc_del_title', { name: p.title })} text={t('pc_del_text')}
        actions={<>
          {!p.archived_at ? <Button v="secondary" title={t('card_archive')} style={{ flex: 1 }} onPress={() => { setDelDialog(false); exec('archive', () => api.archiveProject(id)); }} /> : null}
          <Button v="danger" title={t('delete')} style={{ flex: 1 }} loading={busy === 'delete'} onPress={async () => {
            setBusy('delete');
            try { await api.deleteProject(id); setDelDialog(false); router.back(); } catch (e) { setDelDialog(false); showError(e, lang); } finally { setBusy(null); }
          }} />
        </>} />

      <Sheet visible={titleSheet} onClose={() => setTitleSheet(false)} title={t('card_title_edit')}>
        <Field value={title} onChangeText={setTitle} autoFocus />
        <Button title={t('save')} disabled={!title.trim()} onPress={() => { setTitleSheet(false); exec('title', () => api.updateProject(id, { title: title.trim() })); }} />
      </Sheet>

      <Sheet visible={cancelSheet} onClose={() => setCancelSheet(false)} title={t('act_cancel')}>
        <T v="muted">{t('card_cancel_confirm')}</T>
        <Gap h={space.s} />
        <Field label={t('card_cancel_reason')} value={reason} onChangeText={setReason} />
        <Button v="danger" title={t('act_cancel')} onPress={() => { setCancelSheet(false); exec('cancel', () => api.cancelProject(id, reason.trim() || undefined)); }} />
      </Sheet>

      <Sheet visible={clientSheet} onClose={() => setClientSheet(false)} title={t('card_add_client')}>
        {(clients.data?.items ?? []).map((c) => (
          <ListItem key={c.id} title={c.name} subtitle={c.phone} onPress={() => { setClientSheet(false); exec('client', () => api.updateProject(id, { client_id: c.id })); }} />
        ))}
        <Button v="ghost" icon="person-add-outline" title={t('client_new')} onPress={() => { setClientSheet(false); router.push({ pathname: '/client/new', params: { pick: id } }); }} />
      </Sheet>
    </SafeAreaView>
  );
}

/** Значение справа в строке: серое .rs тёмным цветом (как в макете) или жирное .rv. */
function RowVal({ text, strong }: { text: string; strong?: boolean }) {
  return <T v={strong ? 'rv' : 'rs'} num numberOfLines={1} style={[{ maxWidth: 180, color: palette.ink }, strong && { fontSize: 15 }]}>{text}</T>;
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.ground },
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 14, paddingHorizontal: 12, paddingBottom: 4, minHeight: 74 },
  body: { paddingTop: 8, paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  sum: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 16 },
  thumb: { width: 96, height: 104, borderRadius: 20, backgroundColor: palette.wood, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, lineHeight: 25, fontWeight: '700', letterSpacing: -0.4 },
  price: { marginTop: 6, fontSize: 19, lineHeight: 24, fontWeight: '700', letterSpacing: -0.29 },
  pill: { alignSelf: 'flex-start', marginTop: 8, height: 34, borderRadius: 20, backgroundColor: palette.ground, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 },
  stName: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
  prog: { flexDirection: 'row', gap: 4 },
  seg: { flex: 1, height: 6, borderRadius: 3 },
  next: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', backgroundColor: palette.greenSoft, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 14 },
});
