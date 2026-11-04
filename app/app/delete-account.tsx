/** SCR-44 Удаление аккаунта: что удалится и что нет → код из SMS → «Аккаунт удалён» → экран входа. */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router } from 'expo-router';
import { useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';
import { api } from '../src/api';
import { isApiError } from '../src/api/errors';
import { useT } from '../src/i18n';
import { maskPhone } from '../src/lib/format';
import { useSession } from '../src/state/session';
import { showError } from '../src/ui/dialogs';
import { Button, Card, Dialog, Hairline, Screen, T, Tile, resolveFont, type IconName } from '../src/ui/kit';
import { palette, type as ty } from '../src/ui/theme';

/** .li — пункт с плиткой 36 r12: красной (удалим) или серой (не затронет). */
function Item({ ok, icon, title, sub }: { ok: boolean; icon: IconName; title: string; sub: string }) {
  return (
    <View style={st.li}>
      <Tile icon={icon} size="s" bg={ok ? undefined : palette.redSoft} color={ok ? undefined : palette.redText} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <T v="rt">{title}</T>
        <T v="rs" style={{ marginTop: 1 }}>{sub}</T>
      </View>
    </View>
  );
}
const List = ({ children }: { children: ReactNode[] }) => (
  <Card padded={false}>{children.filter(Boolean).map((c, i) => <View key={i}>{i ? <Hairline /> : null}{c}</View>)}</Card>
);

export default function DeleteAccount() {
  const { t, lang } = useT();
  const { user, workshop, isOwner, signOut } = useSession();
  const [step, setStep] = useState<'info' | 'code' | 'done'>('info');
  const [code, setCode] = useState('');
  const [len, setLen] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<TextInputInstance>(null);
  // «Отправили код на {phone}. …» — номер жирным посреди текста
  const codeText = t('del_code_sent', { phone: '\u0000' }).split('\u0000');

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.requestDeleteCode('sms');
      setLen(r.code_length ?? 5);
      setCode('');
      setStep('code');
      setTimeout(() => input.current?.focus(), 300);
    } catch (e) {
      // код уже отправлен недавно — просто открываем ввод
      if (isApiError(e) && e.code === 'code_too_often') setStep('code');
      else showError(e, lang);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (code.length < len) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(code);
      setStep('done');
    } catch (e) {
      setError(isApiError(e) ? e.message : t('err_generic_text'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'done') {
    return (
      <Screen edges={['top', 'bottom']} footer={<Button title={t('del_to_login')} onPress={() => signOut({ local: true })} />}
        contentStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }}>
        <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
        <View style={st.doneIco}><Ionicons name="checkmark" size={34} color={palette.ink} /></View>
        <T style={st.doneTitle} center>{t('del_done_title')}</T>
        <T v="cap" center style={{ fontSize: 15, lineHeight: 21, maxWidth: 300 }}>{isOwner ? t('del_done_text') : t('del_done_text_employee')}</T>
      </Screen>
    );
  }

  return (
    <Screen contentStyle={{ paddingTop: 0, gap: 8 }} footer={(
      <>
        <Button v="danger" title={t('del_button')} loading={busy && step === 'info'} onPress={ask} />
        <Button v="ghost" color={palette.ink} title={t('cancel')} onPress={() => router.back()} />
      </>
    )}>
      <Stack.Screen options={{ title: '' }} />
      <T v="big" style={{ paddingHorizontal: 8 }}>{t('del_title')}</T>
      <T v="cap" style={{ paddingHorizontal: 8, fontSize: 15, lineHeight: 21 }}>{isOwner ? t('del_intro', { name: workshop?.name || '—' }) : t('del_intro_employee')}</T>
      <T style={st.sh}>{t('del_will')}</T>
      {isOwner ? (
        <List>{[
          <Item key="ws" ok={false} icon="trash-outline" title={t('del_ws')} sub={t('del_ws_sub')} />,
          <Item key="pr" ok={false} icon="folder-outline" title={t('del_projects')} sub={t('del_projects_sub')} />,
        ]}</List>
      ) : <List>{[<Item key="me" ok={false} icon="trash-outline" title={t('del_me')} sub={t('del_me_sub')} />]}</List>}
      {isOwner ? (
        <>
          <T style={st.sh}>{t('del_wont')}</T>
          <List>{[
            <Item key="o" ok icon="cube-outline" title={t('del_orders')} sub={t('del_orders_sub')} />,
            <Item key="p" ok icon="card-outline" title={t('del_pro')} sub={t('del_pro_sub')} />,
            <Item key="r" ok icon="document-outline" title={t('del_receipts')} sub={t('del_receipts_sub')} />,
          ]}</List>
        </>
      ) : null}

      <Dialog visible={step === 'code'} onClose={() => !busy && setStep('info')} title={t('del_confirm_title')}
        actions={(
          <View style={{ flex: 1, gap: 8 }}>
            <Button v="danger" title={t('del_confirm_button')} loading={busy} disabled={code.length < len} onPress={confirmDelete} />
            <Button v="secondary" title={t('cancel')} onPress={() => setStep('info')} disabled={busy} />
          </View>
        )}>
        <Text style={resolveFont([ty.cap, { fontSize: 15, lineHeight: 21 }])}>
          {codeText[0]}<Text style={resolveFont([ty.cap, ty.num, { fontSize: 15, color: palette.ink, fontWeight: '600' }])}>{maskPhone(user?.phone)}</Text>{codeText[1] ?? ''}
        </Text>
        {/* ячейки кода поверх одного поля ввода */}
        <Pressable onPress={() => input.current?.focus()} style={st.cells} accessibilityLabel={t('login_code')}>
          {Array.from({ length: len }, (_, i) => (
            <View key={i} style={[st.cell, i === code.length && st.cellF, !!error && st.cellErr]}>
              <Text style={resolveFont([st.cellText, !!error && { color: palette.redDeep }])}>{code[i] ?? ''}</Text>
            </View>
          ))}
          <TextInput
            ref={input}
            value={code}
            onChangeText={(v) => { setCode(v.replace(/\D/g, '').slice(0, len)); setError(null); }}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="sms-otp"
            maxLength={len}
            caretHidden
            accessibilityLabel={t('login_code')}
            style={st.hidden}
          />
        </Pressable>
        {error ? <T v="cap" center color={palette.redText}>{error}</T> : null}
        <Button v="ghost" title={t('del_resend')} onPress={ask} disabled={busy} />
      </Dialog>
    </Screen>
  );
}

const st = StyleSheet.create({
  sh: { fontSize: 18, lineHeight: 24, fontWeight: '700', letterSpacing: -0.27, paddingTop: 4, paddingHorizontal: 8 },
  li: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 10, paddingHorizontal: 20 },
  cells: { flexDirection: 'row', gap: 8 },
  cell: { flex: 1, height: 60, borderRadius: 16, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  cellF: { backgroundColor: palette.white, borderWidth: 2, borderColor: palette.ink },
  cellErr: { backgroundColor: '#FFF5F4', borderWidth: 2, borderColor: palette.red },
  cellText: { fontSize: 26, lineHeight: 32, fontWeight: '600', color: palette.ink, fontVariant: ['tabular-nums'] },
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  doneIco: { width: 72, height: 72, borderRadius: 36, backgroundColor: palette.segOnWhite, alignItems: 'center', justifyContent: 'center' },
  doneTitle: { fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.52 },
});
