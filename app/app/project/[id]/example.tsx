/**
 * SCR-41 Пример с подсказками (OnboardingHints.dc.html): шкаф-купе из «Попробовать на примере».
 * Ширина/высота ниши → модель и цена пересчитываются; «Отправить в Telegram» → ссылка себе.
 * Подсказки (2 шага) — один раз; «Пропустить» → «Подсказки больше не покажем» (вернуть — Профиль → Помощь).
 */
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View, type LayoutRectangle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../src/api';
import type { ModelStateOut } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatRange } from '../../../src/lib/format';
import { hintsDone, setHintsDone } from '../../../src/state/hints';
import { ProductCanvas } from '../../../src/three/ProductCanvas';
import { CoachMark, type HoleRect } from '../../../src/ui/CoachMark';
import { showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Carcass } from '../../../src/ui/Illus';
import { Button, Footer, IconButton, Loading, Press, T, resolveFont } from '../../../src/ui/kit';
import { palette, tones, type as ty } from '../../../src/ui/theme';

type Step = 0 | 1 | 2 | 'done';

export default function ExampleProject() {
  const { id, hints } = useLocalSearchParams<{ id: string; hints?: string }>();
  const { t, lang } = useT();
  const card = useResource(() => api.getProject(id), [id]);
  const [model, setModel] = useState<ModelStateOut | null>(null);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<Step>(0);
  const rects = useRef<Record<string, LayoutRectangle>>({});
  const [, force] = useState(0);

  useEffect(() => { api.getModel(id).then(setModel).catch(() => undefined); }, [id]);
  // подсказки: один раз (dev: ?hints=1|2|done — нужный шаг для сверки с макетом)
  useEffect(() => {
    if (__DEV__ && hints) { setStep(hints === 'done' ? 'done' : (Number(hints) as 1 | 2)); return; }
    hintsDone().then((d) => { if (!d) setStep(1); });
  }, [hints]);

  const tree = model?.version.tree;
  const update = async (patch: { width?: number; height?: number }) => {
    if (!tree) return;
    setSaving(true);
    try {
      setModel(await api.saveModel(id, { tree: { ...tree, ...patch }, source: 'manual' }));
      card.reload();
    } catch (e) {
      showError(e, lang);
    } finally {
      setSaving(false);
    }
  };

  const measure = (key: string) => (e: { nativeEvent: { layout: LayoutRectangle } }) => {
    rects.current[key] = e.nativeEvent.layout;
    force((n) => n + 1);
  };
  const finish = (done: Step) => { setHintsDone(); setStep(done); };

  if (card.loading && !card.data) return <Loading />;
  if (!card.data) return <ErrorState error={card.error} onRetry={card.reload} />;
  const p = card.data;
  const price = p.estimate?.total ?? null;
  const priceText = price ? formatRange(price, lang) : '—';
  const [num, cur] = priceText.match(/^(.*) (сум|so‘m)$/)?.slice(1) ?? [priceText, ''];

  // окно подсказки: поле ширины (шаг 1) или кнопка отправки (шаг 2)
  const body = rects.current.body;
  const f1 = rects.current.width;
  const f2 = rects.current.height;
  const foot = rects.current.foot;
  const cta = rects.current.cta;
  const hole: HoleRect | null = step === 1 && body && f1 ? { x: body.x + f1.x, y: body.y + f1.y, w: f1.width, h: f1.height, r: 16 }
    : step === 2 && foot && cta ? { x: foot.x + cta.x, y: foot.y + cta.y, w: cta.width, h: cta.height, r: 16 } : null;

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1 }}>
        <View style={s.hdr}>
          <View style={s.chip}><T style={s.chipText} color={tones.amber.fg} numberOfLines={1}>{t('ex_chip')}</T></View>
          <View style={{ flex: 1 }} />
          {step === 0 ? <IconButton icon="close" label={t('close')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} /> : null}
        </View>
        <View style={s.titleRow}>
          <T style={s.title} numberOfLines={1}>{p.title}</T>
          <T num style={s.price}>{num}{cur ? <T style={s.cur}> {cur}</T> : null}</T>
        </View>
        <View style={s.stage}>
          {model ? (
            <ProductCanvas model={model.version.viewer} busy={saving} fallbackText={t('ed_3d_unavailable')} />
          ) : (
            <Carcass w={176} h={186} r={0} b={3} />
          )}
        </View>
        <View style={s.body} onLayout={measure('body')}>
          <View onLayout={measure('width')}>
            <DimField label={t('ex_width')} value={tree?.width ?? null} min={600} max={4000} unit={t('mm')} onChange={(v) => update({ width: v })} />
          </View>
          <View onLayout={measure('height')}>
            <DimField label={t('ex_height')} value={tree?.height ?? null} min={1000} max={3000} unit={t('mm')} onChange={(v) => update({ height: v })} />
          </View>
        </View>
        <View onLayout={measure('foot')}>
          <Footer>
            <View onLayout={measure('cta')}>
              <Button icon="paper-plane-outline" title={t('ex_send_tg')} onPress={() => { if (step === 2) finish(0); router.push(`/project/${id}/send`); }} />
            </View>
          </Footer>
        </View>
        {step === 1 ? (
          <CoachMark hole={hole} tipBottom={foot && cta ? (foot.height - cta.y) + 22 : 120}
            label={t('ex_step', { n: 1, total: 2 })} title={t('ex_h1')} text={t('ex_t1')}
            actions={[{ label: t('skip'), onPress: () => finish('done') }, { label: t('next'), primary: true, onPress: () => setStep(2) }]} />
        ) : step === 2 ? (
          <CoachMark hole={hole} tipBottom={foot && cta ? (foot.height - cta.y) + 22 : 120}
            label={t('ex_step', { n: 2, total: 2 })} title={t('ex_h2')} text={t('ex_t2')}
            actions={[{ label: t('ex_got_it'), primary: true, onPress: () => finish(0) }]} />
        ) : step === 'done' ? (
          <CoachMark tipTop={300} title={t('ex_done_h')} text={t('ex_done_t')}
            actions={[{ label: t('ex_to_projects'), primary: true, onPress: () => { setStep(0); router.replace('/'); } }]} />
        ) : null}
      </View>
    </SafeAreaView>
  );
}

/** .fld + .numf из макета: подпись, крупное значение «1500 мм» слева, кнопки − + справа (шаг 50 мм). */
function DimField({ label, value, min, max, unit, onChange }: { label: string; value: number | null; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  const [text, setText] = useState(value == null ? '' : String(Math.round(value)));
  useEffect(() => { setText(value == null ? '' : String(Math.round(value))); }, [value]);
  const set = (v: number) => { const c = Math.min(max, Math.max(min, v)); setText(String(c)); if (c !== value) onChange(c); };
  const commit = () => { const n = parseInt(text.replace(/\D/g, ''), 10); if (Number.isNaN(n)) setText(value == null ? '' : String(Math.round(value))); else set(n); };
  return (
    <View style={s.fld}>
      <T v="fl">{label}</T>
      <View style={s.numf}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'baseline' }}>
          <TextInput value={text} onChangeText={setText} onBlur={commit} onSubmitEditing={commit} keyboardType="number-pad" returnKeyType="done"
            editable={value != null} accessibilityLabel={label} selectionColor={palette.ink} style={[resolveFont(ty.bigN), s.input]} />
          <T style={s.nu}> {unit}</T>
        </View>
        <Press style={s.pm} onPress={() => value != null && set(value - 50)} accessibilityRole="button" accessibilityLabel={`${label} −50`} disabled={value == null}><T style={s.pmText}>−</T></Press>
        <Press style={s.pm} onPress={() => value != null && set(value + 50)} accessibilityRole="button" accessibilityLabel={`${label} +50`} disabled={value == null}><T style={s.pmText}>+</T></Press>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fld: { backgroundColor: palette.white, borderRadius: 16, minHeight: 60, paddingVertical: 9, paddingHorizontal: 16 },
  numf: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: { padding: 0, margin: 0, minWidth: 40 },
  nu: { fontSize: 16, lineHeight: 20, color: palette.muted, fontWeight: '700' },
  pm: { width: 40, height: 40, borderRadius: 12, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  pmText: { fontSize: 20, lineHeight: 24, fontWeight: '500' },
  root: { flex: 1, backgroundColor: palette.ground },
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 14, paddingHorizontal: 12, paddingBottom: 4, minHeight: 74 },
  chip: { flexShrink: 1, height: 32, borderRadius: 16, paddingHorizontal: 12, backgroundColor: palette.amberSoft, justifyContent: 'center' },
  chipText: { fontSize: 14, lineHeight: 18, fontWeight: '600' },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, paddingTop: 6, paddingHorizontal: 20, paddingBottom: 10 },
  title: { flexShrink: 1, fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -0.48 },
  price: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  cur: { fontSize: 15, fontWeight: '500', color: palette.muted },
  stage: { height: 240, marginHorizontal: 12, borderRadius: 28, backgroundColor: palette.wood, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  body: { flex: 1, paddingTop: 8, paddingHorizontal: 12, gap: 10 },
});

