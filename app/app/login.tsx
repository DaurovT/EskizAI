/**
 * SCR-01 Вход (Login.dc.html) → SCR-01b Код (Code.dc.html): телефон → код из 5 цифр (Telegram / SMS).
 * Язык — переключатель в шапке. Повтор кода — по таймеру из ответа сервера.
 */
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../src/api';
import { isApiError } from '../src/api/errors';
import { MOCK, SHOTS_MODE, TERMS_URL } from '../src/config';
import { useT } from '../src/i18n';
import { deviceId, savedPushToken } from '../src/services/push';
import { useSession } from '../src/state/session';
import { maskPhone, normalizePhone } from '../src/lib/format';
import { Banner, Button, Footer, Group, IconButton, ListItem, T, Tile, resolveFont } from '../src/ui/kit';
import { Carcass } from '../src/ui/Illus';
import { LangSwitch } from '../src/ui/LangSwitch';
import { palette, type as ty } from '../src/ui/theme';

/** 901234567 → «90 123 45 67». */
const groupPhone = (d: string) => [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean).join(' ');
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function Login() {
  const { t, lang } = useT();
  const { signIn } = useSession();
  const [digits, setDigits] = useState(''); // 9 цифр после +998
  const [focused, setFocused] = useState(false);
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [code, setCode] = useState('');
  const [codeLen, setCodeLen] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeErr, setCodeErr] = useState<{ left: number | null; text: string } | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const phoneRef = useRef<TextInputInstance>(null);
  const codeRef = useRef<TextInputInstance>(null);
  const normalized = normalizePhone(digits);

  // dev: /login?dev=code[&code=48172&left=2] — экран кода (и ошибки) для сверки с макетом без ввода
  const dev = useLocalSearchParams<{ dev?: string; code?: string; left?: string }>();
  useEffect(() => {
    if (!__DEV__ || dev.dev !== 'code') return;
    setDigits('909531234'); setStep('code'); setResendIn(42);
    if (dev.code) { setCode(dev.code); setCodeErr({ left: dev.left ? Number(dev.left) : null, text: t('code_wrong') }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dev.dev, dev.code, dev.left]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const id = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [resendIn]);

  const request = async (channel: 'telegram' | 'sms' = 'telegram') => {
    if (!normalized) return setError(t('login_bad_phone'));
    setBusy(true);
    setError(null);
    try {
      const r = await api.requestCode(normalized, channel);
      setResendIn(r.resend_in || 60);
      setCodeLen(r.code_length ?? 5);
      setStep('code');
      setTimeout(() => codeRef.current?.focus(), 300);
    } catch (e) {
      if (isApiError(e) && e.code === 'code_too_often') {
        setResendIn(Number((e.details as { resend_in?: number })?.resend_in ?? 60));
        setStep('code');
      } else setError(isApiError(e) ? e.message : t('err_generic_text'));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value = code) => {
    if (!normalized || value.length < codeLen) return;
    setBusy(true);
    setCodeErr(null);
    try {
      const tk = await api.verifyCode({
        phone: normalized, code: value, device_id: await deviceId(),
        platform: Platform.OS === 'ios' ? 'ios' : 'android', push_token: await savedPushToken(),
      });
      await signIn(tk);
      if (tk.user.language !== lang) api.updateMe({ language: lang }).catch(() => undefined);
    } catch (e) {
      const left = isApiError(e) ? (e.details as { attempts_left?: number } | undefined)?.attempts_left : undefined;
      if (isApiError(e) && e.code === 'code_invalid') setCodeErr({ left: typeof left === 'number' ? left : null, text: t('code_wrong') });
      else setCodeErr({ left: null, text: isApiError(e) ? e.message : t('err_generic_text') });
    } finally {
      setBusy(false);
    }
  };

  if (step === 'code') {
    const leftText = (n: number) => {
      const m10 = n % 10, m100 = n % 100;
      const k = m10 === 1 && m100 !== 11 ? 'code_left_one' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'code_left_few' : 'code_left_many';
      return t(k, { n });
    };
    const sub = t('code_sub_pre', { n: codeLen });
    return (
      <SafeAreaView style={s.root} edges={['top']}>
        <View style={s.hdr}>
          <IconButton icon="chevron-back" label={t('back')} onPress={() => { setStep('phone'); setCode(''); setCodeErr(null); }} />
        </View>
        <View style={[s.body, { gap: 16 }]}>
          <View style={{ paddingHorizontal: 8 }}>
            <T v="big">{t('code_title')}</T>
            <Text style={resolveFont([ty.sub, { marginTop: 8 }])}>
              {sub}
              <Text style={resolveFont([ty.sub, ty.num, { color: palette.ink, fontWeight: '600' }])}>{maskPhone(normalized)}</Text>
              {t('code_sub_post')}
            </Text>
          </View>
          <Pressable onPress={() => codeRef.current?.focus()} accessibilityLabel={t('code_cells', { n: codeLen })} style={s.cells}>
            {Array.from({ length: codeLen }, (_, k) => {
              const err = !!codeErr && code.length === codeLen;
              const focus = !err && (k === code.length || (k === codeLen - 1 && code.length === codeLen));
              return (
                <View key={k} style={[s.cell, focus && s.cellFocus, err && s.cellErr]}>
                  <Text style={resolveFont([s.cellText, err && { color: palette.redDeep }])}>{code[k] ?? ''}</Text>
                </View>
              );
            })}
            <TextInput
              ref={codeRef}
              value={code}
              onChangeText={(v) => {
                const d = v.replace(/\D/g, '').slice(0, codeLen);
                setCode(d);
                setCodeErr(null);
                if (d.length === codeLen) verify(d);
              }}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="sms-otp"
              maxLength={codeLen}
              caretHidden
              style={s.hiddenInput}
              accessibilityLabel={t('code_cells', { n: codeLen })}
            />
          </Pressable>
          {codeErr ? (
            <Banner tone="err" icon="warning-outline" title={codeErr.text} text={codeErr.left != null ? leftText(codeErr.left) : undefined} style={{ alignItems: 'center' }} />
          ) : null}
          <Group>
            <ListItem
              left={<Tile icon="time-outline" style={{ width: 40, height: 40 }} />}
              title={t('code_resend')}
              right={resendIn > 0 ? <T v="rs" num style={{ color: palette.ink, fontWeight: '600' }}>{t('code_resend_in', { t: mmss(resendIn) })}</T> : undefined}
              onPress={resendIn > 0 ? undefined : () => request('telegram')}
            />
            {resendIn <= 0 ? (
              <ListItem left={<Tile icon="chatbubble-outline" style={{ width: 40, height: 40 }} />} title={t('login_via_sms')} onPress={() => request('sms')} />
            ) : null}
          </Group>
          {MOCK && !SHOTS_MODE ? <T v="cap" center>{t('login_dev_hint')}</T> : null}
        </View>
        <Footer>
          <Button title={t('code_confirm')} onPress={() => verify()} loading={busy} disabled={code.length < codeLen} />
          <Button v="ghost" title={t('code_change')} onPress={() => { setStep('phone'); setCode(''); setCodeErr(null); }} />
        </Footer>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <Pressable style={{ flex: 1 }} onPress={Keyboard.dismiss} accessible={false}>
        <View style={s.hdr}>
          <View style={s.logo} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={s.logoBar} /><View style={s.logoBar} />
          </View>
          <View style={{ flex: 1 }} />
          <LangSwitch />
        </View>
        <View style={s.body}>
          <View style={s.hero} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={s.heroTags}>
              <View style={s.heroTag}><T style={s.heroTagText} color={palette.greenDeep}>{t('login_hero_1')}</T></View>
              <View style={s.heroTag}><T style={s.heroTagText} color={palette.muted2}>{t('login_hero_2')}</T></View>
              <View style={s.heroTag}><T style={s.heroTagText} color={palette.muted2}>{t('login_hero_3')}</T></View>
            </View>
            <Carcass w={120} h={150} r={40} b={3} style={{ marginLeft: 110, marginBottom: -6 }} />
          </View>
          <View style={{ paddingTop: 10, paddingHorizontal: 8, paddingBottom: 4 }}>
            <T style={s.h}>{t('login_h')}</T>
            <T v="sub" style={{ marginTop: 8 }}>{t('login_sub')}</T>
          </View>
          <Pressable onPress={() => phoneRef.current?.focus()} style={[s.fld, focused && s.fldFocus, !!error && s.fldErr]}>
            <T v="fl">{t('login_phone')}</T>
            <View style={s.phoneRow}>
              <Text style={resolveFont(s.phone)}>+998</Text>
              <TextInput
                ref={phoneRef}
                value={groupPhone(digits)}
                onChangeText={(v) => { setDigits(v.replace(/\D/g, '').replace(/^998(?=\d{9})/, '').slice(0, 9)); setError(null); }}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={focused ? '' : t('login_phone_ph')}
                placeholderTextColor={palette.faint}
                keyboardType="phone-pad"
                autoComplete="tel"
                textContentType="telephoneNumber"
                selectionColor={palette.ink}
                style={[resolveFont(s.phone), s.phoneInput]}
                onSubmitEditing={() => request()}
                accessibilityLabel={t('login_phone')}
              />
            </View>
          </Pressable>
          {error ? <T v="cap" color={palette.redText} style={{ paddingHorizontal: 8 }}>{error}</T> : null}
        </View>
      </Pressable>
      <Footer>
        <Button title={t('login_get_code')} onPress={() => request()} loading={busy} disabled={!normalized} />
        <Text style={resolveFont([ty.cap, { textAlign: 'center' }])}>
          {t('login_terms_pre')}
          <Text
            style={resolveFont([ty.cap, { color: palette.greenPress, fontWeight: '600' }])}
            onPress={TERMS_URL ? () => Linking.openURL(TERMS_URL).catch(() => undefined) : undefined}
            accessibilityRole={TERMS_URL ? 'link' : undefined}
          >{t('login_terms')}</Text>
        </Text>
      </Footer>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.ground },
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 14, paddingHorizontal: 12, paddingBottom: 4, minHeight: 74 }, // .hdr: min-height 56 + отступы 14/4
  body: { flex: 1, padding: 12, gap: 10 },
  logo: { width: 56, height: 56, borderRadius: 18, backgroundColor: palette.green, padding: 12, flexDirection: 'row', gap: 3 },
  logoBar: { flex: 1, backgroundColor: palette.ground, borderRadius: 2 },
  hero: { height: 200, borderRadius: 28, backgroundColor: palette.wood, overflow: 'hidden', alignItems: 'center', justifyContent: 'flex-end' },
  heroTags: { position: 'absolute', left: 20, top: 20, gap: 8, alignItems: 'stretch' },
  heroTag: { height: 26, paddingHorizontal: 10, borderRadius: 9, backgroundColor: palette.white, justifyContent: 'center' },
  heroTagText: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  h: { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.75 },
  fld: { minHeight: 76, paddingVertical: 10, paddingHorizontal: 20, borderRadius: 20, backgroundColor: palette.white, justifyContent: 'center', gap: 2 },
  fldFocus: { borderWidth: 2, borderColor: palette.ink, paddingVertical: 8, paddingHorizontal: 18 },
  fldErr: { borderWidth: 2, borderColor: palette.red, backgroundColor: '#FFF5F4', paddingVertical: 8, paddingHorizontal: 18 },
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  phone: { fontSize: 24, lineHeight: 30, fontWeight: '600', color: palette.ink, fontVariant: ['tabular-nums'] },
  phoneInput: { flex: 1, padding: 0, margin: 0, height: 30 },
  cells: { flexDirection: 'row', gap: 8 },
  cell: { flex: 1, height: 72, borderRadius: 20, backgroundColor: palette.white, borderWidth: 1, borderColor: '#E1DFDB', alignItems: 'center', justifyContent: 'center' },
  cellFocus: { borderWidth: 2, borderColor: palette.ink },
  cellErr: { borderWidth: 2, borderColor: palette.red, backgroundColor: '#FFF5F4' },
  cellText: { fontSize: 30, lineHeight: 36, fontWeight: '600', color: palette.ink, fontVariant: ['tabular-nums'] },
  hiddenInput: { position: 'absolute', opacity: 0, width: 1, height: 1 },
});
