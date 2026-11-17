/**
 * SCR-07 «Уточним детали» (Clarify.dc.html .qi): строка вопроса ИИ — значок (? вопрос, ✦ предложение замены,
 * i информация, ✓ отвечено), текст 15/20, у предложения — плашки «−640 000 сум», «−7 дней»; варианты ответа сразу
 * в строке (.an, «Не знаю» — прозрачной), выбранный ответ — зелёной плашкой «✓ ответ · изменить» (тап — снова варианты).
 * Тот же вид — в «Что я нашёл» разбора фото/описания/чертежа (breakdown.tsx).
 */
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Press, T } from './base';
import { palette } from './theme';

export type QMarkKind = 'q' | 's' | 'i' | 'ok';

const MARK: Record<QMarkKind, { bg: string; fg: string }> = {
  q: { bg: palette.blueSoft, fg: palette.blue },
  s: { bg: palette.amberSoft, fg: palette.amberDeep },
  i: { bg: palette.ground, fg: palette.muted },
  ok: { bg: palette.greenSoft, fg: palette.greenDeep },
};

/** .qic 28 r9: ? / ✦ / i / ✓. size 16 — значок легенды (.leg b). */
export function QMark({ kind, size = 28, style }: { kind: QMarkKind; size?: number; style?: StyleProp<ViewStyle> }) {
  const c = MARK[kind];
  const small = size < 24;
  const fs = small ? 10 : 14;
  return (
    <View style={[{ width: size, height: size, borderRadius: small ? 5 : 9, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }, style]}>
      {kind === 's' ? <MaterialCommunityIcons name="star-four-points" size={small ? 9 : 13} color={c.fg} />
        : kind === 'ok' ? <MaterialCommunityIcons name="check-bold" size={small ? 10 : 15} color={c.fg} />
          : <T style={{ fontSize: fs, lineHeight: fs + 3, fontWeight: '700', color: c.fg }}>{kind === 'q' ? '?' : 'i'}</T>}
    </View>
  );
}

export type QOption = { label: string; on?: boolean; ghost?: boolean; onPress: () => void };

export function QuestionItem({ kind, text, done, tag, deltas, picked, editLabel, onEdit, options, first, padX = 14, children }: {
  kind: QMarkKind; text: string;
  /** Отвечено / информация — текст приглушён (.qt.done). */
  done?: boolean;
  /** Метка у вопроса (разбор чертежа: «нет на листе»). */
  tag?: string;
  /** Плашки предложения (.dl): цена и срок. */
  deltas?: string[] | null;
  /** Выбранный ответ — плашка .picked. */
  picked?: string | null;
  /** «изменить» в плашке ответа; нет — плашка только для чтения (ответ прошлого раунда). */
  editLabel?: string; onEdit?: () => void;
  /** Варианты ответа (.ans) — показываются, пока нет picked. */
  options?: QOption[];
  first?: boolean; padX?: number;
  children?: ReactNode;
}) {
  return (
    <View style={[s.qi, { paddingHorizontal: padX }, !first && s.line]} accessibilityLabel={`${text}${picked ? `. ${picked}` : ''}`}>
      <QMark kind={kind} style={{ marginTop: 1 }} />
      <View style={s.qb}>
        {tag ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <T style={[s.qt, done && s.done]}>{text}</T>
            <View style={s.tag}><T style={s.tagT}>{tag}</T></View>
          </View>
        ) : <T style={[s.qt, done && s.done]}>{text}</T>}
        {deltas?.length && !picked ? (
          <View style={s.dl}>{deltas.map((d) => <View key={d} style={s.dlI}><T num style={s.dlT}>{d}</T></View>)}</View>
        ) : null}
        {picked ? (
          onEdit ? (
            <Press onPress={onEdit} accessibilityRole="button" accessibilityLabel={`${picked}. ${editLabel ?? ''}`} style={s.picked}>
              <MaterialCommunityIcons name="check-bold" size={13} color={palette.greenDeep} />
              <T style={s.pickedT} numberOfLines={1}>{picked}</T>
              {editLabel ? <T style={s.chg}>{editLabel}</T> : null}
            </Press>
          ) : (
            <View style={s.picked}>
              <MaterialCommunityIcons name="check-bold" size={13} color={palette.greenDeep} />
              <T style={s.pickedT} numberOfLines={1}>{picked}</T>
            </View>
          )
        ) : options?.length ? (
          <View style={s.ans}>
            {options.map((o) => (
              <Press key={o.label} onPress={o.onPress} accessibilityRole="radio" accessibilityState={{ selected: !!o.on }} accessibilityLabel={o.label}
                style={[s.an, o.on && s.anOn, o.ghost && s.ghost]}>
                <T style={[s.anT, o.on && { color: palette.white }, o.ghost && { color: palette.faint }]} numberOfLines={1}>{o.label}</T>
              </Press>
            ))}
          </View>
        ) : null}
        {children}
      </View>
    </View>
  );
}

/** .leg — легенда значков под списком. */
export function QLegend({ items }: { items: { kind: QMarkKind; label: string }[] }) {
  return (
    <View style={s.leg} accessibilityRole="text">
      {items.map((x) => (
        <View key={x.kind} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <QMark kind={x.kind} size={16} />
          <T style={{ fontSize: 12, lineHeight: 16, color: palette.muted }}>{x.label}</T>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  qi: { flexDirection: 'row', gap: 12, paddingVertical: 13 },
  line: { borderTopWidth: 1, borderTopColor: palette.hair },
  qb: { flex: 1, minWidth: 0, gap: 8 },
  qt: { fontSize: 15, lineHeight: 20, fontWeight: '500', color: palette.ink },
  done: { color: palette.muted },
  tag: { height: 22, borderRadius: 9, paddingHorizontal: 8, backgroundColor: palette.amberSoft, justifyContent: 'center' },
  tagT: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: palette.amberDeep },
  dl: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  dlI: { borderRadius: 7, paddingVertical: 3, paddingHorizontal: 7, backgroundColor: palette.amberSoft },
  dlT: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: '#6E3C00' },
  picked: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, borderRadius: 10, paddingHorizontal: 10, backgroundColor: palette.greenSoft, maxWidth: '100%' },
  pickedT: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: palette.greenDeep, flexShrink: 1 },
  chg: { fontSize: 13, lineHeight: 17, fontWeight: '500', color: palette.greenPress, opacity: 0.75 },
  ans: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  an: { height: 34, borderRadius: 11, paddingHorizontal: 11, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  anOn: { backgroundColor: palette.ink },
  ghost: { backgroundColor: 'transparent', paddingHorizontal: 6 },
  anT: { fontSize: 14, lineHeight: 18, fontWeight: '500', color: palette.ink },
  leg: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 6, alignItems: 'center' },
});
