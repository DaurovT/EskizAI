import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Linking, View } from 'react-native';
import { router } from 'expo-router';
import { useT } from '../i18n';
import { errorInfo } from './dialogs';
import { Button, EmptyState, Screen, T, type IconName } from './kit';
import { palette, tones, type Tone } from './theme';
import { SUPPORT_TG } from '../config';

const ICONS: Record<string, IconName> = {
  offline: 'cloud-offline-outline', timeout: 'time-outline', ai: 'sparkles-outline', rebuild: 'construct-outline',
  limit: 'wallet-outline', session: 'log-in-outline', not_found: 'search-outline', generic: 'alert-circle-outline', bad_photo: 'image-outline',
};
/** Цвет плитки по Errors.dc.html: нет сети — серый, фото/ИИ/лимит — янтарный, долго — синий, правка не прошла — красный. */
const TONES: Record<string, Tone> = {
  offline: 'gray', session: 'gray', not_found: 'gray', bad_photo: 'amber', ai: 'amber', limit: 'amber', timeout: 'blue', rebuild: 'red', generic: 'red',
};

/** SCR-28: у каждой ошибки — причина и 1–3 выхода (.cta / .soft / .txt), плюс поддержка в Telegram. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, lang } = useT();
  const info = errorInfo(error, lang);
  return (
    <EmptyState
      icon={ICONS[info.kind]}
      tone={TONES[info.kind] ?? 'gray'}
      title={info.title}
      text={info.text}
      actions={
        <>
          {onRetry ? <Button title={t('retry')} icon="refresh" onPress={onRetry} /> : null}
          {info.kind === 'session' ? <Button title={t('login_enter')} onPress={() => router.replace('/login')} /> : null}
          <Button v="ghost" title={t('support')} icon="paper-plane-outline" onPress={() => Linking.openURL(`https://t.me/${SUPPORT_TG}`)} />
        </>
      }
    />
  );
}

type Action = { title: string; onPress: () => void };
/**
 * SCR-28 на весь экран (Errors.dc.html): плитка 76 r26 по тону, заголовок 30/36, текст 16/24 #55524D, зелёная заметка,
 * до трёх выходов внизу — .cta / .soft / .txt. Для разбора фото, «долго», «правка не прошла».
 */
export function ErrorScreen({ icon, tone = 'gray', title, text, note, primary, secondary, ghost, children }: {
  icon: IconName; tone?: Tone; title: string; text?: string; note?: string;
  primary?: Action; secondary?: Action; ghost?: Action; children?: ReactNode;
}) {
  const c = tone === 'gray' ? { bg: palette.segOnWhite, fg: palette.ink } : { bg: tones[tone].bg, fg: tones[tone].fg };
  return (
    <Screen contentStyle={{ paddingTop: 32, paddingHorizontal: 24, paddingBottom: 8 }} gap={16}
      footer={<>
        {primary ? <Button title={primary.title} onPress={primary.onPress} /> : null}
        {secondary ? <Button v="secondary" title={secondary.title} onPress={secondary.onPress} /> : null}
        {ghost ? <Button v="ghost" title={ghost.title} onPress={ghost.onPress} /> : null}
      </>}>
      {children}
      <View style={{ width: 76, height: 76, borderRadius: 26, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={34} color={c.fg} />
      </View>
      <T v="big">{title}</T>
      {text ? <T v="sub" style={{ color: palette.muted2, lineHeight: 24 }}>{text}</T> : null}
      {note ? (
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start', borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: palette.greenSoft }}>
          <Ionicons name="checkmark" size={20} color="#1F4A2F" style={{ marginTop: 1 }} />
          <T style={{ flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '500', color: '#1F4A2F' }}>{note}</T>
        </View>
      ) : null}
    </Screen>
  );
}
