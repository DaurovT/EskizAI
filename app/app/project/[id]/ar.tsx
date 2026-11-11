/**
 * SCR-47 AR у мастера (ARMaster.dc.html, docs/ar_contract.md): за шторкой — превью модели, название с габаритом и цена;
 * шторка «Показать в AR»: «На этом телефоне» → GET /projects/{id}/ar → «Загрузка» (файл в кэш с прогрессом) →
 * системный AR (iPhone — AR Quick Look, Android — Scene Viewer, см. src/lib/arLaunch.ts);
 * «Клиенту на его телефон» → действующая ссылка клиента (нет — создаём, как экран отправки) и меню «Поделиться».
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Share, StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import { ApiError } from '../../../src/api/errors';
import type { ArPlacement, EstimateView, ProjectArOut } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { translate, useT } from '../../../src/i18n';
import { arDims, arHintKey, arTitle, etaSeconds, formatMb, isArFresh, linkView, pickActiveLink, progressRatio, whdToWdh } from '../../../src/lib/ar';
import { AR_DOWNLOAD_FAILED, downloadArFile, isAbort, launchAr } from '../../../src/lib/arLaunch';
import { formatRange, noCurrency } from '../../../src/lib/format';
import { useSession } from '../../../src/state/session';
import { showError } from '../../../src/ui/dialogs';
import { haptics } from '../../../src/ui/haptics';
import { Carcass } from '../../../src/ui/Illus';
import { Button, Group, ListItem, Screen, Sheet, T, Tile } from '../../../src/ui/kit';
import { palette } from '../../../src/ui/theme';

type Phase = 'choose' | 'loading';

export default function ArMaster() {
  // dev (?shot=loading): состояние «Загрузка» как в макете — 5,1 из 8 МБ, ещё ~3 с; ?shot=run — см. ниже
  const { id, shot } = useLocalSearchParams<{ id: string; shot?: string }>();
  const demo = __DEV__ && shot === 'loading';
  const { t, td, lang } = useT();
  const { workshop, isOwner } = useSession();
  const card = useResource(() => api.getProject(id), [id]);
  const versions = useResource(() => api.listVersions(id).catch(() => []), [id]);

  const [phase, setPhase] = useState<Phase>(demo ? 'loading' : 'choose');
  const [prog, setProg] = useState(demo ? { w: 5_347_738, total: 8 * 1_048_576 } : { w: 0, total: -1 });
  const [eta, setEta] = useState<number | null>(demo ? 3 : null);
  const [placement, setPlacement] = useState<ArPlacement | null>(null);
  const [sharing, setSharing] = useState(false);
  const arRef = useRef<ProjectArOut | null>(null);
  const abort = useRef<AbortController | null>(null);
  const started = useRef(0);

  // заранее: размещение для подсказки и подписанные ссылки (сервер заодно собирает файлы AR в кэш)
  useEffect(() => {
    let live = true;
    api.getProjectAr(id).then((ar) => { if (live) { arRef.current = ar; setPlacement(ar.placement); } }).catch(() => undefined);
    return () => { live = false; abort.current?.abort(); };
  }, [id]);

  const p = card.data;
  const current = versions.data?.find((v) => v.is_current);
  const size = whdToWdh(p?.model_summary?.size_mm ?? current?.summary?.size_mm) ?? arRef.current?.size_mm ?? null;
  const dims = arDims(size);
  const vNum = current?.number ?? arRef.current?.version_number ?? null;
  const kind = p?.product_type ? td(`pk_${p.product_type}`, t('ed_title')) : t('ed_title');
  const total = p?.estimate ? formatRange(p.estimate.total, lang) : '';
  const totalNum = noCurrency(total);
  const totalCur = total.slice(totalNum.length).trim();
  const modelLine = [vNum ? t('ar_model', { n: vNum }) : null, dims ? `${dims} ${t('mm')}` : null].filter(Boolean).join(' · ');

  const onProgress = (w: number, totalBytes: number) => {
    setProg({ w, total: totalBytes });
    setEta(etaSeconds(w, totalBytes, Date.now() - started.current));
  };

  const here = async () => {
    if (phase === 'loading') return;
    haptics.light();
    const ctl = new AbortController();
    abort.current = ctl;
    setProg({ w: 0, total: -1 });
    setEta(null);
    setPhase('loading');
    try {
      let ar = isArFresh(arRef.current) ? arRef.current! : await api.getProjectAr(id);
      arRef.current = ar;
      setPlacement(ar.placement);
      if (ctl.signal.aborted) return;
      started.current = Date.now();
      let file;
      try {
        file = await downloadArFile(ar, onProgress, ctl.signal);
      } catch (e) {
        // ссылка истекла или файл пересобран — один раз берём свежие ссылки
        if (!(e instanceof ApiError && e.code === AR_DOWNLOAD_FAILED)) throw e;
        ar = await api.getProjectAr(id);
        arRef.current = ar;
        started.current = Date.now();
        file = await downloadArFile(ar, onProgress, ctl.signal);
      }
      if (ctl.signal.aborted) return;
      await launchAr(file, ar, arTitle(kind, ar.version_number, arDims(ar.size_mm) ?? dims, lang));
      setPhase('choose');
    } catch (e) {
      setPhase('choose');
      if (!isAbort(e) && !ctl.signal.aborted) { haptics.error(); showError(e, lang); }
    } finally {
      if (abort.current === ctl) abort.current = null;
    }
  };

  // dev (?shot=run): сразу «На этом телефоне» — проверить загрузку и Quick Look в симуляторе без тапов
  useEffect(() => {
    if (__DEV__ && shot === 'run') here();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    setPhase('choose');
  };

  const toClient = async () => {
    if (sharing) return;
    haptics.light();
    setSharing(true);
    try {
      let link = pickActiveLink(await api.listShareLinks(id).catch(() => []));
      if (!link) {
        const allowed: EstimateView[] = isOwner ? ['total', 'short', 'detailed'] : workshop?.employee_estimate_views ?? ['total'];
        link = await api.createShareLink(id, {
          language: lang, estimate_view: linkView(workshop?.default_estimate_view, allowed), show_price: true, expires_in_days: 30,
        });
        card.reload();
      }
      await Share.share({ message: translate(link.language, 'send_message', { url: link.url }) });
    } catch (e) {
      showError(e, lang);
    } finally {
      setSharing(false);
    }
  };

  const close = () => {
    cancel();
    if (router.canGoBack()) router.back();
    else router.replace(`/project/${id}`);
  };

  const ratio = progressRatio(prog.w, prog.total);
  const sizeLine = prog.total > 0
    ? t('ar_progress', { a: formatMb(prog.w), b: formatMb(prog.total) })
    : prog.w > 0 ? t('ar_progress_unknown', { a: formatMb(prog.w) }) : '';

  return (
    <Screen scroll={false} gap={10} contentStyle={{ paddingTop: 0 }}>
      <Stack.Screen options={{ title: '' }} />
      <View style={st.prev}>
        <Carcass w={110} h={130} r={38} b={3} />
      </View>
      <T v="title" numberOfLines={2}>{dims ? `${kind} ${dims}` : kind}</T>
      {total ? (
        <T style={st.price} numberOfLines={1}>{totalNum}{totalCur ? <T style={st.cur}>{` ${totalCur}`}</T> : null}</T>
      ) : null}

      <Sheet visible onClose={close} scroll={false} contentStyle={st.sheet}>
        {phase === 'choose' ? (
          <>
            <T v="title">{t('ar_title')}</T>
            <T v="cap" style={{ marginTop: -4 }}>{[modelLine, t('ar_natural')].filter(Boolean).join(', ')}</T>
            <Group style={st.group}>
              <ListItem title={t('ar_here')} subtitle={t('ar_here_sub')} onPress={here} left={<ArTile icon="camera-outline" />} />
              <ListItem title={t('ar_client')} subtitle={t('ar_client_sub')} onPress={toClient} left={<ArTile icon="navigate-outline" />}
                chevron={!sharing} right={sharing ? <ActivityIndicator color={palette.muted} /> : undefined} disabled={sharing} />
            </Group>
            <T v="cap">{t(arHintKey(placement))}</T>
          </>
        ) : (
          <>
            <T v="title">{t('ar_loading_title')}</T>
            <T v="cap" style={{ marginTop: -4 }}>{t('ar_loading_sub')}</T>
            <View style={st.bar} accessibilityRole="progressbar" accessibilityValue={ratio != null ? { min: 0, max: 100, now: Math.round(ratio * 100) } : undefined}>
              <View style={[st.fill, { width: `${Math.round((ratio ?? 0.08) * 100)}%` }]} />
            </View>
            <View style={st.meta}>
              <T v="cap" num>{sizeLine}</T>
              <T v="cap" num>{eta != null ? t('ar_eta', { n: eta }) : ''}</T>
            </View>
            {/* файл откроется сам, как только загрузится; кнопка — подтверждение для мастера */}
            <Button title={t('ar_open_when_ready')} onPress={() => haptics.selection()} />
            <Button v="ghost" title={t('cancel')} onPress={cancel} />
          </>
        )}
      </Sheet>
    </Screen>
  );
}

/** Плитка строки на сером блоке шторки — белая (в макете .tile на #F2F1EE), иконка 20. */
function ArTile({ icon }: { icon: 'camera-outline' | 'navigate-outline' }) {
  return (
    <Tile bg={palette.white}>
      <Ionicons name={icon} size={20} color={palette.ink} />
    </Tile>
  );
}

const st = StyleSheet.create({
  prev: { height: 250, borderRadius: 28, backgroundColor: palette.wood, alignItems: 'center', justifyContent: 'center' },
  price: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.3 },
  cur: { fontSize: 16, fontWeight: '400', color: palette.muted, letterSpacing: 0 },
  // шторка макета: поля 16 (у Sheet — 12 + 4), между ручкой и заголовком — gap 8
  sheet: { paddingHorizontal: 4, paddingTop: 8 },
  group: { backgroundColor: palette.ground },
  bar: { height: 8, borderRadius: 4, backgroundColor: palette.segOnWhite, overflow: 'hidden', marginTop: 6 },
  fill: { height: 8, borderRadius: 4, backgroundColor: palette.green },
  meta: { flexDirection: 'row', justifyContent: 'space-between' },
});
