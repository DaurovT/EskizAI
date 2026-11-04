/**
 * Настройки уведомлений (FR-66, Misc.dc.html «Уведомл.»): переключатели по типам событий и «Тихие часы · без звука
 * 22:00–08:00 · Вкл». Сохраняется сразу; при ошибке переключатель возвращается.
 */
import { Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { api } from '../../src/api';
import type { NotificationSettingsIn, NotificationSettingsOut } from '../../src/api/types';
import { useResource } from '../../src/hooks/useResource';
import { useT } from '../../src/i18n';
import { showError } from '../../src/ui/dialogs';
import { ErrorState } from '../../src/ui/ErrorState';
import { Badge, Card, Hairline, Loading, Press, Screen, T, Toggle } from '../../src/ui/kit';

export default function NotificationSettings() {
  const { t, lang } = useT();
  const { data, setData, error, loading, reload } = useResource(() => api.getNotificationSettings(), []);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;

  // оптимистично: сразу на экране, ответ сервера — источник правды
  const save = async (next: NotificationSettingsOut, body: NotificationSettingsIn) => {
    const prev = data;
    setData(next);
    try { setData(await api.updateNotificationSettings(body)); } catch (e) { setData(prev); showError(e, lang); }
  };
  const toggleType = (key: string, enabled: boolean) =>
    save({ ...data, types: data.types.map((x) => (x.key === key ? { ...x, enabled } : x)) }, { types: { [key]: enabled } });
  const q = data.quiet;
  const toggleQuiet = () => save({ ...data, quiet: { ...q, enabled: !q.enabled } }, { quiet: { enabled: !q.enabled } });

  return (
    <Screen contentStyle={{ paddingTop: 8, gap: 12 }}>
      <Stack.Screen options={{ title: t('nt_title') }} />
      <Card padded={false}>
        {data.types.map((x, i) => (
          <View key={x.key}>
            {i ? <Hairline /> : null}
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <T v="rt">{x.title}</T>
                <T v="rs">{x.subtitle}</T>
              </View>
              <Toggle value={x.enabled} onValueChange={(v) => toggleType(x.key, v)} accessibilityLabel={x.title} />
            </View>
          </View>
        ))}
        <Hairline />
        <Press feedback="row" onPress={toggleQuiet} style={s.row} accessibilityRole="switch" accessibilityState={{ checked: q.enabled }}
          accessibilityLabel={`${t('nts_quiet')}, ${t('nts_quiet_sub', { from: q.from, to: q.to })}`}>
          <View style={{ flex: 1 }}>
            <T v="rt">{t('nts_quiet')}</T>
            <T v="rs">{t('nts_quiet_sub', { from: q.from, to: q.to })}</T>
          </View>
          <Badge tone={q.enabled ? 'green' : 'gray'} label={q.enabled ? t('nts_on') : t('nts_off')} />
        </Press>
      </Card>
      <T v="cap" style={{ paddingHorizontal: 8 }}>{t('nts_note')}</T>
    </Screen>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 58, paddingVertical: 10, paddingHorizontal: 20 },
});
