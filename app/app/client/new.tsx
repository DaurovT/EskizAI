/** SCR-33 «Новый клиент» (ClientCard.dc.html, вкладка «Новый клиент»). ?pick=projectId — сразу привязать к проекту. */
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { api } from '../../src/api';
import { useT } from '../../src/i18n';
import { normalizePhone } from '../../src/lib/format';
import { showError } from '../../src/ui/dialogs';
import { Button, Field, Screen, T } from '../../src/ui/kit';

export default function NewClient() {
  const { t, lang } = useT();
  const { pick } = useLocalSearchParams<{ pick?: string }>();
  const [f, setF] = useState({ name: '', phone: '+998 ', address: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ name?: string; phone?: string }>({});
  const set = (k: keyof typeof f) => (v: string) => { setF((x) => ({ ...x, [k]: v })); setErr((e) => ({ ...e, [k]: undefined })); };

  const save = async () => {
    const phone = normalizePhone(f.phone);
    const e = { name: f.name.trim() ? undefined : t('client_name_required'), phone: phone ? undefined : t('cn_phone_required') };
    if (e.name || e.phone) return setErr(e);
    setBusy(true);
    try {
      const c = await api.createClient({ name: f.name.trim(), phone, address: f.address.trim() || null, notes: f.notes.trim() || null });
      if (pick) {
        await api.updateProject(pick, { client_id: c.id });
        router.back();
      } else router.replace(`/client/${c.id}`);
    } catch (ex) {
      showError(ex, lang);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen contentStyle={{ paddingTop: 10 }} footer={<Button title={t('cn_save')} onPress={save} loading={busy} />}>
      <Stack.Screen options={{ title: '' }} />
      <T v="bigPush" style={{ paddingHorizontal: 8, paddingBottom: 6 }}>{t('client_new')}</T>
      <Field label={t('cn_name')} placeholder={t('cn_name_ph')} value={f.name} onChangeText={set('name')} error={err.name} autoFocus autoCapitalize="words" />
      <Field label={t('cn_phone')} value={f.phone} onChangeText={set('phone')} error={err.phone} keyboardType="phone-pad" style={{ fontVariant: ['tabular-nums'] }} />
      <Field label={t('client_address')} placeholder={t('cn_address_ph')} value={f.address} onChangeText={set('address')} />
      <Field label={t('cn_note')} placeholder={t('cn_note_ph')} value={f.notes} onChangeText={set('notes')} />
      <T v="cap" style={{ paddingVertical: 2, paddingHorizontal: 8 }}>{t('cn_privacy')}</T>
    </Screen>
  );
}
