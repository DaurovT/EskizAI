/**
 * Просьбы клиента «Хочу изменить…» со страницы ссылки (web /p/…): список, «Поручить ИИ» (правка модели словами),
 * связаться с клиентом. Сюда ведёт push client_change_request.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, View } from 'react-native';
import { api } from '../../../src/api';
import type { EditOut } from '../../../src/api/types';
import { useAiTask } from '../../../src/hooks/useAiTask';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatDate } from '../../../src/lib/format';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Button, ButtonRow, Card, EmptyState, Loading, Screen, T } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

export default function ClientRequests() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useT();
  const list = useResource(() => api.listClientRequests(id), [id]);
  const card = useResource(() => api.getProject(id), [id]);
  const ai = useAiTask();
  const [busy, setBusy] = useState<string | null>(null);
  if (list.loading && !list.data) return <Loading />;
  if (!list.data) return <ErrorState error={list.error} onRetry={list.reload} />;
  const phone = card.data?.client?.phone ?? null;
  const clientName = card.data?.client?.name ?? null;

  const toAi = async (rid: string, text: string) => {
    setBusy(rid);
    try {
      const r = await ai.run<EditOut>((c) => api.aiEdit(id, `${t('cr_ai_prefix')}: ${text}`, c));
      if (r && !r.ok && (r.question || r.error)) showError(new Error(r.question ?? r.error ?? ''), lang);
      else router.push(`/project/${id}/editor`);
    } catch (e) { showError(e, lang); } finally { setBusy(null); }
  };

  return (
    <Screen gap={10} footer={phone ? (
      <ButtonRow>
        <Button v="secondary" title={t('cr_call')} onPress={() => Linking.openURL(`tel:${phone}`)} style={{ flex: 1 }} />
        <Button v="secondary" title="Telegram" onPress={() => Linking.openURL(`https://t.me/${phone.replace(/[^\d+]/g, '')}`)} style={{ flex: 1 }} />
      </ButtonRow>
    ) : undefined}>
      <Stack.Screen options={{ title: t('cr_title') }} />
      {!list.data.length ? (
        <EmptyState icon="chatbubble-ellipses-outline" title={t('cr_empty')} text={t('cr_empty_note')} />
      ) : (
        <>
          <T v="cap" style={{ paddingHorizontal: 8 }}>{clientName ? t('cr_from', { name: clientName }) : t('cr_from_client')}</T>
          {list.data.map((r) => (
            <Card key={r.id} style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="chatbubble-ellipses-outline" size={18} color={palette.muted} />
                <T v="cap">{formatDate(r.created_at, lang)}</T>
              </View>
              <T v="rt">{r.text}</T>
              <Button v="secondary" title={t('cr_to_ai')} loading={busy === r.id && ai.running} disabled={!!busy} onPress={() => toAi(r.id, r.text)} />
            </Card>
          ))}
          <T v="cap" style={{ paddingHorizontal: 8 }}>{t('cr_note')}</T>
        </>
      )}
    </Screen>
  );
}
