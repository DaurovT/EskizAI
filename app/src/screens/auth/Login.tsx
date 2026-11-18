/**
 * S01 Вход — макеты Login (номер), LoginCode (код из SMS), LoginCodeErr (неверный код).
 * Своя цифровая клавиатура (.kp), длина кода / таймер повтора / попытки — из ответа POST /auth/request-code,
 * «Осталось N попыток» — из detail.attempts_left. После входа → «/» (там решается: /setup или /orders).
 */
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, useWindowDimensions, View } from 'react-native';

import { ApiError, errorText } from '@/api/http';
import type { CodeSent } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { C } from '@/theme';
import { Button, IconButton, Screen, Txt } from '@/ui/kit';
import { Keypad, LangSeg, loginText } from './parts';

const LOGO = require('../../../assets/logo.jpg');
const PHONE_LEN = 9; // после +998

/** «909539988» → «90 953 99 88» (по мере ввода) */
function groupPhone(d: string): string {
  const parts = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean);
  return parts.join(' ');
}
/** +998 90 *** ** 88 */
function maskPhone(d: string): string {
  return `+998 ${d.slice(0, 2)} *** ** ${d.slice(7, 9)}`;
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function Login() {
  const router = useRouter();
  const { requestCode, verifyCode, language, setLanguage } = useAuth();
  const t = loginText(language);
  const { height } = useWindowDimensions();
  const compact = height < 760;

  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<CodeSent | null>(null);
  const [busy, setBusy] = useState(false);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [codeErr, setCodeErr] = useState<{ text: string; wrong: boolean } | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const verifying = useRef(false);

  useEffect(() => {
    if (stage !== 'code') return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [stage]);
  const left = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const length = sent?.length ?? 5;

  async function send() {
    if (busy) return;
    if (phone.length !== PHONE_LEN) { setPhoneErr(t.badPhone); return; }
    setBusy(true); setPhoneErr(null);
    try {
      const r = await requestCode(`+998${phone}`);
      setSent(r); setCode(''); setCodeErr(null);
      setResendAt(Date.now() + r.resend_in * 1000); setNow(Date.now());
      setStage('code');
    } catch (e) {
      // код уже отправлен недавно (429) — сервер сам скажет, через сколько секунд
      if (stage === 'code') setCodeErr({ text: errorText(e), wrong: false });
      else setPhoneErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify(value: string) {
    if (verifying.current || value.length !== length) return;
    verifying.current = true; setBusy(true);
    try {
      await verifyCode(`+998${phone}`, value);
      router.replace('/');
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as { attempts_left?: number } | undefined) : undefined;
      if (d && typeof d.attempts_left === 'number') {
        setCodeErr({ text: d.attempts_left > 0 ? t.wrong(d.attempts_left) : t.noAttempts, wrong: true });
      } else {
        setCodeErr({ text: errorText(e), wrong: false });
      }
    } finally {
      verifying.current = false; setBusy(false);
    }
  }

  function onDigit(k: string) {
    if (stage === 'phone') {
      setPhoneErr(null);
      setPhone((p) => (p.length < PHONE_LEN ? p + k : p));
      return;
    }
    if (busy) return;
    // после ошибки новый ввод начинается с чистых клеток
    const base = codeErr?.wrong ? '' : code;
    if (codeErr) setCodeErr(null);
    if (base.length >= length) return;
    const next = base + k;
    setCode(next);
    if (next.length === length) void verify(next);
  }
  function onErase() {
    if (stage === 'phone') { setPhoneErr(null); setPhone((p) => p.slice(0, -1)); return; }
    if (codeErr) setCodeErr(null);
    setCode((c) => (codeErr?.wrong ? '' : c.slice(0, -1)));
  }
  function onDone() {
    if (stage === 'phone') void send();
    else void verify(code);
  }

  const wrong = !!codeErr?.wrong;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 14, paddingHorizontal: 16, paddingBottom: 4, minHeight: 62 }}>
        {stage === 'code' ? <IconButton name="back" label={t.changePhone} onPress={() => { setStage('phone'); setCode(''); setCodeErr(null); }} /> : null}
        <View style={{ flex: 1 }} />
        <LangSeg value={language} onChange={setLanguage} />
      </View>

      <View style={{ paddingTop: compact ? 8 : 28, paddingHorizontal: 20, gap: compact ? 10 : 18 }}>
        {!compact ? <Image source={LOGO} accessibilityLabel="Eskiz Oyna" style={{ width: 72, height: 72, borderRadius: 18, borderWidth: 0.5, borderColor: 'rgba(33,32,31,0.12)' }} /> : null}
        <View style={{ gap: compact ? 4 : 18 }}>
          <Txt size={30} w={700} style={{ lineHeight: 36, letterSpacing: -0.75 }}>{stage === 'phone' ? t.title : t.codeTitle}</Txt>
          <Txt size={16} color={C.muted} style={{ lineHeight: 22 }}>{stage === 'phone' ? t.sub : t.sentTo(maskPhone(phone))}</Txt>
        </View>
      </View>

      <View style={{ paddingTop: 18, paddingHorizontal: 12, gap: 10 }}>
        {stage === 'phone' ? (
          <>
            <View accessibilityLabel={t.phone} style={{ backgroundColor: phoneErr ? C.dangerBg : C.card, borderRadius: 16, minHeight: 60, paddingVertical: 9, paddingHorizontal: 16, justifyContent: 'center', borderWidth: 2, borderColor: phoneErr ? C.dangerLine : C.accent }}>
              <Txt size={13} color={C.muted} style={{ lineHeight: 17 }}>{t.phone}</Txt>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Txt size={17} w={500} style={{ lineHeight: 23, fontVariant: ['tabular-nums'] }}>{`+998 ${groupPhone(phone)}`}</Txt>
                <View style={{ width: 2, height: 20, backgroundColor: C.accent, marginLeft: 1 }} />
              </View>
            </View>
            <Txt size={14} w={phoneErr ? 500 : 400} color={phoneErr ? '#A1221A' : C.muted} style={{ paddingHorizontal: 8, lineHeight: 19 }}>
              {phoneErr ?? t.capSms(sent?.length ?? 5)}
            </Txt>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {Array.from({ length }, (_, i) => {
                const ch = code[i] ?? '';
                const cur = !wrong && i === code.length;
                return (
                  <View key={i} style={{ flex: 1, height: 60, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: wrong ? C.dangerBg : C.card, borderWidth: 2, borderColor: wrong ? C.dangerLine : cur ? C.accent : 'transparent' }}>
                    <Txt size={26} w={600} style={{ lineHeight: 32, fontVariant: ['tabular-nums'] }}>{ch}</Txt>
                  </View>
                );
              })}
            </View>
            {codeErr ? (
              <Txt size={14} w={500} color="#A1221A" style={{ paddingHorizontal: 8, lineHeight: 19 }}>{codeErr.text}</Txt>
            ) : left > 0 ? (
              <Txt size={14} color={C.muted} style={{ paddingHorizontal: 8, lineHeight: 19 }}>
                {t.resendIn} <Txt size={14} w={700} style={{ fontVariant: ['tabular-nums'] }}>{mmss(left)}</Txt>
              </Txt>
            ) : null}
            {left === 0 ? (
              <Pressable accessibilityRole="button" onPress={() => void send()} disabled={busy} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, alignSelf: 'flex-start' }}>
                <Txt size={16} w={500} color={C.accentText}>{t.resend}</Txt>
              </Pressable>
            ) : null}
          </>
        )}
      </View>

      <View style={{ flex: 1 }} />
      {stage === 'phone' ? (
        <View style={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12 }}>
          <Button title={t.getCode} onPress={() => void send()} loading={busy} disabled={phone.length !== PHONE_LEN} />
        </View>
      ) : null}
      <Keypad onDigit={onDigit} onErase={onErase} onDone={onDone} doneTitle={t.done} eraseTitle={t.erase}
        doneDisabled={busy || (stage === 'phone' ? phone.length !== PHONE_LEN : code.length !== length || wrong)} />
    </Screen>
  );
}
