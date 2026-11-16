/**
 * SCR-03 Проекты (Projects.dc.html) и пустой список (EmptyProjects.dc.html):
 * плитки «Новый по фото / По описанию / Архив», поиск, фильтр-чипы с количеством, строки проектов, плашка лимита.
 * Архив (archived) — тот же список без плиток и плашки.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, Tabs, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { api } from '../api';
import { STATUS_FLOW, type ProjectListItem, type ProjectStatus } from '../api/types';
import { useResource } from '../hooks/useResource';
import { useT } from '../i18n';
import { formatDayMonth, formatRange } from '../lib/format';
import { displayTitle } from '../lib/projectTitle';
import { drawingTitle } from '../lib/inbox';
import { openExample } from '../services/example';
import { priceStore } from '../state/prices';
import { useSession } from '../state/session';
import { showError } from '../ui/dialogs';
import { ErrorState } from '../ui/ErrorState';
import { Wood } from '../ui/Illus';
import { Avatar, Banner, BigTitle, Card, Chip, ChipRow, EmptyState, GlassPress, Hairline, IconButton, Loading, OfflineBanner, Press, Search, StatusBadge, T, glass } from '../ui/kit';
import { CenterColumn, Embedded, useLayout } from '../ui/layout';
import { Pane, SplitEmpty, SplitView, splitRow } from '../ui/SplitView';
import { palette, tones } from '../ui/theme';
import { ProjectCardView } from './ProjectCard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ORDER: ProjectStatus[] = [...STATUS_FLOW.filter((s) => s !== 'delivered'), 'delivered', 'cancelled'];
/** «9,2–10,5 млн» — в строке списка без «сум» (как в макете). */
const shortRange = (r: Parameters<typeof formatRange>[0], lang: Parameters<typeof formatRange>[1]) => formatRange(r, lang).replace(/ (сум|so‘m)$/, '');

/** Миниатюра .thumb: схематичный шкаф / кухня / стеллаж (у списка нет фото). */
function ProjectThumb({ kind }: { kind: string | null }) {
  const k = kind ?? '';
  if (k.includes('kitchen')) {
    return (
      <View style={[s.thumb, { backgroundColor: '#EEF0EF' }]}>
        <View style={[s.mini, { width: 40, height: 26, flexDirection: 'row' }]}>{[0, 1, 2, 3].map((i) => <View key={i} style={{ flex: 1, backgroundColor: '#D6DCD9' }} />)}</View>
      </View>
    );
  }
  if (k.includes('rack') || k.includes('shel')) {
    return (
      <View style={s.thumb}>
        <View style={[s.mini, { width: 24, height: 38 }]}>{[0, 1, 2, 3].map((i) => <View key={i} style={{ flex: 1, backgroundColor: '#E6D3B1' }} />)}</View>
      </View>
    );
  }
  return (
    <View style={s.thumb}>
      <View style={[s.mini, { width: 30, height: 36, flexDirection: 'row' }]}>{[0, 1, 2].map((i) => <View key={i} style={{ flex: 1, backgroundColor: '#E6D3B1' }} />)}</View>
    </View>
  );
}

function ProjectRow({ p, selected, onSelect }: { p: ProjectListItem; selected?: boolean; onSelect?: () => void }) {
  const { t, td, lang } = useT();
  // старые «Новый проект 03.11.2026» — типом изделия; дата — мелко во второй строке
  const title = displayTitle(p.title, p.product_type ? td(`pk_${p.product_type}`, t('new_title_sketch')) : t('new_title_sketch'));
  const cached = priceStore.use((st) => st[p.id]);
  const price = p.price ?? cached ?? null;
  return (
    <Press feedback="row" onPress={onSelect ?? (() => router.push(`/project/${p.id}`))} style={[s.row, onSelect && splitRow.row, onSelect && { paddingHorizontal: 16, paddingVertical: 12 }, selected && splitRow.sel]}
      accessibilityRole="button" accessibilityLabel={title} accessibilityState={onSelect ? { selected: !!selected } : undefined}>
      <ProjectThumb kind={p.product_type} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.l1}>
          <T v="rt" numberOfLines={1} style={{ flex: 1 }}>{title}</T>
          {price ? <T v="rv">{shortRange(price, lang)}</T> : null}
        </View>
        {/* клиент (если его нет в названии) и дата создания — мелко */}
        <T v="rs" numberOfLines={1}>{[p.client?.name && title.includes(p.client.name) ? null : p.client?.name ?? t('projects_no_client'), formatDayMonth(p.created_at, lang)].filter(Boolean).join(' · ')}</T>
        <View style={s.l3}>
          <StatusBadge status={p.status} archived={!!p.archived_at} />
          {p.is_example ? <T style={s.hint} color={tones.amber.fg}>{t('pl_example_free')}</T>
            : p.activity ? <T style={s.hint} numberOfLines={1} color={tones[p.activity.tone].fg}>{p.activity.text}</T> : null}
        </View>
      </View>
    </Press>
  );
}

/** .svc — плитка действия 118 r24; основная («Новый по фото») — стекло GLASS-GREEN. */
function Svc({ title, sub, icon, green, onPress, children, style }: {
  title: string; sub: string; icon?: keyof typeof Ionicons.glyphMap; green?: boolean; onPress: () => void; children?: ReactNode; style?: ViewStyle;
}) {
  const a11y = { onPress, accessibilityRole: 'button' as const, accessibilityLabel: title.replace('\n', ' ') };
  if (green) {
    return (
      <GlassPress {...a11y} radius={24} style={[s.svc, s.svcGlass, style]}>
        {/* шкафчик в углу обрезается по плитке, а тень стекла — нет */}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 24, overflow: 'hidden' }]}>{children}</View>
        <T style={[s.svcB, glass.text]} color={glass.fg}>{title}</T>
        <T style={[s.svcS, { opacity: 0.8 }]} color={glass.fg}>{sub}</T>
      </GlassPress>
    );
  }
  return (
    <Press {...a11y} style={[s.svc, style]}>
      {children}
      {icon ? <View style={s.svcIco}><Ionicons name={icon} size={20} color={palette.ink} /></View> : null}
      <T style={s.svcB} color={palette.ink}>{title}</T>
      <T style={s.svcS} color={palette.muted}>{sub}</T>
    </Press>
  );
}

/** Повёрнутый шкафчик в углу зелёной плитки. */
const SvcArt = () => (
  <View style={s.svcArt} pointerEvents="none">
    <Wood /><Wood style={{ borderTopRightRadius: 16 }} />
  </View>
);

export function ProjectsList({ archived = false }: { archived?: boolean }) {
  const { t, lang, td } = useT();
  const { workshop, user } = useSession();
  // широкий планшет: список слева, выбранный проект справа (TProjects.dc.html)
  const { wide, tablet: onTablet } = useLayout();
  const split = wide && !archived;
  const insets = useSafeAreaInsets();
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<ProjectStatus | 'all'>('all');
  const [busy, setBusy] = useState(false);
  // все проекты (без фильтра статуса): из них считаем количество на чипах и фильтруем локально
  const { data, error, loading, refreshing, reload, refresh } = useResource(
    () => api.listProjects({ q: q.trim() || undefined, archived }),
    [q, archived],
  );
  const lim = useResource(() => (archived ? Promise.resolve(null) : api.limits()), [archived]);
  const notes = useResource(() => (archived ? Promise.resolve([]) : api.listNotifications().catch(() => [])), [archived]);
  const unread = (notes.data ?? []).some((n) => !n.read);
  // SCR-52: входящие чертежи из Eskiz DWG — значок в шапке (точка, когда есть новые) и плашка над списком
  const inbox = useResource(() => (archived ? Promise.resolve(null) : api.listInbox().catch(() => null)), [archived]);
  const fresh = (inbox.data?.items ?? []).filter((d) => !d.last_opened_at);
  const inboxBtn = <IconButton icon="file-tray-outline" badge={fresh.length > 0} label={t('inb_title')} onPress={() => router.push('/inbox')} />;
  const inboxBanner = !archived && fresh.length ? (
    <Banner tone="info" icon="file-tray-outline" title={fresh.length === 1 ? t('inb_banner_one') : t('inb_banner', { n: fresh.length })}
      text={fresh.slice(0, 2).map((d) => drawingTitle(d)).join(', ')} action={{ label: t('inb_open'), onPress: () => router.push('/inbox') }} />
  ) : null;
  // dev: /?empty=1 — пустой список (EmptyProjects.dc.html) для сверки с макетом
  const devEmpty = __DEV__ && useLocalSearchParams<{ empty?: string }>().empty === '1';
  const all = useMemo(() => (devEmpty ? [] : data?.items ?? []), [data, devEmpty]);
  const counts = useMemo(() => {
    const c: Partial<Record<ProjectStatus, number>> = {};
    for (const p of all) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [all]);
  const items = filter === 'all' ? all : all.filter((p) => p.status === filter);
  const empty = !archived && !q && !all.length && !loading && !error;
  const limits = lim.data;

  const example = async () => {
    setBusy(true);
    try { await openExample(lang); } catch (e) { showError(e, lang); } finally { setBusy(false); }
  };
  const left = limits?.free_left ?? 0;
  const leftKey = left % 10 === 1 && left % 100 !== 11 ? 'pl_left_one' : left % 10 >= 2 && left % 10 <= 4 && (left % 100 < 12 || left % 100 > 14) ? 'pl_left_few' : 'pl_left_many';

  const header = archived ? null : (
    <Tabs.Screen options={{
      // на планшете профиль — в рейке слева
      headerLeft: onTablet ? undefined : () => (
        <IconButton dark label={t('pl_profile')} onPress={() => router.push('/profile')}>
          <Avatar dark name={workshop?.name || user?.name} />
        </IconButton>
      ),
      headerRight: () => (
        <>
          {inboxBtn}
          {empty ? null : <IconButton icon="notifications-outline" badge={unread} label={t('pl_notifications')} onPress={() => router.push('/notifications')} />}
        </>
      ),
    }} />
  );

  if (loading && !data) return <View style={s.root}>{header}<Loading /></View>;
  if (error && !data) return <View style={s.root}>{header}<ErrorState error={error} onRetry={reload} /></View>;

  if (empty) {
    return (
      <View style={[s.root, split && { paddingTop: insets.top + 20 }]}>
        {header}
        <CenterColumn>
        {split ? <BigTitle size="root" inset={20}>{t('projects_title')}</BigTitle> : null}
        <OfflineBanner />
        <ScrollView contentContainerStyle={[s.body, { flexGrow: 1 }]} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
          {inboxBanner}
          <View style={s.tiles}>
            <Svc green title={t('pl_new_photo_big')} sub={t('pl_new_photo_big_sub')} onPress={() => router.push('/project/new')} style={{ flex: 1.2 }}><SvcArt /></Svc>
            <Svc title={t('pl_by_text')} sub={t('pl_by_text_sub')} icon="reorder-three-outline" onPress={() => router.push('/project/new?mode=text')} style={{ flex: 1 }} />
          </View>
          <T style={s.h2}>{t('pl_try_example')}</T>
          <Card padded={false} onPress={busy ? undefined : example} accessibilityLabel={t('pl_example_open')}>
            <View style={s.demoPic}>
              <View style={[s.mini, { width: 120, height: 110, flexDirection: 'row', borderWidth: 3, padding: 3, gap: 3 }]}>
                <Wood /><View style={{ flex: 1, backgroundColor: '#CFDAD5' }} /><Wood />
              </View>
              <View style={s.demoSt}><T style={s.stText} color={tones.amber.fg}>{t('pl_example_free')}</T></View>
              <View style={s.pill}>
                <Ionicons name="cube-outline" size={18} color={palette.ink} />
                <T style={{ fontSize: 15, lineHeight: 20, fontWeight: '500' }}>{t('pl_example_open')}</T>
              </View>
            </View>
            <View style={s.demoRow}>
              <View style={{ flex: 1 }}>
                <T v="rt">{t('pl_example_title')}</T>
                <T v="rs">{t('pl_example_sub')}</T>
              </View>
              <Ionicons name="chevron-forward" size={18} color={palette.chev} />
            </View>
          </Card>
          <View style={{ flex: 1 }} />
          <Banner tone="ok" icon="sparkles-outline" text={t('pl_free_banner', { n: limits?.free_limit ?? 3 })} style={{ alignItems: 'center' }} />
        </ScrollView>
        </CenterColumn>
      </View>
    );
  }

  const chips: (ProjectStatus | 'all')[] = ['all', ...ORDER.filter((st) => counts[st])];
  const chipRow = chips.length > 2 ? (
    <ChipRow>
      {chips.map((f) => (
        <Chip key={f} label={f === 'all' ? t('all') : td(`st_${f}`, f)} count={f === 'all' ? all.length : counts[f]} selected={filter === f}
          onPress={() => setFilter(f)} style={{ paddingHorizontal: 13 }} />
      ))}
    </ChipRow>
  ) : null;
  const limitBanner = !archived && limits && !limits.unlimited ? (
    <Banner tone="ok" title={t(leftKey, { n: left })} text={t('pl_left_files')} action={{ label: t('pl_tariffs'), onPress: () => router.push('/paywall') }} />
  ) : null;

  if (split) {
    const cur = items.find((p) => p.id === sel) ?? items[0] ?? null;
    return (
      <SplitView
        title={t('projects_title')}
        right={<>
          {inboxBtn}
          <IconButton icon="archive-outline" label={t('projects_archive')} onPress={() => router.push('/archive')} />
          <IconButton icon="notifications-outline" badge={unread} label={t('pl_notifications')} onPress={() => router.push('/notifications')} />
        </>}
        list={<>
          <OfflineBanner />
          {inboxBanner}
          <Search value={q} onChangeText={setQ} placeholder={t('projects_search_ph')} />
          {chipRow}
          <Pane style={{ marginBottom: Math.max(insets.bottom, 20) }}>
            <ScrollView contentContainerStyle={{ paddingVertical: 8, gap: 2 }} keyboardShouldPersistTaps="handled"
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { refresh(); lim.reload(); }} />}>
              {items.length ? items.map((p) => <ProjectRow key={p.id} p={p} selected={p.id === cur?.id} onSelect={() => setSel(p.id)} />)
                : <EmptyState icon="search-outline" title={t('projects_none_found')} compact />}
              {limitBanner ? <View style={{ paddingHorizontal: 8, paddingTop: 8 }}>{limitBanner}</View> : null}
            </ScrollView>
          </Pane>
        </>}
        detail={cur ? (
          <Embedded key={cur.id} params={{ id: cur.id }} onChange={refresh} onGone={() => { setSel(null); refresh(); }}>
            <ProjectCardView />
          </Embedded>
        ) : <SplitEmpty icon="folder-outline" />}
      />
    );
  }

  return (
    <View style={s.root}>
      {header}
      <OfflineBanner />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { refresh(); lim.reload(); inbox.reload(); }} />}>
        {!archived ? (
          <View style={s.tiles}>
            <Svc green title={t('pl_new_photo')} sub={t('pl_new_photo_sub')} onPress={() => router.push('/project/new')} style={{ flex: 1.2 }}><SvcArt /></Svc>
            <Svc title={t('pl_by_text')} sub={t('pl_by_text_sub')} icon="reorder-three-outline" onPress={() => router.push('/project/new?mode=text')} style={{ flex: 1 }} />
            <Svc title={t('projects_archive')} sub={t('pl_archive_sub')} icon="archive-outline" onPress={() => router.push('/archive')} style={{ flex: 1 }} />
          </View>
        ) : null}
        {inboxBanner}
        <Search value={q} onChangeText={setQ} placeholder={t('projects_search_ph')} />
        {chipRow}
        {items.length ? (
          <Card padded={false}>
            {items.map((p, i) => (
              <View key={p.id}>
                {i ? <Hairline /> : null}
                <ProjectRow p={p} />
              </View>
            ))}
          </Card>
        ) : <EmptyState icon="search-outline" title={t('projects_none_found')} />}
        {limitBanner}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.ground },
  body: { paddingTop: 6, paddingHorizontal: 12, paddingBottom: 12, gap: 10 },
  tiles: { flexDirection: 'row', gap: 8 },
  svc: { height: 118, borderRadius: 24, backgroundColor: palette.white, padding: 14, justifyContent: 'flex-end', overflow: 'hidden' },
  svcGlass: { backgroundColor: 'transparent', overflow: 'visible' },
  svcB: { fontSize: 16, lineHeight: 20, fontWeight: '600' },
  svcS: { fontSize: 13, lineHeight: 17, marginTop: 2 },
  svcIco: { position: 'absolute', right: 10, top: 10, width: 36, height: 36, borderRadius: 12, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  svcArt: {
    position: 'absolute', right: -8, top: -10, width: 52, height: 60, backgroundColor: palette.ink, padding: 6, gap: 3, flexDirection: 'row',
    borderTopRightRadius: 20, transform: [{ rotate: '-8deg' }],
  },
  h2: { paddingTop: 10, paddingHorizontal: 8, fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3 },
  demoPic: { height: 168, backgroundColor: palette.wood, alignItems: 'center', justifyContent: 'center' },
  demoSt: { position: 'absolute', top: 14, left: 14, height: 26, paddingHorizontal: 10, borderRadius: 9, backgroundColor: palette.amberSoft, justifyContent: 'center' },
  stText: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  pill: { position: 'absolute', right: 12, bottom: 12, height: 40, borderRadius: 20, backgroundColor: palette.white, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 },
  demoRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingVertical: 10, paddingHorizontal: 20 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 14, paddingHorizontal: 20 },
  l1: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  l3: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  hint: { flexShrink: 1, fontSize: 13, lineHeight: 19, fontWeight: '500' },
  thumb: { width: 56, height: 56, borderRadius: 16, backgroundColor: palette.wood, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  mini: { backgroundColor: palette.ink, borderWidth: 2, borderColor: palette.ink, padding: 2, gap: 2 },
});

