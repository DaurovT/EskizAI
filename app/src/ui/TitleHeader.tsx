/**
 * Шапка с заголовком в две строки (.top/.tt в MInbox, MInboxItem; .hdr + .tx в MDrawing): «назад», название 18/600
 * (или 17/600 — `compact`) и серая подпись 14 (13). Подключение: `<Stack.Screen options={{ header: () => <TitleHeader … /> }} />`.
 */
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../i18n';
import { IconButton, T } from './kit';
import { HeaderColumn } from './layout';
import { palette } from './theme';

export function TitleHeader({ title, sub, right, onBack, compact }: { title: string; sub?: string | null; right?: ReactNode; onBack?: () => void; compact?: boolean }) {
  const insets = useSafeAreaInsets();
  const { t } = useT();
  return (
    <View style={{ paddingTop: insets.top + 2, backgroundColor: palette.ground }}>
      <HeaderColumn bg={palette.ground}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 6, minHeight: 62 }}>
        <IconButton icon="chevron-back" label={t('back')} onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))} />
        <View style={{ flex: 1, minWidth: 0, paddingLeft: compact ? 4 : 0 }} accessibilityRole="header">
          <T style={compact ? { fontSize: 17, lineHeight: 22, fontWeight: '600' } : { fontSize: 18, lineHeight: 24, fontWeight: '600', letterSpacing: -0.18 }} numberOfLines={1}>{title}</T>
          {sub ? <T style={compact ? { fontSize: 13, lineHeight: 17 } : { fontSize: 14, lineHeight: 18 }} color={palette.muted} numberOfLines={1}>{sub}</T> : null}
        </View>
        {right}
      </View>
      </HeaderColumn>
    </View>
  );
}
