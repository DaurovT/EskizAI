/**
 * SCR-05 Разбор фото (Recognition.dc.html) / SCR-29 Разбор описания (TextParse.dc.html).
 * Запускает POST …/ai/design (если пришли с SCR-04), опрашивает задачу, показывает найденные элементы
 * метками на фото и списком «Что я нашёл»; карандаш у строки — исправить. Таймаут 90 с → выбор типа вручную.
 * SCR-05b (RecognitionMulti.dc.html): несколько предметов на фото → мультивыбор; каждый — отдельный проект (лимит за каждый).
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Animated, Easing, Image, Linking, ScrollView, StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import { ApiError } from '../../../src/api/errors';
import { BudgetDeclinedError, TaskTimeoutError, withBudgetConfirm } from '../../../src/api/tasks';
import type { ChooseObjectsOut, DesignElement, DesignObject, DesignOut, EditOut } from '../../../src/api/types';
import { useAiTask } from '../../../src/hooks/useAiTask';
import { useT } from '../../../src/i18n';
import { applyDesign, pendingDesign } from '../../../src/services/design';
import { loadMeta, updateMeta, useMeta } from '../../../src/state/projectMeta';
import { askBudget, errorInfo, showError } from '../../../src/ui/dialogs';
import { StackHeader14 } from '../../../src/ui/navigation';
import { PhotoBoxes, Pin, coverMap, usePhotoRatio } from '../../../src/ui/PhotoBoxes';
import { ErrorScreen } from '../../../src/ui/ErrorState';
import { SUPPORT_TG } from '../../../src/config';
import { Banner, Button, Card, Field, Press, Screen, Sheet, Skeleton, T } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** «≈ 1200 × 600 × 2200 · 2 двери» */
const objectLine = (o: DesignObject) =>
  [o.size?.length === 3 ? `≈ ${o.size.join(' × ')}` : null, o.summary || null].filter(Boolean).join(' · ');
/** Русское склонение для 2–4 / 5+ (больше 10 предметов не бывает). */
const fewOrMany = (n: number) => (n >= 5 ? 'many' : 'few');
const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'one' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'few' : 'many');
const elTitle = (el: DesignElement) => `${el.name}${el.count > 1 ? ` × ${el.count}` : ''}`;
const TINTS = ['#CDBFA8', '#DCD3C1', '#D9D2C6', '#CFC6B5', '#E0D4BF'];

/** dev (?shot=…): состояние как в макетах — без ИИ и без настоящих фото. */
const SHOT_DESIGN: Record<string, { photos: string[]; design: DesignOut }> = __DEV__ ? {
  recognition: {
    photos: ['', ''],
    design: {
      status: 'questions', product_kind: 'wardrobe', confidence: 0.82, alternatives: [], understood: [], unclear: [], estimated: [], differences: [],
      elements: [
        { name: 'Шкаф распашной, 3 секции', kind: 'body', count: 1, sure: true, note: 'Корпус · 3 секции' },
        { name: 'Скругление R≈300', kind: 'radius', count: 1, sure: false, note: 'Радиусный торец?' },
        { name: 'Фасады МДФ, канавки', kind: 'door', count: 1, sure: true, note: 'Фасад рифлёный' },
        { name: 'Без ручек (push)', kind: 'handle', count: 1, sure: true, note: 'Без ручек' },
        { name: 'Ножки металл · партнёр', kind: 'legs', count: 1, sure: false, note: 'Ножки металл?' },
      ],
      questions: [{ id: 'q_width', text: 'Какая ширина?', options: ['1800 мм'] }], message: null, version_id: null, issues: [], error: null,
    },
  },
  multi: {
    photos: [''],
    design: {
      status: 'questions', product_kind: 'wardrobe', confidence: 0.8, alternatives: [], elements: [], understood: [], unclear: [], estimated: [], differences: [],
      objects: [
        { label: 'Шкаф распашной', photo: 0, box: [0.055, 0.11, 0.377, 0.856], chosen: true, size: [1200, 600, 2200], summary: '2 двери' },
        { label: 'Тумба под ТВ', photo: 0, box: [0.415, 0.576, 0.738, 0.839], chosen: false, size: [1600, 400, 450], summary: '3 ящика' },
        { label: 'Комод', photo: 0, box: [0.776, 0.424, 0.945, 0.847], chosen: false, size: [800, 450, 900], summary: '3 ящика' },
      ],
      questions: [{ id: 'object', text: '', options: [] }], message: null, version_id: null, issues: [], error: null,
    },
  },
  badphoto: {
    photos: [''],
    design: { status: 'failed', product_kind: null, confidence: 0, alternatives: [], elements: [], understood: [], unclear: [], estimated: [], questions: [], differences: [], message: 'Не вижу мебель на фото', version_id: null, issues: [], error: 'not_furniture' },
  },
  aifail: {
    photos: [''],
    design: { status: 'failed', product_kind: null, confidence: 0, alternatives: [], elements: [], understood: [], unclear: [], estimated: [], questions: [], differences: [], message: null, version_id: null, issues: [], error: null },
  },
  text: {
    photos: [],
    design: {
      status: 'ready', product_kind: 'kitchen', confidence: 0.86, alternatives: [], estimated: ['/height'], differences: [],
      understood: ['Кухня прямая · 2800 мм', 'Верхние модули до потолка', 'Фасады: белый матовый'],
      elements: [{ name: 'Мойка справа · ПММ 450', kind: 'module', count: 1, sure: true }],
      unclear: ['Декор столешницы', 'Где духовка?'],
      questions: [], message: 'Потолок не указан, ставлю 2700 мм как оценку. Уточните на замере', version_id: 'v1', issues: [], error: null,
    },
  },
} : {};

export default function Breakdown() {
  const { id, shot } = useLocalSearchParams<{ id: string; shot?: string }>();
  const { t, lang } = useT();
  const meta = useMeta(id);
  const ai = useAiTask();
  const [fix, setFix] = useState<DesignElement | 'add' | null>(null);
  const [fixText, setFixText] = useState('');
  const [opening, setOpening] = useState(false);
  const [picked, setPicked] = useState<number[] | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourceText, setSourceText] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const d = meta.design;
  const isPhoto = meta.photos.length > 0;
  const objects = d?.objects ?? [];
  // Несколько предметов, а выбор ещё не сделан — экран мультивыбора (SCR-05b)
  const multi = objects.length > 1 && !!d?.questions.some((q) => q.id === 'object');
  const chosenIdx = Math.max(0, objects.findIndex((o) => o.chosen));
  const sel = picked ?? (multi ? [chosenIdx] : []);
  const toggle = (i: number) => setPicked(sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i]);

  const startDesign = useCallback(async (text: string | null, photo_ids: string[]) => {
    const r = await ai.run<DesignOut>((confirm) => api.aiDesign(id, { text, photo_ids, language: lang, ...(confirm ? { confirm_extra_project: true } : {}) }));
    if (r) applyDesign(id, r, { from: 'breakdown', replace: true });
  }, [ai, id, lang]);

  useEffect(() => {
    if (__DEV__ && shot && SHOT_DESIGN[shot]) {
      updateMeta(id, { photos: SHOT_DESIGN[shot].photos, design: SHOT_DESIGN[shot].design, answers: {} });
      if (shot === 'text') setSourceText('Кухня прямая 2,8 м, верх до потолка, фасады белый матовый, столешница под камень, мойка справа, место под духовку и посудомойку 45 см.');
      return;
    }
    loadMeta(id).then(() => {
      const req = pendingDesign.get()[id];
      if (req) {
        pendingDesign.set((s) => { const n = { ...s }; delete n[id]; return n; });
        startDesign(req.text, req.photo_ids);
      }
    });
    api.getProject(id).then((p) => setSourceText(p.source_text ?? null)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, shot]);

  const sendFix = async () => {
    const text = fixText.trim();
    if (!text) return;
    const el = fix;
    setFix(null);
    setFixText('');
    const instruction = el && el !== 'add' ? `${el.name}: ${text}` : text;
    if (d?.version_id) {
      const r = await ai.run<EditOut>((c) => api.aiEdit(id, instruction, c));
      if (r && !r.ok && (r.question || r.error)) showError(new Error(r.question ?? r.error ?? ''), lang);
    } else {
      const card = await api.getProject(id).catch(() => null);
      await startDesign(instruction, card?.photos.filter((p) => p.kind === 'source').map((p) => p.id) ?? []);
    }
  };

  const buildObjects = async () => {
    if (!sel.length) return;
    setSplitting(true);
    let r: ChooseObjectsOut;
    try {
      // 402 бюджета ИИ — спросить и повторить; 402 лимита — сразу к лимиту и тарифам
      r = await withBudgetConfirm((c) => api.aiChooseObjects(id, sel, c),
        (e) => (e.code === 'ai_budget_exceeded' ? askBudget(lang)(e) : Promise.reject(e)));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'limit_exhausted') {
        Alert.alert(t('err_limit_title'), e.message, [
          { text: t('cancel'), style: 'cancel' },
          { text: t('bd_multi_to_limits'), onPress: () => router.push('/profile') },
        ]);
      } else if (!(e instanceof BudgetDeclinedError)) showError(e, lang);
      return;
    } finally {
      setSplitting(false);
    }
    const created = r.projects.filter((p) => p.created);
    // Новым проектам — те же локальные фото, чтобы рамки показывались и там
    for (const p of created) updateMeta(p.project_id, { photos: meta.photos });
    setNotice(created.length ? t('bd_multi_created', { n: created.length }) : null);
    setPicked(null);
    updateMeta(id, { answers: {} });
    const own = r.projects[0];
    const res = await ai.run<DesignOut>(async () => ({ task_id: own.task_id }));
    if (res) applyDesign(id, res, { from: 'breakdown', replace: true });
  };

  const openModel = async () => {
    setOpening(true);
    try {
      const card = await api.getProject(id);
      if (card.status === 'draft' && card.current_version_id) await api.toSketch(id).catch(() => undefined);
      router.replace(`/project/${id}/editor`);
    } catch (e) {
      showError(e, lang);
    } finally {
      setOpening(false);
    }
  };
  /** «Всё верно, дальше»: вопросы (SCR-07) → выбор типа (SCR-06) → модель. */
  const next = () => {
    if (d?.status === 'questions') router.push(`/project/${id}/questions`);
    else if (d?.status === 'choose_type') router.push(`/project/${id}/choose-type`);
    else openModel();
  };

  const fixSheet = (
    <Sheet visible={!!fix} onClose={() => setFix(null)} title={fix && fix !== 'add' ? `${t('bd_fix_title')} — ${fix.name}` : t('bd_add_text')}>
      <Field value={fixText} onChangeText={setFixText} placeholder={fix && fix !== 'add' ? t('bd_fix_ph') : t('bd_add_text_ph')} multiline autoFocus />
      <Button title={t('ed_send')} onPress={sendFix} disabled={!fixText.trim()} />
    </Sheet>
  );

  // шапка: «назад» + справа плашка («Фото 1 из 2» / «Нашёл 3 предмета»); у разбора описания — большой заголовок
  const pill = (label: string) => () => <View style={s.pill}><T style={s.pillText}>{label}</T></View>;
  const head = (title: string, right?: string) => (
    <Stack.Screen options={{ title, headerRight: right ? pill(right) : undefined, header: (p) => <StackHeader14 {...p} /> }} />
  );
  const photoPill = isPhoto && meta.photos.length > 1 ? t('rec_photo_of', { n: page + 1, total: meta.photos.length }) : undefined;

  const slowShot = __DEV__ && shot === 'slow';
  const failed = slowShot || (!ai.running && (ai.error || d?.status === 'failed'));
  if (failed) {
    const timeout = slowShot || ai.error instanceof TaskTimeoutError;
    const info = ai.error ? errorInfo(ai.error, lang) : null;
    const badPhoto = d?.error === 'not_furniture' || /мебел/i.test(d?.message ?? '');
    const support = { title: t('sys_support_tg'), onPress: () => Linking.openURL(`https://t.me/${SUPPORT_TG}`) };
    const toType = { title: t('bd_choose_type'), onPress: () => router.push(`/project/${id}/choose-type`) };
    const describe = { title: t('err_describe'), onPress: () => setFix('add') };
    return (
      <>
        {head('')}
        {timeout ? (
          <ErrorScreen icon="time-outline" tone="blue" title={t('err_slow_title')} text={t('err_slow_text')}
            primary={{ title: t('err_slow_ok'), onPress: () => router.replace('/') }} secondary={toType} ghost={{ title: t('cancel'), onPress: () => router.back() }} />
        ) : info?.kind === 'offline' ? (
          <ErrorScreen icon="cloud-offline-outline" tone="gray" title={info.title} text={info.text}
            primary={{ title: t('retry'), onPress: () => { ai.setError(null); setFix('add'); } }} secondary={describe} ghost={support} />
        ) : badPhoto ? (
          <ErrorScreen icon="image-outline" tone="amber" title={t('err_bad_photo_title')} text={t('err_bad_photo_text2')} note={t('err_no_limit')}
            primary={{ title: t('err_retake'), onPress: () => router.replace('/project/new') }} secondary={describe} ghost={support} />
        ) : (
          <ErrorScreen icon="cube-outline" tone="amber" title={t('err_parse_title')} text={d?.message || t('err_parse_text')} note={t('err_no_limit')}
            primary={toType} secondary={describe} ghost={{ title: t('bd_nonstandard'), onPress: () => router.push(`/project/${id}/nonstandard`) }} />
        )}
        {fixSheet}
      </>
    );
  }

  // ---------- SCR-05b: несколько предметов ----------
  if (multi && !ai.running && d) {
    const cnt = sel.length;
    const cta = cnt === 1 ? t('bd_multi_build_one', { name: cap(objects[sel[0]].label.split(' ')[0]) })
      : t(fewOrMany(cnt) === 'many' ? 'bd_multi_build_many' : 'bd_multi_build_few', { n: cnt });
    const shots = [...new Set(objects.map((o) => o.photo))].filter((i) => meta.photos[i] != null);
    return (
      <Screen gap={8} contentStyle={{ paddingTop: 0 }} footerStyle={{ gap: 2, paddingTop: 4 }}
        footer={<>
          <Button title={cnt ? cta : t('bd_multi_pick')} value={cnt > 1 ? t('bd_multi_limit', { n: cnt }) : undefined} onPress={buildObjects} disabled={!cnt} loading={splitting} />
          <Button v="ghost" title={t('bd_multi_none')} onPress={() => router.push(`/project/${id}/choose-type`)} />
        </>}
      >
        {head('', t(fewOrMany(objects.length) === 'many' ? 'bd_multi_found_many' : 'bd_multi_found_few', { n: objects.length }))}
        {shots.map((ph) => (
          <PhotoBoxes key={ph} uri={meta.photos[ph]} tint={TINTS[ph % TINTS.length]} objects={objects} photo={ph} picked={sel} onToggle={toggle} height={236} style={{ marginBottom: 4 }} />
        ))}
        <View style={{ paddingHorizontal: 8 }}>
          <T style={{ fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -0.5 }}>{t('bd_multi_title')}</T>
          <T v="cap" style={{ marginTop: 2 }}>{t('bd_multi_hint')}</T>
        </View>
        {objects.map((o, i) => {
          const on = sel.includes(i);
          const line = objectLine(o);
          return (
            <Press key={`${i}-${o.label}`} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`${i + 1}. ${o.label}`}
              onPress={() => toggle(i)} style={s.mit}>
              <ObjectThumb uri={meta.photos[o.photo]} box={o.box} tint={TINTS[o.photo % TINTS.length]} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T v="rt" numberOfLines={1}>{`${i + 1} · ${cap(o.label)}`}</T>
                {line ? <T v="rs" numberOfLines={1}>{line}</T> : null}
              </View>
              <View style={[s.ck, on && s.ckOn]}>{on ? <MaterialCommunityIcons name="check-bold" size={16} color={palette.white} /> : null}</View>
              {on ? <View pointerEvents="none" style={s.mitOn} /> : null}
            </Press>
          );
        })}
        <View style={s.note}>
          <Ionicons name="information-circle-outline" size={20} color={palette.muted2} />
          <T v="bd" style={{ flex: 1 }}>{t('bd_multi_note')}</T>
        </View>
        {fixSheet}
      </Screen>
    );
  }

  // ---------- SCR-29: разбор описания ----------
  if (!isPhoto && d && !ai.running) {
    // вопросы ИИ задаст в чате: по неясным пунктам, если отдельных вопросов нет
    const qn = d.questions.length || d.unclear.length;
    const kitchen = d.product_kind?.startsWith('kitchen');
    const ask = () => (d.questions.length ? router.push(`/project/${id}/questions`) : setFix('add'));
    return (
      <Screen gap={8} contentStyle={{ paddingTop: 0 }} footerStyle={{ gap: 2, paddingTop: 6 }}
        footer={<>
          <Button title={d.status === 'choose_type' ? t('bd_choose_type') : kitchen ? t('tp_cta_kitchen') : t('tp_cta')}
            value={qn ? t(`tp_q_${plural(qn)}` as 'tp_q_one', { n: qn }) : undefined} onPress={next} loading={opening} />
          <Button v="ghost" title={t('tp_more')} onPress={() => setFix('add')} />
        </>}
      >
        {head(t('bd_text_title'))}
        {sourceText ? <Card><Marked text={sourceText} ok={[...d.understood, ...d.elements.map((e) => e.name)]} unclear={d.unclear} /></Card> : null}
        <Card padded={false}>
          <T style={{ fontSize: 18, lineHeight: 24, fontWeight: '700', paddingTop: 14, paddingHorizontal: 20, paddingBottom: 4 }}>{t('tp_build')}</T>
          {d.understood.map((u, i) => <FoundRow key={`u${i}`} sure title={u} compact first={i === 0} fixLabel={t('rec_fix')} onFix={() => setFix({ name: u, kind: 'text', count: 1, sure: true })} />)}
          {d.unclear.map((u, i) => <FoundRow key={`q${i}`} sure={false} title={u} compact first={!d.understood.length && i === 0} answer={t('tp_answer')} onFix={ask} />)}
          {d.elements.map((el, i) => <FoundRow key={`e${i}`} sure={el.sure} title={elTitle(el)} compact first={false} fixLabel={t('rec_fix')} onFix={() => setFix(el)} />)}
        </Card>
        {d.message ? <Banner tone="est" icon="information-circle-outline" text={d.message} /> : null}
        {fixSheet}
      </Screen>
    );
  }

  // ---------- SCR-05: разбор фото (и ожидание ИИ) ----------
  const rows: { key: string; sure: boolean; title: string; est?: boolean; el: DesignElement }[] = d && !ai.running ? [
    ...d.elements.map((el, i) => ({ key: `e${i}`, sure: el.sure, title: elTitle(el), est: !el.sure && /≈/.test(el.name), el })),
    ...d.unclear.map((u, i) => ({ key: `u${i}`, sure: false, title: u, el: { name: u, kind: 'unclear', count: 1, sure: false } })),
    ...d.differences.map((u, i) => ({ key: `d${i}`, sure: false, title: u, el: { name: u, kind: 'difference', count: 1, sure: false } })),
  ] : [];
  const pins = d && !ai.running ? d.elements.slice(0, 6) : [];
  return (
    <Screen gap={8} contentStyle={{ paddingTop: 0 }} footerStyle={{ gap: 2, paddingTop: 6 }}
      footer={<>
        <Button title={t('rec_ok_next')} onPress={next} loading={opening} disabled={ai.running || !d} />
        <Button v="ghost" title={t('rec_wrong')} onPress={() => router.push(`/project/${id}/nonstandard`)} />
      </>}
    >
      {head(isPhoto ? '' : t('bd_text_title'), photoPill)}
      {isPhoto ? (
        <PhotoPager photos={meta.photos} page={page} onPage={setPage}>
          {pins.length ? (
            <ScatterPins labels={pins.map((el) => ({ label: el.note && el.note.length <= 22 ? el.note : el.name, q: !el.sure }))} />
          ) : null}
        </PhotoPager>
      ) : null}
      {notice ? <Banner tone="ok" icon="albums-outline" text={notice} /> : null}
      <View style={s.foundHead}>
        <T style={{ fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3 }}>{t('rec_found_title')}</T>
        {ai.running || !d || !d.version_id ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ring />
            <T v="cap">{t('rec_building')}</T>
          </View>
        ) : null}
      </View>
      <Card padded={false}>
        {rows.length ? rows.map((r, i) => (
          <FoundRow key={r.key} sure={r.sure} title={r.title} est={r.est} first={i === 0} fixLabel={t('rec_fix')} estLabel={t('rec_est')} onFix={() => setFix(r.el)} />
        )) : (
          [0, 1, 2].map((i) => (
            <View key={i} style={[s.it, i > 0 && s.itLine]}>
              <Skeleton width={28} height={28} r={9} />
              <Skeleton width={i === 1 ? 140 : 200} height={16} r={8} />
            </View>
          ))
        )}
      </Card>
      {ai.running ? <T v="cap" center>{t('bd_working_hint')} · {t('bd_elapsed', { s: ai.elapsed })}</T> : null}
      {d?.message && !ai.running ? <T v="cap" style={{ paddingHorizontal: 8 }}>{d.message}</T> : null}
      {fixSheet}
    </Screen>
  );
}

/**
 * Исходное описание с подсветкой понятого (.hl зелёным) и неясного (.hq янтарным). Разметки по словам ИИ не присылает —
 * подсвечиваем подряд идущие слова, совпавшие (по началу слова) со словами пунктов разбора; числа и единицы рядом — тоже.
 */
function Marked({ text, ok, unclear }: { text: string; ok: string[]; unclear: string[] }) {
  const stem = (w: string) => w.toLowerCase().replace(/[^0-9a-zа-яёʻ‘']/gi, '');
  const key = (w: string) => stem(w).slice(0, Math.min(5, stem(w).length));
  const bag = (items: string[]) => new Set(items.flatMap((i) => i.split(/[\s·:,.?]+/)).map(key).filter((k) => k.length >= 3));
  const okSet = bag(ok);
  const qSet = bag(unclear);
  const words = text.split(/\s+/).filter(Boolean);
  // «верх» ~ «верхние»: совпадение по началу (не короче 4 букв)
  const has = (set: Set<string>, k: string) => set.has(k) || (k.length >= 4 && [...set].some((x) => x.length >= 4 && (x.startsWith(k) || k.startsWith(x))));
  const kind = words.map((w) => { const k = key(w); return k.length < 3 ? null : has(qSet, k) ? 'q' : has(okSet, k) ? 'ok' : null; });
  // короткие связки («до», «под») внутри одной подсветки и числа/единицы рядом с ней — в ту же подсветку
  const glue = (i: number) => /^([0-9]+([.,][0-9]+)?|м|см|мм|до|в|на)[,.]?$/i.test(words[i]);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < words.length; i++) {
      if (kind[i] || !glue(i)) continue;
      const prev = kind[i - 1];
      const next = kind[i + 1];
      if (prev && (next === prev || /[0-9]|^(м|см|мм)/i.test(words[i]))) kind[i] = prev;
      else if (!prev && next && /[0-9]/.test(words[i])) kind[i] = next;
    }
  }
  const runs: { k: 'ok' | 'q' | null; ws: string[] }[] = [];
  words.forEach((w, i) => {
    const last = runs[runs.length - 1];
    // знак препинания в конце слова закрывает подсветку
    if (last && last.k === kind[i] && kind[i] && !/[,.;]$/.test(last.ws[last.ws.length - 1])) last.ws.push(w);
    else runs.push({ k: kind[i] as 'ok' | 'q' | null, ws: [w] });
  });
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 0 }}>
      {runs.flatMap((r, ri) => {
        if (!r.k) return r.ws.map((w, wi) => <T key={`${ri}-${wi}`} style={s.mdText}>{`${w} `}</T>);
        const joined = r.ws.join(' ');
        const m = /^(.*?)([,.;:!?]*)$/.exec(joined);
        return [
          <View key={`${ri}`} style={[s.mark, r.k === 'q' ? s.markQ : s.markOk]}>
            <T style={[s.mdText, s.markText, { color: r.k === 'q' ? '#6E3C00' : '#1F4A2F' }]}>{m?.[1] ?? joined}</T>
          </View>,
          <T key={`${ri}p`} style={s.mdText}>{`${m?.[2] ?? ''} `}</T>,
        ];
      })}
    </View>
  );
}

/** .spinner — кольцо 18, 2.5 px #CFE3D6 с зелёным сегментом, оборот 0.8 с. */
function Ring() {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(a, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [a]);
  const rotate = a.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return <Animated.View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2.5, borderColor: '#CFE3D6', borderTopColor: palette.green, transform: [{ rotate }] }} />;
}

/** Метки на фото вразброс, как в макете (у ИИ нет координат элементов — точки условные, порядок как в списке). */
const SCATTER: [number, number][] = [[0.038, 14], [0.464, 58], [0.262, 120], [0.596, 184], [0.038, 226], [0.5, 226]];
function ScatterPins({ labels }: { labels: { label: string; q: boolean }[] }) {
  const [w, setW] = useState(0);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {w > 0 && labels.slice(0, SCATTER.length).map((p, i) => {
        const left = Math.round(SCATTER[i][0] * w);
        return <Pin key={i} label={p.label} q={p.q} dot={p.q ? palette.amber : palette.green} style={{ position: 'absolute', left, top: SCATTER[i][1], maxWidth: w - left - 10 }} />;
      })}
    </View>
  );
}

/** Строка «Что я нашёл» (.it): знак ✓/?, название, «оценка»; справа карандаш (.fix) или «Ответить» (.ans). */
function FoundRow({ sure, title, est, first, compact, fixLabel, estLabel, answer, onFix }: {
  sure: boolean; title: string; est?: boolean; first: boolean; compact?: boolean; fixLabel?: string; estLabel?: string; answer?: string; onFix: () => void;
}) {
  return (
    <Press feedback="row" onPress={onFix} accessibilityRole="button" accessibilityLabel={`${title}. ${answer ?? fixLabel ?? ''}`}
      style={[s.it, compact && { minHeight: 50 }, !first && s.itLine]}>
      <View style={[s.mk, { backgroundColor: sure ? palette.greenSoft : palette.amberSoft }]}>
        {sure ? <MaterialCommunityIcons name="check-bold" size={16} color={palette.greenDeep} /> : <T style={{ fontSize: 16, fontWeight: '700', color: palette.amberDeep }}>?</T>}
      </View>
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
        <T v="rt" style={compact ? { fontSize: 15, lineHeight: 20 } : null} numberOfLines={2}>{title}</T>
        {est && estLabel ? <View style={s.est}><T style={s.estText}>{estLabel}</T></View> : null}
      </View>
      {answer ? (
        <View style={s.ans}><T style={s.ansText}>{answer}</T></View>
      ) : (
        <View style={s.fix}><MaterialCommunityIcons name="pencil-outline" size={19} color={palette.ink} /></View>
      )}
    </Press>
  );
}

/** Фото 272 r28 с листанием (несколько фото); метки — поверх. */
function PhotoPager({ photos, page, onPage, children }: { photos: string[]; page: number; onPage: (n: number) => void; children?: ReactNode }) {
  const [w, setW] = useState(0);
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={[s.photo, { marginBottom: 4 }]}>
      {w > 0 ? (
        <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} scrollEnabled={photos.length > 1}
          onMomentumScrollEnd={(e) => onPage(Math.round(e.nativeEvent.contentOffset.x / w))}>
          {photos.map((u, i) => (
            <View key={`${u}${i}`} style={{ width: w, height: 272, backgroundColor: TINTS[i % TINTS.length] }}>
              {u ? <Image source={{ uri: u }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
            </View>
          ))}
        </ScrollView>
      ) : null}
      {page === 0 ? children : null}
    </View>
  );
}

/** Миниатюра предмета 56 r16: фото, приближенное к рамке предмета. */
function ObjectThumb({ uri, box, tint }: { uri?: string; box: [number, number, number, number]; tint: string }) {
  const ratio = usePhotoRatio(uri);
  const size = 56;
  const bw = box[2] - box[0];
  const bh = (box[3] - box[1]) / ratio;
  const W = size / Math.max(0.05, Math.max(bw, bh));
  const H = W / ratio;
  const map = coverMap(W, H, ratio);
  const a = map(box[0], box[1]);
  const left = -a.x - (bw * W - size) / 2;
  const top = -a.y - (bh * W - size) / 2;
  return (
    <View style={[s.th, { backgroundColor: tint }]}>
      {uri ? <Image source={{ uri }} style={{ position: 'absolute', width: W, height: H, left, top }} /> : <View style={s.thFill} />}
    </View>
  );
}

const s = StyleSheet.create({
  mdText: { fontSize: 16, lineHeight: 28 },
  mark: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  markOk: { backgroundColor: palette.greenSoft },
  markQ: { backgroundColor: palette.amberSoft },
  markText: { fontWeight: '500', lineHeight: 22 },
  pill: { height: 32, borderRadius: 16, paddingHorizontal: 12, backgroundColor: palette.white, justifyContent: 'center' },
  pillText: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: palette.muted2 },
  photo: { height: 272, borderRadius: 28, overflow: 'hidden', backgroundColor: '#CDBFA8' },
  foundHead: { paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  it: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingVertical: 6, paddingHorizontal: 20 },
  itLine: { borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: palette.hair },
  mk: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  fix: { width: 36, height: 36, borderRadius: 12, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  est: { height: 22, borderRadius: 9, paddingHorizontal: 8, backgroundColor: palette.amberSoft, justifyContent: 'center' },
  estText: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: palette.amberDeep },
  ans: { height: 32, borderRadius: 16, paddingHorizontal: 10, backgroundColor: palette.amberSoft, justifyContent: 'center' },
  ansText: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: '#6E3C00' },
  mit: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 74, paddingVertical: 9, paddingLeft: 9, paddingRight: 16, borderRadius: 24, backgroundColor: palette.white },
  mitOn: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 24, borderWidth: 2, borderColor: palette.green },
  th: { width: 56, height: 56, borderRadius: 16, overflow: 'hidden', alignItems: 'center', justifyContent: 'flex-end' },
  thFill: { width: 26, height: 40, marginBottom: 8, borderTopLeftRadius: 4, borderTopRightRadius: 4, backgroundColor: 'rgba(255,255,255,0.45)' },
  ck: { width: 28, height: 28, borderRadius: 9, borderWidth: 2, borderColor: palette.handle, alignItems: 'center', justifyContent: 'center' },
  ckOn: { backgroundColor: palette.green, borderColor: palette.green },
  note: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 20, backgroundColor: palette.off },
});
