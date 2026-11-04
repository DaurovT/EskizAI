/**
 * SCR-07 Уточнения до эскиза (Clarify.dc.html): не больше 3 вопросов, ответы кнопками в ряд (.op), «Не знаю» = значение
 * по умолчанию с пометкой «оценка». Вопрос о предмете (несколько на фото) — рамки на фото.
 * Тап по ответу только выбирает его (можно передумать); «Собрать модель» отправляет все ответы разом, неотвеченное —
 * «не знаю» (по умолчанию, «оценка»). Раунды: ИИ пересчитал и спросил ещё — новые вопросы здесь же, отвеченные свёрнуты
 * сверху и не спрашиваются снова; вопросов больше нет — в редактор.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import type { DesignOut, DesignQuestion } from '../../../src/api/types';
import { useAiTask } from '../../../src/hooks/useAiTask';
import { useT } from '../../../src/i18n';
import { applyDesign } from '../../../src/services/design';
import { showError } from '../../../src/ui/dialogs';
import { updateMeta, useMeta } from '../../../src/state/projectMeta';
import { ErrorState } from '../../../src/ui/ErrorState';
import { PhotoBoxes } from '../../../src/ui/PhotoBoxes';
import { Button, Card, Loading, Press, Screen, T } from '../../../src/ui/kit';
import { StackHeader14 } from '../../../src/ui/navigation';
import { palette } from '../../../src/ui/theme';

/** Маркер «не знаю»: сервер ставит значение по умолчанию и помечает его «оценка». */
const DONT_KNOW = 'не знаю';

const SHOT: DesignQuestion[] = [
  { id: 'q_round', text: 'Правый торец скруглён. На всю высоту или только сверху?', options: ['На всю высоту', 'Только сверху'], default: 'На всю высоту' },
  { id: 'q_legs', text: 'Ножки металлические. Какая высота?', options: ['100 мм', '150 мм', '200 мм'], default: '150 мм' },
];

export default function Questions() {
  const { id, shot } = useLocalSearchParams<{ id: string; shot?: string }>();
  const { t, lang } = useT();
  const meta = useMeta(id);
  const ai = useAiTask();
  const answered = meta.answered ?? [];
  const done = new Set([...answered.map((a) => a.id), ...Object.keys(meta.design?.answers ?? {})]);
  // отвеченное в прошлых раундах не спрашиваем снова
  const qs = (meta.design?.status === 'questions' || shot ? meta.design?.questions ?? [] : []).filter((q) => !done.has(q.id)).slice(0, 3);
  const answers = meta.answers;
  // тап — только выбор (повторный тап по выбранному снимает выбор); отправка — одной кнопкой
  const setAnswer = (qid: string, v: string) => updateMeta(id, (m) => {
    const next = { ...m.answers };
    if (next[qid] === v) delete next[qid]; else next[qid] = v;
    return { answers: next };
  });
  const objects = meta.design?.objects ?? [];

  useEffect(() => {
    if (__DEV__ && shot) {
      updateMeta(id, (m) => ({
        design: { ...(m.design ?? ({} as DesignOut)), status: 'questions', questions: SHOT, objects: [], answers: {} } as DesignOut,
        answers: (shot === 'picked' ? { q_round: 'На всю высоту', q_legs: '150 мм' } : {}) as Record<string, string>,
        answered: shot === 'round2' ? [{ id: 'q_ends', text: 'Торцы шкафа открытые?', value: 'Нет, в нише' }, { id: 'q_width', text: 'Какая ширина ниши?', value: '2000 мм' }] : [],
      }));
    }
  }, [id, shot]);

  /** Собрать модель: все ответы раунда разом; неотвеченное — «не знаю» (по умолчанию, «оценка»). */
  const send = async () => {
    const out: Record<string, string> = {};
    for (const q of qs) out[q.id] = answers[q.id] ?? DONT_KNOW;
    if (!Object.keys(out).length) return;
    const round = qs.map((q) => ({ id: q.id, text: q.text, value: out[q.id] === DONT_KNOW ? `${t('q_default_mark')}${q.default ? ` (${q.default})` : ''}` : out[q.id] }));
    const r = await ai.run<DesignOut>((c) => api.aiAnswer(id, out, c));
    if (!r) return;
    // ответы сохранены на сервере — запоминаем раунд (показать свёрнуто) и убираем черновик выбора
    updateMeta(id, (m) => {
      const rest = { ...m.answers };
      for (const k of Object.keys(out)) delete rest[k];
      return { answered: [...(m.answered ?? []).filter((a) => !(a.id in out)), ...round], answers: rest };
    });
    if (r.status === 'ready' && r.version_id) {
      applyDesign(id, r, { from: 'questions', navigate: false });
      try {
        const card = await api.getProject(id);
        if (card.status === 'draft' && card.current_version_id) await api.toSketch(id).catch(() => undefined);
      } catch (e) {
        showError(e, lang);
      }
      router.replace(`/project/${id}/editor`);
      return;
    }
    // новые вопросы — следующий раунд здесь же; выбор типа / сбой — на свои экраны
    applyDesign(id, r, { from: 'questions', replace: true });
  };

  const picked = qs.filter((q) => answers[q.id]).length;
  const total = answered.length + qs.length;
  const pill = qs.length ? t('q_of', { i: Math.min(total, answered.length + picked + 1), n: total }) : '';
  const header = (
    <Stack.Screen options={{
      title: t('q_title2'), header: (p) => <StackHeader14 {...p} />,
      headerRight: pill ? () => <View style={s.pill}><T style={s.pillText}>{pill}</T></View> : undefined,
    }} />
  );
  if (ai.running) return <Screen>{header}<Loading label={t('q_recalc')} delay={0} /></Screen>;
  const objectQ = qs.find((q) => q.id === 'object');
  return (
    <Screen gap={8} contentStyle={{ paddingTop: 0 }} footerStyle={{ gap: 2, paddingTop: 6 }}
      footer={<>
        <Button title={t('q_send')} onPress={send} disabled={!qs.length} />
        {qs.length && picked < qs.length ? <Button v="ghost" title={t('q_rest_default')} onPress={send} /> : null}
      </>}>
      {header}
      {ai.error ? <ErrorState error={ai.error} onRetry={() => send()} /> : null}
      {objectQ && objects.length && meta.photos.length ? (
        <PhotoBoxes uri={meta.photos[objects[0].photo] ?? meta.photos[0]} objects={objects.filter((o) => o.photo === objects[0].photo)} height={200}
          selected={answers.object ?? null} onSelect={(l) => setAnswer('object', l)} />
      ) : (
        <View style={s.prev} accessibilityRole="image" accessibilityLabel={t('q_preview')}>
          <View style={s.carc}>
            <Wood /><Wood /><View style={[s.wood, { backgroundColor: '#F2B66D', borderTopRightRadius: 28 }]} />
          </View>
          <View style={[s.pill, { backgroundColor: palette.white }]}><T style={s.pillText}>{t('q_preview')}</T></View>
        </View>
      )}
      {answered.length ? (
        <Card style={{ paddingVertical: 12, paddingHorizontal: 16, gap: 6 }} accessibilityLabel={t('q_answered', { n: answered.length })}>
          <T v="cap" style={{ fontSize: 13 }}>{t('q_answered', { n: answered.length })}</T>
          {answered.map((a) => (
            <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="checkmark-circle" size={18} color={palette.green} />
              <T style={{ flex: 1, fontSize: 14, lineHeight: 19, color: palette.muted }} numberOfLines={1}>{a.text}</T>
              <T style={{ fontSize: 14, lineHeight: 19, fontWeight: '600', maxWidth: '45%' }} numberOfLines={1}>{a.value}</T>
            </View>
          ))}
        </Card>
      ) : null}
      {answered.length && qs.length ? <T v="cap" style={{ paddingHorizontal: 4, marginTop: 2 }}>{t('q_next_round')}</T> : null}
      {qs.length ? <Card style={{ paddingVertical: 18, paddingHorizontal: 16, gap: 18 }}>
        {qs.map((q) => {
          const opts = q.options.length < 3 ? [...q.options, DONT_KNOW] : q.options;
          const rows: string[][] = [];
          for (let i = 0; i < opts.length; i += 3) rows.push(opts.slice(i, i + 3));
          return (
            <View key={q.id} style={{ gap: 10 }}>
              <T style={s.qt}>{q.text}</T>
              {rows.map((r, ri) => (
                <View key={ri} style={{ flexDirection: 'row', gap: 6 }}>
                  {r.map((o) => {
                    const on = answers[q.id] === o;
                    return (
                      <Press key={o} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={o}
                        onPress={() => setAnswer(q.id, o)} style={[s.op, on && { backgroundColor: palette.ink }]}>
                        <T style={[s.opText, on && { color: palette.white }]} numberOfLines={1}>{o === DONT_KNOW ? t('q_dont_know_short') : o}</T>
                      </Press>
                    );
                  })}
                </View>
              ))}
            </View>
          );
        })}
      </Card> : null}
    </Screen>
  );
}

/** .wood — полоски 7/2 px #E6D3B1 / #DCC59F. */
function Wood() {
  return (
    <View style={[s.wood, { flexDirection: 'row', overflow: 'hidden' }]}>
      {Array.from({ length: 4 }, (_, i) => <View key={i} style={{ width: 9, flexDirection: 'row' }}><View style={{ width: 7, backgroundColor: '#E6D3B1' }} /><View style={{ width: 2, backgroundColor: '#DCC59F' }} /></View>)}
    </View>
  );
}

const s = StyleSheet.create({
  pill: { height: 32, borderRadius: 16, paddingHorizontal: 12, backgroundColor: palette.white, justifyContent: 'center' },
  pillText: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: palette.muted2 },
  prev: { height: 84, borderRadius: 28, backgroundColor: palette.wood, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18 },
  carc: { width: 88, height: 64, backgroundColor: palette.ink, padding: 2, gap: 2, flexDirection: 'row', borderTopRightRadius: 32 },
  wood: { flex: 1, backgroundColor: '#E1CDA8' },
  qt: { fontSize: 17, lineHeight: 23, fontWeight: '600', paddingHorizontal: 4 },
  // как .op flex:1 + white-space:nowrap: ширина по тексту, свободное место поровну
  op: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minHeight: 48, borderRadius: 14, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  opText: { fontSize: 14, lineHeight: 19, fontWeight: '500', textAlign: 'center' },
});
