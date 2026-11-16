/**
 * Вход на планшете (TLogin.dc.html / TCode.dc.html): слева зелёная панель с обещанием продукта, справа форма 520.
 * Портрет планшета — форма колонкой 560 по центру; телефон — как есть.
 */
import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useT } from '../i18n';
import { BrandLogo, Carcass } from './Illus';
import { T } from './kit';
import { CenterColumn, useLayout } from './layout';
import { palette } from './theme';

export function AuthFrame({ children }: { children: ReactNode }) {
  const { tablet, wide } = useLayout();
  const { t } = useT();
  if (!tablet) return <>{children}</>;
  if (!wide) return <View style={{ flex: 1, backgroundColor: palette.ground }}><CenterColumn max={560}>{children}</CenterColumn></View>;
  return (
    <View style={st.root}>
      <View style={st.left} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={st.logo}><BrandLogo size={56} /></View>
          <T style={st.brand} color={palette.white}>Eskiz <T style={[st.brand, { opacity: 0.7 }]} color={palette.white}>AI</T></T>
        </View>
        <View style={{ maxWidth: 500, gap: 22 }}>
          <T style={st.head} color={palette.white}>{t('auth_t_head')}</T>
          <View style={{ gap: 10 }}>
            {(['auth_t_b1', 'auth_t_b2', 'auth_t_b3'] as const).map((k) => (
              <View key={k} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                <Ionicons name="checkmark-circle" size={20} color={palette.greenOnDark} style={{ marginTop: 1 }} />
                <T style={{ flex: 1, fontSize: 16, lineHeight: 22 }} color={palette.white}>{t(k)}</T>
              </View>
            ))}
          </View>
        </View>
        <View style={st.room}>
          <View style={st.chips}>
            {(['auth_t_c1', 'auth_t_c2', 'auth_t_c3'] as const).map((k, i) => (
              <View key={k} style={st.chip}><T style={st.chipT} color={i === 0 ? palette.greenDeep : palette.ink}>{t(k)}</T></View>
            ))}
          </View>
          <Carcass w={170} h={230} r={56} b={4} style={{ marginLeft: 160, marginBottom: -6 }} />
        </View>
      </View>
      <View style={st.right}>{children}</View>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: palette.ground },
  left: { flex: 1, margin: 16, marginRight: 0, borderRadius: 32, backgroundColor: palette.green, padding: 36, gap: 32, overflow: 'hidden' },
  logo: { width: 56, height: 56, borderRadius: 18, overflow: 'hidden' },
  brand: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.8 },
  head: { fontSize: 38, lineHeight: 44, fontWeight: '700', letterSpacing: -1.1 },
  room: {
    flex: 1, minHeight: 200, maxHeight: 330, marginTop: 'auto', borderRadius: 24, backgroundColor: palette.wood,
    alignItems: 'center', justifyContent: 'flex-end', overflow: 'hidden',
  },
  chips: { position: 'absolute', left: 20, top: 20, gap: 8 },
  chip: { alignSelf: 'flex-start', height: 26, paddingHorizontal: 10, borderRadius: 9, backgroundColor: palette.white, justifyContent: 'center' },
  chipT: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  right: { width: 520, paddingHorizontal: 40 },
});
