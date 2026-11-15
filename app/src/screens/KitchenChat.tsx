/**
 * Переписка с ИИ в редакторе кухни — как в шторке редактора шкафа (SCR-08): сообщения мастера справа, ответы ИИ со
 * временем, «ИИ думает…», последняя правка с «Отменить» / «Вернуть», вопросы ИИ с вариантами (распознавания —
 * выбрать и «Отправить ответы» разом; один — тап сразу отвечает). Данные и отправка — те же, что у шкафа (editor.tsx).
 */
import { MaterialCommunityIcons } from '@expo/vector-icons';
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

const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

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
};

export function KitchenChat({ messages, questions, running, elapsed, canUndo, canRedo, busy, disabled, aiLimited, onUndo, onRedo, onSend, onAnswers }: KitchenChatProps) {
  const { t, lang } = useT();
  const scroll = useRef<ScrollViewInstance>(null);
  const userScrolled = useRef(false);
  const [qPick, setQPick] = useState<Record<string, string>>({});
  const { history, lastChange, designQs, question } = chatView(messages, questions);
  const empty = !history.length && !lastChange && !designQs.length && !question && !running && !aiLimited;
  return (
    <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end', paddingTop: 10, paddingBottom: 6 }} keyboardShouldPersistTaps="handled"
      onContentSizeChange={() => { if (!userScrolled.current) scroll.current?.scrollToEnd({ animated: false }); }} onScrollBeginDrag={() => { userScrolled.current = true; }}>
      {empty ? <T v="sub" style={{ paddingHorizontal: 16, paddingBottom: 8, color: palette.muted }}>{t('kit_chat_empty')}</T> : null}
      {history.map((m) => m.author === 'master' ? (
        <View key={m.id} style={[s.me, m.undone && { opacity: 0.5 }]}><T style={{ fontSize: 15, lineHeight: 20, fontWeight: '600' }}>{m.text}</T></View>
      ) : (
        <View key={m.id} style={[s.ai, m.undone && { opacity: 0.5 }]}>
          <T num style={{ fontSize: 13, lineHeight: 20, width: 46, color: palette.muted }}>{hhmm(m.created_at)}</T>
          <T style={{ flex: 1, fontSize: 15, lineHeight: 20, color: m.kind === 'question' || m.kind === 'error' ? palette.ink : palette.muted }}>{m.text}</T>
        </View>
      ))}
      {aiLimited ? (
        <Press onPress={() => router.push('/paywall' as never)} style={s.lim} accessibilityRole="button">
          <MaterialCommunityIcons name="star-four-points-outline" size={20} color="#6E3C00" />
          <View style={{ flex: 1 }}>
            <T v="bt" color="#6E3C00">{t('ail_title')}</T>
            <T v="bd" color="#6E3C00" style={{ marginTop: 2 }}>{t('ail_text')}</T>
          </View>
        </Press>
      ) : running ? (
        <View style={s.chg}>
          <View style={s.ok}><ActivityIndicator size="small" color={palette.green} /></View>
          <T style={{ flex: 1, fontSize: 15, fontWeight: '700' }}>{t('ed_ai_thinking')} {elapsed ? `${elapsed} с` : ''}</T>
        </View>
      ) : lastChange ? (
        <View style={s.chg}>
          <View style={s.ok}><MaterialCommunityIcons name={lastChange.undone ? 'undo-variant' : 'check-bold'} size={16} color={palette.green} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={{ fontSize: 15, lineHeight: 20, fontWeight: '700' }} numberOfLines={2}>{lastChange.text}</T>
            {(() => {
              const line = [lastChange.kind && /\d/.test(lastChange.kind) ? lastChange.kind : null, formatDelta(lastChange.price_delta, lang)].filter(Boolean).join(' · ');
              return line ? <T num style={{ fontSize: 13, lineHeight: 18, color: palette.muted }}>{noCurrency(line)}</T> : null;
            })()}
          </View>
          <Button v="secondary" small title={lastChange.undone ? t('ed_return') : t('ed_undo')} style={{ height: 40 }}
            disabled={busy || disabled || (lastChange.undone ? !canRedo : !canUndo)} onPress={lastChange.undone ? onRedo : onUndo} />
        </View>
      ) : null}
      {!aiLimited && !running && designQs.length ? (
        <View style={s.q}>
          {designQs.length > 1 ? <T v="cap" style={{ fontSize: 13 }}>{t('ed_q_pick')}</T> : null}
          {designQs.map((q) => (
            <View key={q.id} style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                <View style={s.dot} />
                <T style={{ flex: 1, fontSize: 15, lineHeight: 21, fontWeight: '700' }}>{q.text}</T>
              </View>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {q.options.slice(0, 3).map((o) => {
                  const on = qPick[q.id] === o;
                  return (
                    <Press key={o} style={[s.ans, on && { backgroundColor: palette.ink }]} disabled={disabled} accessibilityRole="radio" accessibilityState={{ selected: on }}
                      onPress={() => {
                        haptics.selection();
                        if (designQs.length === 1) { setQPick({}); onAnswers(designQs, { [q.id]: o }); }
                        else setQPick((cur) => { const n = { ...cur }; if (n[q.id] === o) delete n[q.id]; else n[q.id] = o; return n; });
                      }}>
                      <T style={[s.ansT, on && { color: palette.white }]} numberOfLines={2}>{o}</T>
                    </Press>
                  );
                })}
              </View>
            </View>
          ))}
          {designQs.length > 1 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <T v="cap" style={{ flex: 1, fontSize: 13 }} numberOfLines={2}>{t('ed_answers_left', { i: designQs.filter((q) => qPick[q.id]).length, n: designQs.length })}</T>
              <Button small title={t('ed_answers_send')} disabled={disabled} onPress={() => { const p = qPick; setQPick({}); onAnswers(designQs, p); }} style={{ height: 44, paddingHorizontal: 16 }} />
            </View>
          ) : null}
        </View>
      ) : null}
      {!aiLimited && !running && question ? (
        <View style={s.q}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <View style={s.dot} />
            <View style={{ flex: 1 }}>
              <T style={{ fontSize: 15, lineHeight: 21, fontWeight: '700' }}>{question.text}</T>
              {question.kind && !/^[a-z_]+$/.test(question.kind) ? <T v="cap" style={{ marginTop: 2 }}>{question.kind}</T> : null}
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {question.options!.slice(0, 3).map((o, oi) => {
              const dl = question.option_deltas?.[oi];
              return (
                <Press key={o} style={s.ans} onPress={() => onSend(o)} disabled={running || disabled} accessibilityRole="button">
                  <T style={s.ansT} numberOfLines={2}>{o}</T>
                  {dl != null ? <T num style={{ fontSize: 13, fontWeight: '600', color: palette.muted }}>{dl === 0 ? '0' : `${dl > 0 ? '+' : '−'}${groupDigits(Math.abs(dl))}`}</T> : null}
                </Press>
              );
            })}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  me: { alignSelf: 'flex-end', maxWidth: '80%', marginHorizontal: 16, marginTop: 8, paddingVertical: 10, paddingHorizontal: 14, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderBottomRightRadius: 6, borderBottomLeftRadius: 18, backgroundColor: palette.segOnWhite },
  ai: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, minHeight: 40, paddingVertical: 8, paddingHorizontal: 16 },
  chg: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16 },
  ok: { width: 32, height: 32, borderRadius: 10, backgroundColor: palette.greenSoft, alignItems: 'center', justifyContent: 'center' },
  q: { marginTop: 4, marginHorizontal: 12, padding: 14, borderRadius: 20, backgroundColor: palette.ground, gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 7, backgroundColor: palette.amber },
  ans: { flex: 1, minHeight: 56, borderRadius: 14, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center', paddingVertical: 6, paddingHorizontal: 4, shadowColor: palette.ink, shadowOpacity: 0.06, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } },
  ansT: { fontSize: 14, lineHeight: 18, fontWeight: '700', textAlign: 'center' },
  lim: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginHorizontal: 16, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: palette.amberSoft },
});
