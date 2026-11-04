/** SCR-38a Приглашение в цех: принять / отклонить; устаревшее — написать владельцу или войти с другим номером. */
import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { api } from '../src/api';
import type { InviteOut } from '../src/api/types';
import { useT } from '../src/i18n';
import { useSession } from '../src/state/session';
import { showError } from '../src/ui/dialogs';
import { Badge, Button, Card, Hairline, ListItem, Loading, Screen, T, Tile } from '../src/ui/kit';
import { palette } from '../src/ui/theme';

const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '•';

/** .li — право: зелёная галочка или красный крестик в плашке 28 r9. */
function Right({ ok, label }: { ok: boolean; label: string }) {
  return (
    <View style={st.li} accessibilityLabel={`${ok ? '✓' : '✕'} ${label}`}>
      <View style={[st.mk, { backgroundColor: ok ? palette.greenSoft : palette.redSoft }]}>
        <Ionicons name={ok ? 'checkmark' : 'close'} size={16} color={ok ? palette.greenDeep : palette.redText} />
      </View>
      <T style={st.liText}>{label}</T>
    </View>
  );
}

/** Telegram по номеру (t.me/+998…), без Telegram — звонок. */
function writeOwner(inv: InviteOut) {
  const phone = inv.owner.phone?.replace(/[^\d+]/g, '');
  if (!phone) return;
  Linking.openURL(`https://t.me/${phone}`).catch(() => Linking.openURL(`tel:${phone}`).catch(() => undefined));
}

export default function Invite() {
  const { t, td, lang } = useT();
  const { invite, setInvite, signIn, signOut, user } = useSession();
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);

  if (!invite) return <Loading />;
  const expired = invite.status === 'expired';
  const w = invite.workshop;
  const views = invite.estimate_views.map((v) => `«${td(`view_${v}`, v)}»`).join(', ');

  const accept = async () => {
    setBusy('accept');
    try {
      await signIn(await api.acceptInvite(invite.id));
    } catch (e) {
      showError(e, lang);
      // устарело, пока смотрели — обновим экран
      api.myInvite().then(setInvite).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };
  const decline = async () => {
    setBusy('decline');
    try {
      await api.declineInvite(invite.id);
      setInvite(null); // дальше — обычный онбординг своего цеха
    } catch (e) {
      showError(e, lang);
    } finally {
      setBusy(null);
    }
  };

  const footer = expired ? (
    <>
      {invite.owner.phone ? <Button icon="paper-plane-outline" title={t('inv_write_owner')} onPress={() => writeOwner(invite)} /> : null}
      <Button v="ghost" color={palette.ink} title={t('inv_other_number')} onPress={() => signOut()} />
      <Button v="ghost" title={t('inv_continue_own')} loading={busy === 'decline'} onPress={decline} />
    </>
  ) : (
    <>
      <Button title={t('inv_accept')} loading={busy === 'accept'} disabled={!!busy} onPress={accept} />
      <Button v="ghost" color={palette.ink} title={t('inv_decline')} loading={busy === 'decline'} disabled={!!busy} onPress={decline} />
    </>
  );

  return (
    <Screen edges={['top', 'bottom']} footer={footer} contentStyle={expired ? { flexGrow: 1, justifyContent: 'center', alignItems: 'center', gap: 14 } : { paddingTop: 4 }}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      {expired ? (
        <>
          <View style={st.clock}><Ionicons name="time-outline" size={34} color={palette.amberDeep} /></View>
          <T style={[st.ttl, { fontSize: 26, lineHeight: 32 }]} center>{t('inv_expired_title')}</T>
          <T v="cap" center style={{ fontSize: 15, lineHeight: 21, maxWidth: 300 }}>{t('inv_expired_text', { name: w.name })}</T>
        </>
      ) : (
        <>
          <View style={{ height: 62 }} />
          <View style={st.hero}>
            <View style={st.avatars} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <View style={[st.av, { left: -4, backgroundColor: palette.ink }]}><T style={st.avText} color={palette.white}>{initials(w.name)}</T></View>
              <View style={[st.av, { right: -4, backgroundColor: palette.blueSoft }]}><T style={st.avText} color={palette.blue}>{initials(user?.name || invite.name || '')}</T></View>
            </View>
            <T style={st.ttl} center>{t('inv_title', { name: w.name })}</T>
            <T v="cap" center style={{ fontSize: 15, lineHeight: 21 }}>
              {invite.owner.name ? t('inv_owner', { name: invite.owner.name, city: w.city }) : t('inv_owner_noname', { city: w.city })}
            </T>
          </View>
          <Card padded={false}>
            <ListItem left={<Tile icon="resize-outline" size="s" />} title={t('inv_role')} right={<Badge label={invite.title || t('profile_employee')} tone="blue" style={{ alignSelf: 'center' }} />} style={{ minHeight: 56 }} />
          </Card>
          <T style={st.sh}>{t('inv_rights')}</T>
          <Card padded={false}>
            {[
              { ok: true, l: t('inv_r_3d') }, { ok: true, l: t('inv_r_measure') }, { ok: true, l: t('inv_r_send', { views }) },
              { ok: invite.can_see_cost, l: t('inv_r_cost') }, { ok: invite.can_order, l: t('inv_r_order') },
            ].map((r, i) => <View key={r.l}>{i ? <Hairline /> : null}<Right ok={r.ok} label={r.l} /></View>)}
          </Card>
        </>
      )}
    </Screen>
  );
}

const st = StyleSheet.create({
  hero: { alignItems: 'center', gap: 10, paddingTop: 4, paddingHorizontal: 8, paddingBottom: 6 },
  avatars: { width: 116, height: 72 },
  // 64 + кольцо 4 цвета фона (box-shadow 0 0 0 4px #F2F1EE)
  av: { position: 'absolute', top: 0, width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', borderWidth: 4, borderColor: palette.ground },
  avText: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  ttl: { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.75 },
  sh: { fontSize: 18, lineHeight: 24, fontWeight: '700', letterSpacing: -0.27, paddingTop: 4, paddingHorizontal: 8 },
  li: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46, paddingVertical: 6, paddingHorizontal: 20 },
  mk: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  liText: { flex: 1, fontSize: 15, lineHeight: 20 },
  clock: { width: 72, height: 72, borderRadius: 36, backgroundColor: palette.amberSoft, alignItems: 'center', justifyContent: 'center' },
});
