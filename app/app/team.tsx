/** SCR-23 Сотрудники (владелец): права, ожидающие приглашения (отправлено / устарело), приглашение по номеру. */
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Alert, StyleSheet, View } from 'react-native';
import { api } from '../src/api';
import type { EmployeeOut, InviteOut } from '../src/api/types';
import { useResource } from '../src/hooks/useResource';
import { useT } from '../src/i18n';
import { formatPhone, normalizePhone } from '../src/lib/format';
import { confirm, showError } from '../src/ui/dialogs';
import { useSession } from '../src/state/session';
import { Avatar, Badge, Button, Card, Chip, Field, Gap, Group, Hairline, ListItem, MenuItem, Row, Screen, Sheet, T, Tile, Toggle as Switch } from '../src/ui/kit';
import { palette, space } from '../src/ui/theme';

function Toggle({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Row style={{ minHeight: 52, justifyContent: 'space-between' }}>
      <T v="body" style={{ flex: 1 }}>{label}</T>
      <Switch value={value} onValueChange={onChange} disabled={disabled} accessibilityLabel={label} />
    </Row>
  );
}

/** «+998 93 ••• 44 10» — номер в списке сотрудников (середина скрыта). */
const maskMid = (p: string) => {
  const d = p.replace(/\D/g, '');
  return d.length === 12 ? `+998 ${d.slice(3, 5)} ••• ${d.slice(8, 10)} ${d.slice(10)}` : formatPhone(p);
};

export default function Team() {
  const { t, lang } = useT();
  const employees = useResource(() => api.listEmployees(), []);
  const invites = useResource(() => api.listInvites(), []);
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [inviteMenu, setInviteMenu] = useState<InviteOut | null>(null);
  const { workshop } = useSession();
  const [form, setForm] = useState({ phone: '', name: '', title: '', can_see_cost: false, can_order: false });
  const [busy, setBusy] = useState(false);
  const roles = [t('team_role_measurer'), t('team_role_manager'), t('team_role_installer')];

  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { showError(e, lang); }
    employees.reload();
    invites.reload();
  };

  const setRight = (e: EmployeeOut, patch: Partial<EmployeeOut>) => run(() => api.updateEmployee(e.id, patch));
  const remove = async (e: EmployeeOut) => {
    if (await confirm(t('team_remove_confirm', { name: e.name || formatPhone(e.phone) }), undefined, t('team_remove'), t('cancel'), true)) {
      run(() => api.removeEmployee(e.id));
    }
  };
  const cancelInvite = async (i: InviteOut) => {
    if (await confirm(t('team_cancel_confirm'), undefined, t('team_cancel_invite'), t('cancel'), true)) run(() => api.cancelInvite(i.id));
  };
  const send = async () => {
    const phone = normalizePhone(form.phone);
    if (!phone) return Alert.alert(t('login_bad_phone'));
    setBusy(true);
    try {
      await api.inviteEmployee({ phone, name: form.name.trim(), title: form.title.trim() || null, can_see_cost: form.can_see_cost, can_order: form.can_order });
      setSheet(false);
      setForm({ phone: '', name: '', title: '', can_see_cost: false, can_order: false });
      invites.reload();
    } catch (e) {
      showError(e, lang);
    } finally {
      setBusy(false);
    }
  };

  const list = employees.data ?? [];
  const staff = list.filter((e) => e.role !== 'owner');
  const sel = staff.find((e) => e.id === open) ?? staff[0];
  const first = (e: EmployeeOut) => (e.name || formatPhone(e.phone)).split(/\s+/)[0];

  return (
    <Screen contentStyle={{ paddingTop: 10 }} footer={(
      <>
        <Button icon="add" title={t('profile_invite')} onPress={() => setSheet(true)} />
        {workshop?.plan !== 'pro' ? <T v="cap" center>{t('team_pro_only')}</T> : null}
      </>
    )}>
      <Stack.Screen options={{ title: t('team_title') }} />
      <Card padded={false}>
        {list.map((e, idx) => {
          const owner = e.role === 'owner';
          return (
            <View key={e.id}>
              {idx ? <Hairline /> : null}
              <ListItem
                left={<Avatar name={e.name || '·'} dark={owner} style={owner ? undefined : { backgroundColor: palette.blueSoft }} color={owner ? undefined : palette.blue} />}
                title={e.name || formatPhone(e.phone)}
                subtitle={owner ? t('team_owner_sub') : `${e.title || t('profile_employee')} · ${maskMid(e.phone)}`}
                onPress={owner ? undefined : () => setOpen(e.id)}
                chevron={false}
                style={!owner && sel?.id === e.id && staff.length > 1 ? { backgroundColor: palette.rowPress } : undefined}
              />
            </View>
          );
        })}
        {(invites.data ?? []).map((i) => {
          const expired = i.status === 'expired';
          return (
            <View key={i.id}>
              <Hairline />
              <ListItem
                left={<View style={st.clock}><Ionicons name="time-outline" size={20} color={palette.muted} /></View>}
                title={i.name || maskMid(i.phone)}
                onPress={() => setInviteMenu(i)}
                chevron={false}
              >
                <Badge label={expired ? t('team_invite_expired') : t('team_invite_tg')} tone="amber" style={{ marginTop: 4, alignSelf: 'flex-start' }} />
              </ListItem>
            </View>
          );
        })}
      </Card>

      {sel ? (
        <>
          <T style={st.h3}>{t('team_rights_of', { name: first(sel) })}</T>
          <Card padded={false}>
            <View style={st.r52}><T v="rt" style={{ flex: 1 }}>{t('team_cost')}</T><Switch value={!!sel.can_see_cost} onValueChange={(v) => setRight(sel, { can_see_cost: v })} accessibilityLabel={t('team_cost')} /></View>
            <Hairline />
            <View style={st.r52}><T v="rt" style={{ flex: 1 }}>{t('team_order')}</T><Switch value={!!sel.can_order} onValueChange={(v) => setRight(sel, { can_order: v })} accessibilityLabel={t('team_order')} /></View>
            <Hairline />
            <ListItem compact left={<Tile icon="eye-outline" size="s" bg={palette.greenSoft} color={palette.greenDeep} />} title={t('team_views_of', { name: first(sel) })}
              onPress={() => router.push('/settings/prices')} style={{ minHeight: 52 }} />
            <Hairline />
            <ListItem compact icon="person-remove-outline" danger title={t('team_remove')} chevron={false} onPress={() => remove(sel)} style={{ minHeight: 52 }} />
          </Card>
        </>
      ) : null}

      <Sheet variant="gray" visible={!!inviteMenu} onClose={() => setInviteMenu(null)}>
        <Group>
          <MenuItem icon="refresh-outline" title={t('team_resend')} onPress={() => { const i = inviteMenu!; setInviteMenu(null); run(() => api.resendInvite(i.id)); }} />
          <MenuItem icon="close-outline" red title={t('team_cancel_invite')} onPress={() => { const i = inviteMenu!; setInviteMenu(null); cancelInvite(i); }} />
        </Group>
        <Button v="secondary" title={t('close')} onPress={() => setInviteMenu(null)} />
      </Sheet>

      <Sheet visible={sheet} onClose={() => setSheet(false)} title={t('profile_invite')}>
        <Field label={t('profile_invite_phone')} value={form.phone} onChangeText={(v) => setForm({ ...form, phone: v })} keyboardType="phone-pad" placeholder="+998 90 123 45 67" />
        <Field label={t('client_name')} value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} />
        <Field label={t('team_role')} value={form.title} onChangeText={(v) => setForm({ ...form, title: v })} placeholder={t('team_role_ph')} />
        <Row style={{ flexWrap: 'wrap', marginTop: -space.s, marginBottom: space.m }}>
          {roles.map((r) => <Chip key={r} label={r} selected={form.title === r} onPress={() => setForm({ ...form, title: r })} />)}
        </Row>
        <Toggle label={t('team_cost')} value={form.can_see_cost} onChange={(v) => setForm({ ...form, can_see_cost: v })} />
        <Toggle label={t('team_order')} value={form.can_order} onChange={(v) => setForm({ ...form, can_order: v })} />
        <T v="caption" style={{ marginVertical: space.s }}>{t('team_invite_hint')}</T>
        <Gap h={space.s} />
        <Button title={t('team_invite_send')} loading={busy} onPress={send} />
      </Sheet>
    </Screen>
  );
}

const st = StyleSheet.create({
  h3: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3, paddingTop: 8, paddingHorizontal: 8 },
  r52: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingVertical: 10, paddingHorizontal: 20 },
  clock: { width: 44, height: 44, borderRadius: 22, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
});
