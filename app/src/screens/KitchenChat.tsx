/**
 * Вкладка «Чат» редактора кухни (KitchenEditor.dc.html / TKitchen2.dc.html .msg): сообщения мастера — тёмные пузыри
 * справа, ответы ИИ — серые слева; у правки с версией — плашки «где» (синяя, «верх 2») и «цена» (зелёная, «+1,1 млн»).
 * «ИИ думает…», под последней правкой — «Отменить» / «Вернуть», вопросы ИИ с вариантами (распознавания — выбрать и
 * «Отправить ответы» разом; один — тап сразу отвечает), лимит ИИ — плашка пакета. Данные и отправка — как у шкафа (editor.tsx).
 * dense — плотный вид планшета (13/17, r12).
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import type { ChatMessage, DesignQuestion } from '../api/types';
import { useT } from '../i18n';
import { chatView } from '../lib/chatView';
import { formatDelta, groupDigits, noCurrency } from '../lib/format';
import { haptics } from '../ui/haptics';
import { Button, Press, T } from '../ui/kit';
import { palette } from '../ui/theme';

export type KitchenChatProps = {
  messages: ChatMessage[];
  questions: DesignQuestion[];
  running: boolean; elapsed: number;
  canUndo: boolean; canRedo: boolean;
  /** Сохранение / пересборка идёт — кнопки правки неактивны. */
  busy: boolean; disabled: boolean;
  /** ИИ-бюджет проекта исчерпан — вместо ответов предложение пакета. */
  aiLimited: boolean;
  onUndo: () => void; onRedo: () => void;
  onSend: (text: string) => void;
  onAnswers: (qs: DesignQuestion[], picked: Record<string, string>) => void;
  /** Плотный вид планшета. */
  dense?: boolean;
  /** Подпись внизу ленты (планшет: «Каждая правка — новая версия…»). */
  note?: string;
};

export function KitchenChat({ messages, questions, running, elapsed, canUndo, canRedo, busy, disabled, aiLimited, onUndo, onRedo, onSend, onAnswers, dense, note }: KitchenChatProps) {
  const { t, lang } = useT();
  const scroll = useRef<ScrollViewInstance>(null);
  const userScrolled = useRef(false);
  const [qPick, setQPick] = useState<Record<string, string>>({});
  const { history, lastChange, designQs, question } = chatView(messages, questions);
  const empty = !history.length && !lastChange && !designQs.length && !question && !running && !aiLimited;
  const fs = dense ? { fontSize: 13, lineHeight: 17 } : { fontSize: 14, lineHeight: 19 };
  const pad = dense ? 0 : 16;

  /** Плашки правки: где (если ИИ назвал модуль) и разница цены. */
  const chips = (m: ChatMessage) => {
    const where = m.kind && /\d/.test(m.kind) && !/^[a-z_]+$/.test(m.kind) ? m.kind : null;
    const delta = formatDelta(m.price_delta, lang);
    if (!where && !delta) return null;
    const up = !!m.price_delta && m.price_delta.to - m.price_delta.from > 0;
    return (
      <View style={s.chg}>
        {where ? <View style={[s.chip, dense && s.chip2]}><T style={[s.chipT, dense && s.chipT2, { color: palette.blue }]}>{where}</T></View> : null}
        {delta ? <View style={[s.chip, dense && s.chip2]}><T num style={[s.chipT, dense && s.chipT2, { color: up ? palette.greenDeep : palette.redDeep }]}>{noCurrency(delta)}</T></View> : null}
      </View>
    );
  };
  const bubble = (m: ChatMessage) => m.author === 'master' ? (
    <View key={m.id} style={[s.msg, dense && s.msg2, s.me, !dense && s.meTail, m.undone && { opacity: 0.5 }]}>
      <T style={[fs, { color: palette.white }]}>{m.text}</T>
    </View>
  ) : (
    <View key={m.id} style={[s.msg, dense && s.msg2, s.ai, !dense && s.aiTail, m.undone && { opacity: 0.5 }]}>
      <T style={fs}>{m.text}</T>
      {chips(m)}
    </View>
  );

  return (
    <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end', gap: 8, paddingTop: 10, paddingBottom: 8, paddingHorizontal: pad }} keyboardShouldPersistTaps="handled"
      onContentSizeChange={() => { if (!userScrolled.current) scroll.current?.scrollToEnd({ animated: false }); }} onScrollBeginDrag={() => { userScrolled.current = true; }}>
      {empty ? <T v="sub" style={[fs, { color: palette.muted }]}>{t('kit_chat_empty')}</T> : null}
      {history.map(bubble)}
      {lastChange ? (
        <View style={{ gap: 6 }}>
          {bubble(lastChange)}
          <Press onPress={lastChange.undone ? onRedo : onUndo} disabled={busy || disabled || running || (lastChange.undone ? !canRedo : !canUndo)} accessibilityRole="button"
            style={[s.undo, dense && s.undo2, (busy || disabled || running || (lastChange.undone ? !canRedo : !canUndo)) && { opacity: 0.45 }]}>
            <MaterialCommunityIcons name={lastChange.undone ? 'redo-variant' : 'undo-variant'} size={dense ? 14 : 16} color={palette.ink} />
            <T style={{ fontSize: dense ? 12.5 : 14, fontWeight: '600' }}>{lastChange.undone ? t('ed_return') : t('ed_undo')}</T>
          </Press>
        </View>
      ) : null}
      {aiLimited ? (
        <Press onPress={() => router.push('/paywall' as never)} style={[s.lim, dense && { borderRadius: 10, padding: 10 }]} accessibilityRole="button">
          <MaterialCommunityIcons name="star-four-points-outline" size={dense ? 16 : 20} color="#6E3C00" />
          <View style={{ flex: 1 }}>
            <T v="bt" color="#6E3C00" style={dense ? { fontSize: 13, lineHeight: 17 } : null}>{t('ail_title')}</T>
            <T v="bd" color="#6E3C00" style={[{ marginTop: 2 }, dense ? { fontSize: 12, lineHeight: 16 } : null]}>{t('ail_text')}</T>
          </View>
        </Press>
      ) : running ? (
        <View style={[s.msg, dense && s.msg2, s.ai, !dense && s.aiTail, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
          <ActivityIndicator size="small" color={palette.green} />
          <T style={[fs, { fontWeight: '600' }]}>{t('ed_ai_thinking')}{elapsed ? ` ${elapsed} с` : ''}</T>
        </View>
      ) : null}
      {!aiLimited && !running && designQs.length ? (
        <View style={[s.q, dense && s.q2]}>
          {designQs.length > 1 ? <T v="cap" style={{ fontSize: dense ? 12 : 13 }}>{t('ed_q_pick')}</T> : null}
          {designQs.map((q) => (
            <View key={q.id} style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                <View style={[s.qic, dense && s.qic2]}><T style={[s.qicT, dense && { fontSize: 12 }]}>?</T></View>
                <T style={[{ flex: 1, fontWeight: '500' }, dense ? { fontSize: 13, lineHeight: 18 } : { fontSize: 15, lineHeight: 20 }]}>{q.text}</T>
              </View>
              <View style={s.ans}>
                {q.options.slice(0, 4).map((o) => {
                  const on = qPick[q.id] === o;
                  return (
                    <Press key={o} style={[s.an, dense && s.an2, on && { backgroundColor: palette.ink }]} disabled={disabled} accessibilityRole="radio" accessibilityState={{ selected: on }}
                      onPress={() => {
                        haptics.selection();
                        if (designQs.length === 1) { setQPick({}); onAnswers(designQs, { [q.id]: o }); }
                        else setQPick((cur) => { const n = { ...cur }; if (n[q.id] === o) delete n[q.id]; else n[q.id] = o; return n; });
                      }}>
                      <T style={[s.anT, dense && { fontSize: 12.5 }, on && { color: palette.white }]} numberOfLines={1}>{o}</T>
                    </Press>
                  );
                })}
              </View>
            </View>
          ))}
          {designQs.length > 1 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <T v="cap" style={{ flex: 1, fontSize: dense ? 12 : 13 }} numberOfLines={2}>{t('ed_answers_left', { i: designQs.filter((q) => qPick[q.id]).length, n: designQs.length })}</T>
              <Button small title={t('ed_answers_send')} disabled={disabled} onPress={() => { const p = qPick; setQPick({}); onAnswers(designQs, p); }} style={{ height: dense ? 34 : 44, paddingHorizontal: 16 }} />
            </View>
          ) : null}
        </View>
      ) : null}
      {!aiLimited && !running && question ? (
        <View style={[s.q, dense && s.q2]}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <View style={[s.qic, dense && s.qic2]}><T style={[s.qicT, dense && { fontSize: 12 }]}>?</T></View>
            <View style={{ flex: 1 }}>
              <T style={[{ fontWeight: '500' }, dense ? { fontSize: 13, lineHeight: 18 } : { fontSize: 15, lineHeight: 20 }]}>{question.text}</T>
              {question.kind && !/^[a-z_]+$/.test(question.kind) ? <T v="cap" style={{ marginTop: 2, fontSize: dense ? 12 : 14 }}>{question.kind}</T> : null}
            </View>
          </View>
          <View style={s.ans}>
            {question.options!.slice(0, 4).map((o, oi) => {
              const dl = question.option_deltas?.[oi];
              return (
                <Press key={o} style={[s.an, dense && s.an2]} onPress={() => onSend(o)} disabled={running || disabled} accessibilityRole="button">
                  <T style={[s.anT, dense && { fontSize: 12.5 }]} numberOfLines={1}>{o}</T>
                  {dl != null ? <T num style={{ fontSize: dense ? 11.5 : 13, fontWeight: '600', color: palette.muted }}>{dl === 0 ? '0' : `${dl > 0 ? '+' : '−'}${groupDigits(Math.abs(dl))}`}</T> : null}
                </Press>
              );
            })}
          </View>
        </View>
      ) : null}
      {note ? (
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <Ionicons name="time-outline" size={13} color={palette.muted} />
          <T style={{ flex: 1, fontSize: 12, lineHeight: 16, color: palette.muted }}>{note}</T>
        </View>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  msg: { maxWidth: '84%', borderRadius: 18, paddingVertical: 9, paddingHorizontal: 13 },
  msg2: { maxWidth: '88%', borderRadius: 12, paddingVertical: 7, paddingHorizontal: 10 },
  me: { alignSelf: 'flex-end', backgroundColor: palette.ink },
  meTail: { borderBottomRightRadius: 6 },
  ai: { alignSelf: 'flex-start', backgroundColor: palette.ground },
  aiTail: { borderBottomLeftRadius: 6 },
  chg: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  chip: { borderRadius: 7, paddingVertical: 2, paddingHorizontal: 7, backgroundColor: palette.white },
  chip2: { borderRadius: 5, paddingVertical: 1, paddingHorizontal: 6 },
  chipT: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
  chipT2: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
  undo: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, borderRadius: 11, paddingHorizontal: 11, backgroundColor: palette.ground },
  undo2: { height: 28, borderRadius: 7, paddingHorizontal: 9, backgroundColor: palette.white, borderWidth: 1, borderColor: '#DEDCD7' },
  q: { marginTop: 2, padding: 14, borderRadius: 20, backgroundColor: palette.ground, gap: 10 },
  q2: { padding: 10, borderRadius: 10, gap: 8 },
  qic: { width: 28, height: 28, borderRadius: 9, backgroundColor: palette.blueSoft, alignItems: 'center', justifyContent: 'center' },
  qic2: { width: 22, height: 22, borderRadius: 6 },
  qicT: { fontSize: 14, fontWeight: '800', color: palette.blue },
  ans: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  an: { height: 34, borderRadius: 11, paddingHorizontal: 11, backgroundColor: palette.white, flexDirection: 'row', alignItems: 'center', gap: 5 },
  an2: { height: 28, borderRadius: 7, paddingHorizontal: 9 },
  anT: { fontSize: 14, fontWeight: '500' },
  lim: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: palette.amberSoft },
});
