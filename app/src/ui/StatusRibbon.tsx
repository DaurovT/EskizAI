import { StyleSheet, View } from 'react-native';
import { STATUS_FLOW, type ProjectStatus } from '../api/types';
import { useT } from '../i18n';
import { palette } from './theme';
import { Badge, T } from './kit';

/** Статус-лента SCR-27 (ProjectCard.dc.html): название шага, «3 / 7» и полоса из сегментов — пройденные зелёные, текущий светло-зелёный. */
export function StatusRibbon({ status }: { status: ProjectStatus }) {
  const { td } = useT();
  const idx = STATUS_FLOW.indexOf(status);
  if (status === 'cancelled') return <Badge label={td('st_cancelled', 'Отменён')} tone="red" />;
  return (
    <View style={{ gap: 10 }} accessibilityLabel={`${td(`st_${status}`, status)}, ${idx + 1} / ${STATUS_FLOW.length}`}>
      <View style={st.head}>
        <T v="h3" style={{ flex: 1 }}>{td(`st_${status}`, status)}</T>
        <T v="rs" num>{idx + 1} / {STATUS_FLOW.length}</T>
      </View>
      <View style={st.prog}>
        {STATUS_FLOW.map((s, i) => (
          <View key={s} style={[st.seg, { backgroundColor: i < idx ? palette.green : i === idx ? '#A9CDB5' : palette.off }]} />
        ))}
      </View>
    </View>
  );
}
const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  prog: { flexDirection: 'row', gap: 4 },
  seg: { flex: 1, height: 6, borderRadius: 3 },
});
