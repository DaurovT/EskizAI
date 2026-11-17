/**
 * «Разбор чертежа» на широком планшете (TDrawing.dc.html): во всю ширину без боковой панели — строка инструментов
 * («назад», название, «DXF · лист 1 «…»», масштаб), слева холст с листом и метками найденного (зелёные — понял,
 * янтарные — вопрос), справа инспектор 360 «Что взял из чертежа»: найденное с «Изменить», вопросы с «Ответить»
 * (варианты прямо в строке), сведения о листе, «Всё верно, дальше» и «Взять другой лист».
 * Состояние и действия — из экрана разбора (app/project/[id]/breakdown.tsx), здесь только раскладка.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { DesignElement, DesignQuestion } from '../api/types';
import { useT } from '../i18n';
import { DrawingImage } from '../ui/Drawing';
import { Cap2, DBtn, DCard, GridBg, KV2, PaneHead, Toolbar, desk, dk } from '../ui/Desktop';
import { Press, resolveFont } from '../ui/kit';
import { useWideFullWidth } from '../ui/layout';
import { palette } from '../ui/theme';

export type DrawingRow = { key: string; sure: boolean; title: string; est?: boolean; el: DesignElement };
type Drawing = { inboxId: string; title: string; kind: string | null; sheet: string | null; sheetName: string | null };

/** Где на листе стоят метки (доли ширины/высоты холста) — ближе к середине, как в макете. */
const PINS: [number, number][] = [[0.44, 0.43], [0.56, 0.24], [0.46, 0.7], [0.3, 0.3], [0.62, 0.58], [0.34, 0.6], [0.6, 0.4]];
const ZOOMS = [0.5, 0.75, 1, 1.5, 2];

export function DrawingParseWide({
  drawing, photo, running, elapsed, ready, rows, notes, pins, questions, answered, answers, message,
  onFix, onAnswer, onCustom, primary, onOtherSheet, children,
}: {
  drawing: Drawing; photo: string | undefined; running: boolean; elapsed: number;
  /** Разбор уже есть (не первая загрузка). */
  ready: boolean;
  rows: DrawingRow[]; notes: Record<string, { text: string }>;
  pins: { label: string; q: boolean }[];
  questions: DesignQuestion[]; answered: { id: string; text: string; value: string }[]; answers: Record<string, string>;
  message?: string | null;
  onFix: (row: DrawingRow) => void; onAnswer: (qid: string, v: string) => void; onCustom: (q: DesignQuestion) => void;
  primary: { title: string; onPress: () => void; loading?: boolean };
  onOtherSheet: () => void;
  /** Шторки правки и своего ответа экрана разбора. */
  children?: ReactNode;
}) {
  const { t } = useT();
  useWideFullWidth('project/[id]/breakdown', true);
  const [zoom, setZoom] = useState(2);
  const [openQ, setOpenQ] = useState<string | null>(null);
  const sheet = drawing.sheet ? `${t('dr_sheet', { n: drawing.sheet })}${drawing.sheetName ? ` «${drawing.sheetName}»` : ''}` : null;
  const back = () => (router.canGoBack() ? router.back() : router.replace(`/inbox/${drawing.inboxId}`));
  const pct = (v: number) => `${Math.round(v * 100)}%` as const;
  return (
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <Toolbar title={drawing.title} sub={[drawing.kind, sheet].filter(Boolean).join(' · ')} onBack={back}>
        <DBtn icon="remove" label={t('tab_zoom_out')} onPress={() => setZoom((z) => Math.max(0, z - 1))} disabled={zoom === 0} />
        <DBtn title={`${Math.round(ZOOMS[zoom] * 100)}%`} label={t('tab_zoom_fit')} onPress={() => setZoom(2)} style={{ width: 56, paddingHorizontal: 0 }} />
        <DBtn icon="add" label={t('tab_zoom_in')} onPress={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} disabled={zoom === ZOOMS.length - 1} />
      </Toolbar>
      <View style={desk.panes}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={[desk.canvas, { marginRight: 0 }]} accessibilityRole="image" accessibilityLabel={drawing.sheetName ?? drawing.title}>
            <GridBg />
            {/* метки — поверх листа, в долях его размера */}
            <View style={{ width: pct(ZOOMS[zoom] * 0.78), aspectRatio: 1.45 }}>
              <DrawingImage uri={photo} style={{ flex: 1, backgroundColor: 'transparent' }} />
              {!running ? pins.slice(0, PINS.length).map((p, i) => (
                <View key={`${i}-${p.label}`} pointerEvents="none" style={[s.mk, p.q && s.mkQ, { left: pct(PINS[i][0]), top: pct(PINS[i][1]) }]}>
                  <View style={[s.dot, { backgroundColor: p.q ? palette.amber : palette.green }]} />
                  <Text style={resolveFont([s.mkT, p.q && { color: '#6E3C00' }])} numberOfLines={1}>{p.label}</Text>
                </View>
              )) : null}
            </View>
          </View>
        </View>
        <View style={s.insp}>
          <PaneHead style={{ height: 24, paddingHorizontal: 2 }}>{t('dr_found_title')}</PaneHead>
          <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ gap: 10 }} showsVerticalScrollIndicator={false}>
            <DCard>
              {answered.map((a) => (
                <Item key={`a${a.id}`} ok title={a.text} sub={a.value} />
              ))}
              {questions.map((q) => (
                <View key={`q${q.id}`}>
                  <Item ok={false} title={q.text} sub={[t('dr_not_on_sheet'), answers[q.id] ?? (q.default ? t('tab_dr_default', { v: q.default }) : null)].filter(Boolean).join(' · ')}
                    link={answers[q.id] ? t('rec_fix') : t('tab_dr_answer')} onLink={() => setOpenQ(openQ === q.id ? null : q.id)} />
                  {openQ === q.id ? (
                    <View style={s.opts}>
                      {[...q.options, t('q_dont_know_short')].map((o) => (
                        <Press key={o} feedback="scale" onPress={() => { onAnswer(q.id, o); setOpenQ(null); }} accessibilityRole="radio"
                          accessibilityState={{ selected: answers[q.id] === o }} style={[s.opt, answers[q.id] === o && s.optOn]}>
                          <Text style={resolveFont([s.optT, answers[q.id] === o && { color: palette.white }])}>{o}</Text>
                        </Press>
                      ))}
                      <Press feedback="scale" onPress={() => { setOpenQ(null); onCustom(q); }} accessibilityRole="button" style={s.opt}>
                        <Text style={resolveFont(s.optT)}>{t('bd_q_custom')}</Text>
                      </Press>
                    </View>
                  ) : null}
                </View>
              ))}
              {rows.map((r) => (
                <Item key={r.key} ok={r.sure} title={r.title}
                  sub={notes[r.key]?.text ?? r.el.note ?? (r.est ? t('rec_est') : !r.sure ? t('bd_proposed') : null)}
                  link={t('rec_fix')} onLink={() => onFix(r)} />
              ))}
              {!rows.length && !questions.length && !answered.length ? (
                <View style={s.wait}><ActivityIndicator color={palette.chev} /><Cap2>{t('rec_building')}</Cap2></View>
              ) : null}
            </DCard>
            <DCard style={{ paddingVertical: 4, paddingHorizontal: 12 }}>
              {sheet ? <KV2 k={t('tab_dr_sheet')} v={sheet.replace(/^./, (c) => c.toUpperCase())} /> : null}
              <KV2 k={t('tab_dr_format')} v={drawing.kind ?? '—'} />
              <KV2 k={t('tab_dr_questions')} v={questions.length ? String(questions.length) : t('tab_dr_none')} last />
            </DCard>
            {message && !running ? <Cap2>{message}</Cap2> : null}
          </ScrollView>
          <View style={{ flex: 1 }} />
          {running ? <Cap2 style={{ textAlign: 'center' }}>{`${ready ? t('bd_recalc_running') : t('bd_working_hint')} · ${t('bd_elapsed', { s: elapsed })}`}</Cap2> : null}
          <DBtn primary title={primary.title} onPress={primary.onPress} disabled={running || primary.loading || !ready} style={{ height: 38 }} />
          <DBtn title={t('dr_other_sheet')} onPress={onOtherSheet} disabled={running} />
        </View>
      </View>
      {children}
    </View>
  );
}

/** .it — строка «что взял»: зелёная галочка или янтарный «?», название, подпись, ссылка справа. */
function Item({ ok, title, sub, link, onLink }: { ok: boolean; title: string; sub?: string | null; link?: string; onLink?: () => void }) {
  return (
    <View style={s.it}>
      <View style={[s.ic, ok ? s.ok2 : s.q2]}>
        {ok ? <Ionicons name="checkmark" size={12} color={palette.greenDeep} /> : <Text style={resolveFont(s.qT)}>?</Text>}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={resolveFont(s.itT)}>{title}</Text>
        {sub ? <Cap2>{sub}</Cap2> : null}
      </View>
      {link && onLink ? (
        <Press feedback="opacity" onPress={onLink} hitSlop={8} accessibilityRole="button" accessibilityLabel={`${link}: ${title}`}>
          <Text style={resolveFont(s.lnk)}>{link}</Text>
        </Press>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.ground },
  mk: {
    position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 5, height: 24, paddingHorizontal: 8, borderRadius: 6,
    backgroundColor: palette.white, boxShadow: '0px 2px 8px rgba(33,32,31,0.15)', maxWidth: 220,
  },
  mkQ: { backgroundColor: palette.amberSoft },
  mkT: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: palette.ink },
  dot: { width: 8, height: 8, borderRadius: 4 },
  insp: { width: 360, padding: 12, gap: 10 },
  it: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 9, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: dk.kvLine },
  ic: { width: 18, height: 18, borderRadius: 5, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  ok2: { backgroundColor: palette.greenSoft },
  q2: { backgroundColor: palette.amberSoft },
  qT: { fontSize: 12, lineHeight: 14, fontWeight: '800', color: palette.amberDeep },
  itT: { fontSize: 14, lineHeight: 19, fontWeight: '600', color: palette.ink },
  lnk: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: palette.greenPress },
  opts: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: dk.kvLine },
  opt: { height: 30, borderRadius: 8, backgroundColor: palette.ground, paddingHorizontal: 10, justifyContent: 'center' },
  optOn: { backgroundColor: palette.ink },
  optT: { fontSize: 13, lineHeight: 17, fontWeight: '600', color: palette.ink },
  wait: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
});
