/**
 * SCR-06 Выбор типа изделия (TypeChoice.dc.html): до трёх вероятных вариантов с процентом (первый — «Самое вероятное»)
 * и «Все типы» списком; «Ничего не подходит · нестандарт».
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import { PRODUCT_KINDS } from '../../../src/api/mock/data';
import type { DesignOut } from '../../../src/api/types';
import { useAiTask } from '../../../src/hooks/useAiTask';
import { useT } from '../../../src/i18n';
import { applyDesign } from '../../../src/services/design';
import { updateMeta, useMeta } from '../../../src/state/projectMeta';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Button, Group, ListItem, Loading, Press, Screen, T, Tile } from '../../../src/ui/kit';
import { StackHeader14 } from '../../../src/ui/navigation';
import { palette } from '../../../src/ui/theme';

/** Мини-схема изделия на «дереве» (.mini): колонки створок или ряды полок. */
function Mini({ kind }: { kind: string }) {
  const cols = kind === 'wardrobe_sliding' ? 3 : kind === 'rack' ? 0 : 2;
  const w = kind === 'wardrobe_sliding' ? 36 : kind === 'rack' ? 28 : 30;
  return (
    <View style={[s.mini, { width: w, flexDirection: cols ? 'row' : 'column' }]}>
      {Array.from({ length: cols || 4 }, (_, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: kind === 'wardrobe_sliding' && i === 1 ? '#C9D3CE' : '#E6D3B1' }} />
      ))}
    </View>
  );
}

type Icon = { ion?: keyof typeof Ionicons.glyphMap; mci?: keyof typeof MaterialCommunityIcons.glyphMap };
const ICONS: Record<string, Icon> = {
  kitchen: { ion: 'grid-outline' },
  kitchen_corner: { mci: 'alpha-l' },
  tv_stand: { ion: 'layers-outline' },
  dresser: { ion: 'archive-outline' },
  hallway: { mci: 'alpha-h' },
  wardrobe: { mci: 'wardrobe-outline' },
  wardrobe_sliding: { mci: 'wardrobe-outline' },
  rack: { mci: 'bookshelf' },
};

/** Порядок «Все типы» как в макете. */
const ORDER: string[] = ['kitchen', 'kitchen_corner', 'tv_stand', 'dresser', 'hallway', 'wardrobe_sliding', 'wardrobe', 'rack'];

const SHOT: DesignOut['alternatives'] = [
  { product_kind: 'wardrobe_sliding', confidence: 0.54 }, { product_kind: 'wardrobe', confidence: 0.31 }, { product_kind: 'rack', confidence: 0.09 },
];

export default function ChooseType() {
  const { id, shot } = useLocalSearchParams<{ id: string; shot?: string }>();
  const { t, td } = useT();
  const meta = useMeta(id);
  const ai = useAiTask();
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (__DEV__ && shot) updateMeta(id, (m) => ({ photos: m.photos.length ? m.photos : [''], design: { ...(m.design ?? ({} as DesignOut)), alternatives: SHOT } as DesignOut }));
  }, [id, shot]);
  const alts = (meta.design?.alternatives ?? []).map((a) => (typeof a === 'string' ? { product_kind: a, confidence: undefined } : a)).slice(0, 3);
  const rest = [...PRODUCT_KINDS].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).filter((k) => !alts.some((a) => a.product_kind === k));
  const label = (k: string) => td(`pk_${k}`, k);
  const sel = picked ?? alts[0]?.product_kind ?? null;

  const choose = async (kind: string) => {
    setPicked(kind);
    const r = await ai.run<DesignOut>((c) => api.aiChooseType(id, kind, c));
    if (r) applyDesign(id, r, { from: 'type', replace: true });
  };

  const header = <Stack.Screen options={{ title: '', header: (p) => <StackHeader14 {...p} /> }} />;
  if (ai.running) return <Screen>{header}<Loading label={t('bd_working')} /></Screen>;
  return (
    <Screen contentStyle={{ paddingTop: 4 }} footerStyle={{ paddingTop: 4 }}
      footer={<Button v="secondary" title={t('type_none')} onPress={() => router.push(`/project/${id}/nonstandard`)} />}>
      {header}
      {ai.error ? <ErrorState error={ai.error} /> : null}
      <View style={{ paddingHorizontal: 8, paddingBottom: 4 }}>
        <T v="big">{meta.photos.length ? t('type_photo_title') : t('type_title')}</T>
        <T v="sub" style={{ marginTop: 6 }}>{t('type_sub2')}</T>
      </View>
      {alts.map((a, i) => {
        const on = a.product_kind === sel;
        const fg = on ? palette.white : palette.ink;
        return (
          <Press key={a.product_kind} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={label(a.product_kind)}
            onPress={() => choose(a.product_kind)} style={[s.ty, on && { backgroundColor: palette.ink }]}>
            <View style={s.th}><Mini kind={a.product_kind} /></View>
            <View style={{ flex: 1 }}>
              <T v="rt" color={fg}>{label(a.product_kind)}</T>
              {i === 0 ? <T v="rs" color={on ? palette.chev : undefined}>{t('type_likely')}</T> : null}
            </View>
            {a.confidence != null ? <T num style={{ fontSize: 16, fontWeight: '600', color: fg }}>{`${Math.round(a.confidence * 100)}%`}</T> : null}
          </Press>
        );
      })}
      <T style={{ paddingTop: alts.length ? 10 : 0, paddingHorizontal: 8, fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3 }}>{t('type_all2')}</T>
      <Group>
        {rest.map((k) => (
          <ListItem key={k} title={label(k)} onPress={() => choose(k)} style={{ minHeight: 54, paddingVertical: 6 }}
            left={<Tile style={{ width: 40, height: 40 }}>{ICONS[k]?.ion ? <Ionicons name={ICONS[k].ion!} size={20} color={palette.ink} /> : <MaterialCommunityIcons name={ICONS[k]?.mci ?? 'cube-outline'} size={k === 'hallway' || k === 'kitchen_corner' ? 26 : 20} color={palette.ink} />}</Tile>} />
        ))}
      </Group>
    </Screen>
  );
}

const s = StyleSheet.create({
  ty: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 70, paddingVertical: 8, paddingLeft: 10, paddingRight: 18, borderRadius: 24, backgroundColor: palette.white },
  th: { width: 56, height: 56, borderRadius: 16, backgroundColor: palette.wood, alignItems: 'center', justifyContent: 'center' },
  mini: { height: 40, backgroundColor: palette.ink, padding: 4, gap: 2 },
});
