/**
 * SCR-07 Уточнения до эскиза (Clarify.dc.html): вопросы ИИ (?), пояснения (i) и предложения замены (✦, плашки цены и
 * срока) одним списком. Варианты — сразу в строке (.an), «Не знаю» = значение по умолчанию с пометкой «оценка»;
 * выбранный ответ сворачивается в «✓ ответ · изменить». Вопрос о предмете (несколько на фото) — рамки на фото.
 * «Собрать модель» отправляет все ответы разом, неотвеченное — «не знаю». Раунды: ИИ пересчитал и спросил ещё —
 * новые вопросы здесь же, отвеченные — сверху с ✓ и не спрашиваются снова; вопросов больше нет — в редактор.
 */
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import type { DesignOut, DesignQuestion } from '../../../src/api/types';
import { useAiTask } from '../../../src/hooks/useAiTask';
import { useT } from '../../../src/i18n';
import { clarifyRows } from '../../../src/lib/clarify';
import { applyDesign } from '../../../src/services/design';
import { showError } from '../../../src/ui/dialogs';
import { updateMeta, useMeta } from '../../../src/state/projectMeta';
import { ErrorState } from '../../../src/ui/ErrorState';
import { PhotoBoxes } from '../../../src/ui/PhotoBoxes';
import { QLegend, QuestionItem } from '../../../src/ui/QuestionItem';
import { Button, Card, Loading, Screen, T } from '../../../src/ui/kit';
import { StackHeader14 } from '../../../src/ui/navigation';
import { palette } from '../../../src/ui/theme';

/** Маркер «не знаю»: сервер ставит значение по умолчанию и помечает его «оценка». */
const DONT_KNOW = 'не знаю';

const SHOT: DesignQuestion[] = [
  { id: 'q_round', text: 'Правый торец скруглён. На всю высоту или только сверху?', options: ['На всю высоту', 'Только сверху'], default: 'На всю высоту' },
  { id: 'q_legs', text: 'Ножки металлические. Какая высота?', options: ['100 мм', '150 мм', '200 мм'], default: '150 мм' },
  { id: 'alt_riffle', kind: 'proposal', text: 'Вместо фрезеровки МДФ — готовый фасад «Риффл» из каталога EMAN по вашим размерам.', options: ['Заменить', 'Оставить как на фото'], default: 'Оставить как на фото', deltas: ['−640 000 сум', '−7 дней'] },
];
const SHOT_INFO = ['Петли подобрал с доводчиком: по 3 на каждую дверь высотой 2300.'];

export default function Questions() {
  const { id, shot } = useLocalSearchParams<{ id: string; shot?: string }>();
  const { t, lang } = useT();
  const meta = useMeta(id);
  const ai = useAiTask();
  const answered = meta.answered ?? [];
  const done = new Set([...answered.map((a) => a.id), ...Object.keys(meta.design?.answers ?? {})]);
  // отвеченное в прошлых раундах не спрашиваем снова
  const qs = (meta.design?.status === 'questions' || shot ? meta.design?.questions ?? [] : []).filter((q) => !done.has(q.id)).slice(0, 6);
  const answers = meta.answers;
  // выбранный ответ свёрнут в «✓ ответ · изменить»; «изменить» снова показывает варианты
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const setAnswer = (qid: string, v: string) => {
    updateMeta(id, (m) => ({ answers: { ...m.answers, [qid]: v } }));
    setOpen((o) => ({ ...o, [qid]: false }));
  };
  const objects = meta.design?.objects ?? [];

  useEffect(() => {
    if (__DEV__ && shot) {
      updateMeta(id, (m) => ({
        design: { ...(m.design ?? ({} as DesignOut)), status: 'questions', questions: SHOT, objects: [], answers: {}, unclear: SHOT_INFO, differences: [] } as DesignOut,
        answers: (shot === 'picked' ? { q_round: 'На всю высоту', q_legs: '150 мм' } : shot === 'one' ? { q_round: 'На всю высоту' } : {}) as Record<string, string>,
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
  const pill = qs.length ? t('clr_answered_of', { i: answered.length + picked, n: total }) : '';
  const info = [...(meta.design?.unclear ?? []), ...(meta.design?.differences ?? [])];
  const rows = clarifyRows(qs.filter((q) => q.id !== 'object' || !objects.length), info);
  const shown = (q: DesignQuestion, v: string) => (v === DONT_KNOW ? `${t('q_dont_know_short')}${q.default ? ` → ${q.default}` : ''}` : v);
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
          <View style={[s.pill, { backgroundColor: palette.white, height: 30, borderRadius: 15 }]}><T style={s.pillText}>{t('q_preview')}</T></View>
        </View>
      )}
      {answered.length || rows.length || objectQ ? (
        <Card padded={false} style={{ borderRadius: 24 }}>
          {answered.map((a, i) => (
            <QuestionItem key={`a${a.id}`} kind="ok" text={a.text} done picked={a.value} first={i === 0} />
          ))}
          {objectQ && objects.length ? (
            <QuestionItem key="object" kind={answers.object ? 'ok' : 'q'} text={objectQ.text} done={!!answers.object} first={!answered.length}
              picked={answers.object && !open.object ? answers.object : null} editLabel={t('clr_change')} onEdit={() => setOpen((o) => ({ ...o, object: true }))}
              options={objectQ.options.map((o) => ({ label: o, on: answers.object === o, onPress: () => setAnswer('object', o) }))} />
          ) : null}
          {rows.map((r, i) => {
            const first = !answered.length && !(objectQ && objects.length) && i === 0;
            if (r.type === 'i') return <QuestionItem key={`i${i}`} kind="i" text={r.text} done first={first} />;
            const q = r.q;
            const v = answers[q.id];
            const isOpen = !v || open[q.id];
            const opts = [
              ...q.options.map((o) => ({ label: o, on: v === o, onPress: () => setAnswer(q.id, o) })),
              ...(r.type === 'q' ? [{ label: t('q_dont_know_short'), ghost: true, on: false, onPress: () => setAnswer(q.id, DONT_KNOW) }] : []),
            ];
            return (
              <QuestionItem key={q.id} kind={v && !isOpen ? 'ok' : r.type} text={q.text} done={!!v && !isOpen} first={first} deltas={q.deltas}
                picked={v && !isOpen ? shown(q, v) : null} editLabel={t('clr_change')} onEdit={() => setOpen((o) => ({ ...o, [q.id]: true }))} options={opts} />
            );
          })}
        </Card>
      ) : null}
      {answered.length && qs.length ? <T v="cap" style={{ paddingHorizontal: 6 }}>{t('q_next_round')}</T> : null}
      {rows.length ? (
        <QLegend items={[{ kind: 'q', label: t('clr_leg_q') }, { kind: 's', label: t('clr_leg_s') }, { kind: 'i', label: t('clr_leg_i') }]} />
      ) : null}
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
  prev: { height: 84, borderRadius: 24, backgroundColor: palette.wood, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 },
  carc: { width: 88, height: 64, backgroundColor: palette.ink, padding: 2, gap: 2, flexDirection: 'row', borderTopRightRadius: 32 },
  wood: { flex: 1, backgroundColor: '#E1CDA8' },
});
