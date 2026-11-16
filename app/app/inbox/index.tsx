/**
 * SCR-52 «Входящие чертежи» (MInbox.dc.html): чертежи, присланные мастером из Eskiz DWG. Вход — из «Проектов»
 * (значок в шапке и плашка над списком, когда есть новые). «Новые» (ещё не открывали, зелёная точка) и «Просмотрены»;
 * строка — превью листа 64×46, название, «от вас · DXF · 1 лист · сегодня», «проверьте размеры», «есть проект».
 * Потянуть — обновить; долгое нажатие — удалить. Внизу — сколько хранятся.
 * dev: `/inbox?state=empty|load` — состояния макета.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { api } from '../../src/api';
import type { InboxDrawing } from '../../src/api/types';
import { useResource } from '../../src/hooks/useResource';
import { useT } from '../../src/i18n';
import { drawingLine, drawingTitle, inboxSections } from '../../src/lib/inbox';
import { showError } from '../../src/ui/dialogs';
import { DrawingThumb } from '../../src/ui/Drawing';
import { ErrorState } from '../../src/ui/ErrorState';
import { Card, Hairline, Press, Screen, Skeleton, T, Tag, dialog, toast } from '../../src/ui/kit';
import { palette } from '../../src/ui/theme';
import { TitleHeader } from '../../src/ui/TitleHeader';

export default function Inbox() {
  const { t, lang } = useT();
  const { state } = useLocalSearchParams<{ state?: string }>();
  const devState = __DEV__ ? state : undefined;
  const { data, setData, error, loading, refreshing, reload, refresh } = useResource(() => api.listInbox(), []);
  const header = <Stack.Screen options={{ headerShown: true, header: () => <TitleHeader title={t('inb_title')} sub={t('inb_sub')} /> }} />;

  if (devState === 'load' || (loading && !data)) {
    return (
      <Screen contentStyle={{ paddingTop: 0, gap: 0 }}>
        {header}
        <T style={s.h}>{t('inb_loading')}</T>
        <Card padded={false}>
          {[180, 150, 200].map((w, i) => (
            <View key={i}>
              {i ? <Hairline style={{ marginLeft: 20 }} /> : null}
              <View style={s.row}>
                <Skeleton width={64} height={46} r={8} />
                <View style={{ gap: 8 }}><Skeleton width={w} height={14} r={7} /><Skeleton width={w - 40} height={12} r={6} /></View>
              </View>
            </View>
          ))}
        </Card>
      </Screen>
    );
  }
  if (!data) return <>{header}<ErrorState error={error} onRetry={reload} /></>;

  const items = devState === 'empty' ? [] : data.items;
  if (!items.length) {
    return (
      <Screen scroll refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />} contentStyle={{ justifyContent: 'center', paddingHorizontal: 32 }}>
        {header}
        <View style={{ alignItems: 'center', gap: 10, paddingBottom: 60 }}>
          <View style={s.emptyIco}><Ionicons name="file-tray-outline" size={28} color={palette.ink} /></View>
          <T style={{ fontSize: 22, lineHeight: 28, fontWeight: '700', marginTop: 6 }} center>{t('inb_empty_title')}</T>
          <T style={{ lineHeight: 21 }} color={palette.muted} center>{t('inb_empty_text')}</T>
        </View>
      </Screen>
    );
  }

  const { fresh, seen } = inboxSections(items);
  const remove = async (d: InboxDrawing) => {
    const name = drawingTitle(d);
    if (!(await dialog.confirm({ title: t('inb_delete_q', { name }), text: t('inb_delete_text'), confirmLabel: t('delete'), cancelLabel: t('cancel'), destructive: true }))) return;
    try {
      await api.deleteInboxDrawing(d.id);
      setData({ ...data, items: data.items.filter((x) => x.id !== d.id), total: data.total - 1 });
      toast.show(t('inb_deleted'));
    } catch (e) { showError(e, lang); }
  };
  const row = (d: InboxDrawing, i: number, isNew: boolean) => (
    <View key={d.id}>
      {i ? <Hairline style={{ marginLeft: 20 }} /> : null}
      <Press feedback="row" onPress={() => router.push(`/inbox/${d.id}`)} onLongPress={() => remove(d)} delayLongPress={450}
        accessibilityRole="button" accessibilityLabel={`${drawingTitle(d)}. ${drawingLine(d, lang, t('inb_from_you'))}`}
        accessibilityHint={t('inb_delete')} style={s.row}>
        <DrawingThumb uri={d.preview_url} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T v="rt" numberOfLines={1}>{drawingTitle(d)}</T>
          <T v="rs" numberOfLines={1}>{drawingLine(d, lang, t('inb_from_you'))}</T>
          {d.units_guessed || d.project_id ? (
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
              {d.units_guessed ? <Tag tone="est" label={t('inb_check_dims')} /> : null}
              {d.project_id ? <Tag tone="ok" label={t('inb_has_project')} /> : null}
            </View>
          ) : null}
        </View>
        {isNew ? <View style={s.dot} /> : null}
        <Ionicons name="chevron-forward" size={20} color={palette.chev} />
      </Press>
    </View>
  );

  return (
    <Screen contentStyle={{ paddingTop: 0, gap: 0 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      {header}
      {fresh.length ? <>
        <T style={s.h}>{t('inb_new', { n: fresh.length })}</T>
        <Card padded={false}>{fresh.map((d, i) => row(d, i, true))}</Card>
      </> : null}
      {seen.length ? <>
        <T style={s.h}>{t('inb_seen')}</T>
        <Card padded={false}>{seen.map((d, i) => row(d, i, false))}</Card>
      </> : null}
      <T v="cap" style={{ paddingHorizontal: 8, paddingTop: 12 }}>{t('inb_keep_note')}</T>
    </Screen>
  );
}

const s = StyleSheet.create({
  h: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: palette.muted, paddingTop: 18, paddingHorizontal: 8, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, paddingVertical: 10, paddingHorizontal: 20 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: palette.green },
  emptyIco: { width: 56, height: 56, borderRadius: 18, backgroundColor: palette.segOnWhite, alignItems: 'center', justifyContent: 'center' },
});
