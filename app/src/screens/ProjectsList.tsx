/**
 * SCR-03 Проекты (Projects.dc.html) и пустой список (EmptyProjects.dc.html):
 * плитки «Новый по фото / По описанию / Архив», поиск, прилипающие фильтр-чипы с количеством, карточки проектов
 * с эскизом изделия, плашка лимита. Архив (archived) — тот же список без плиток и плашки.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, Tabs, useLocalSearchParams } from 'expo-router';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import { api } from '../api';
import { STATUS_FLOW, type ProjectListItem, type ProjectStatus } from '../api/types';
import { useResource } from '../hooks/useResource';
import { useT } from '../i18n';
import { formatRange } from '../lib/format';
import { displayTitle } from '../lib/projectTitle';
import { drawingTitle } from '../lib/inbox';
import { openExample } from '../services/example';
import { priceStore } from '../state/prices';
import { useSession } from '../state/session';
import { showError } from '../ui/dialogs';
import { ErrorState } from '../ui/ErrorState';
import { Wood } from '../ui/Illus';
import { Avatar, Badge, Banner, BigTitle, Card, Chip, ChipRow, EmptyState, GlassPress, IconButton, Loading, OfflineBanner, Press, Search, StatusBadge, T, glass, useTabBarSpace } from '../ui/kit';
import { CenterColumn, Embedded, useLayout } from '../ui/layout';
import { SplitEmpty, SplitView } from '../ui/SplitView';
import { SketchThumb } from '../ui/ProductSketch';
import { palette, tones } from '../ui/theme';
import { ProjectCardView } from './ProjectCard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ORDER: ProjectStatus[] = [...STATUS_FLOW.filter((s) => s !== 'delivered'), 'delivered', 'cancelled'];
/** «9,2–10,5 млн» — в строке списка без «сум» (как в макете). */
const shortRange = (r: Parameters<typeof formatRange>[0], lang: Parameters<typeof formatRange>[1]) => formatRange(r, lang).replace(/ (сум|so‘m)$/, '');

/** Цена «9,2–10,5» + мелкое « млн» (.pp / .pp small); меньше миллиона — суммой без «сум». */
function priceParts(r: Parameters<typeof formatRange>[0], lang: Parameters<typeof formatRange>[1]): [string, string] {
  const txt = shortRange(r, lang);
  const m = /^(.*?) (млн|mln)$/.exec(txt);
  return m ? [m[1], ` ${m[2]}`] : [txt, ''];
}

/**
 * .pc — карточка проекта: белая r20, отступы 6/16/6/6; слева эскиз изделия .pi 86 на «миллиметровке», справа
 * название 17/22 600, клиент 13/18 #8E8B85, внизу статус и цена. На планшете выбранная — с рамкой 2 #21201F.
 */
const ProjectItem = memo(function ProjectItem({ p, selected, onSelect }: { p: ProjectListItem; selected?: boolean; onSelect?: (id: string) => void }) {
  const { t, td, lang } = useT();
  // старые «Новый проект 03.11.2026» — типом изделия
  const title = displayTitle(p.title, p.product_type ? td(`pk_${p.product_type}`, t('new_title_sketch')) : t('new_title_sketch'));
  const cached = priceStore.use((st) => st[p.id]);
  const price = p.price ?? cached ?? null;
  // клиент; если он уже в названии («Пенал · Азиза») или его нет — дата создания
  // вторая строка — всегда клиент (как в макете); без клиента — «без клиента»
  const sub = p.client?.name || t('projects_no_client');
  const status = p.archived_at ? t('st_archived') : td(`st_${p.status}`, p.status);
  const [num, unit] = price ? priceParts(price, lang) : ['', ''];
  const a11y = [title, p.client?.name ?? t('projects_no_client'), p.is_example ? t('pl_example_free') : status,
    price ? formatRange(price, lang) : null, p.activity?.text].filter(Boolean).join(', ');
  return (
    <Press onPress={onSelect ? () => onSelect(p.id) : () => router.push(`/project/${p.id}`)} style={[s.pc, selected && s.pcSel]}
      accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={onSelect ? { selected: !!selected } : undefined}>
      <SketchThumb sketch={p.sketch} kind={p.product_type} />
      <View style={s.pt}>
        <T style={s.pn} color={palette.ink} numberOfLines={1}>{title}</T>
        <T style={s.pk} color={palette.faint} numberOfLines={1}>{sub}</T>
        <View style={s.pb}>
          {p.is_example ? <Badge label={t('pl_example_free')} tone="amber" style={{ flexShrink: 1 }} />
            : <StatusBadge status={p.status} archived={!!p.archived_at} style={{ flexShrink: 1 }} />}
          {num ? (
            <T style={s.pp} color={palette.ink} numberOfLines={1}>
              {num}{unit ? <T style={s.ppUnit} color={palette.faint}>{unit}</T> : null}
            </T>
          ) : null}
        </View>
      </View>
    </Press>
  );
});

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
  const navSpace = useTabBarSpace();
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
        <ScrollView contentContainerStyle={[s.body, { flexGrow: 1, paddingBottom: 12 + navSpace }]} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
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
    <Banner tone="ok" title={t(leftKey, { n: left })} text={t('pl_left_files')} action={{ label: t('pl_tariffs'), onPress: () => router.push('/paywall') }} style={{ alignItems: 'center' }} />
  ) : null;
  const onRefresh = () => { refresh(); lim.reload(); inbox.reload(); };

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
          {/* карточки .pc на фоне колонки (как на телефоне), выбранная — с рамкой */}
          <FlatList
            data={items}
            keyExtractor={(p) => p.id}
            renderItem={({ item }) => <ProjectItem p={item} selected={item.id === cur?.id} onSelect={setSel} />}
            ItemSeparatorComponent={CardGap}
            style={{ flex: 1, marginHorizontal: -4 }}
            contentContainerStyle={{ paddingHorizontal: 4, paddingBottom: Math.max(insets.bottom, 20) }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            ListEmptyComponent={<EmptyState icon="search-outline" title={t('projects_none_found')} compact />}
            ListFooterComponent={limitBanner ? <View style={{ paddingTop: 10 }}>{limitBanner}</View> : undefined}
          />
        </>}
        detail={cur ? (
          <Embedded key={cur.id} params={{ id: cur.id }} onChange={refresh} onGone={() => { setSel(null); refresh(); }}>
            <ProjectCardView />
          </Embedded>
        ) : <SplitEmpty icon="folder-outline" />}
      />
    );
  }

  /*
   * Одна прокрутка (Projects.dc.html): плитки, плашка «Входящих» и поиск уезжают наверх, строка этапов прилипает
   * под заголовком «Проекты» (sticky, фон #F2F1EE), под ней листаются карточки; в конце — плашка тарифа,
   * снизу — запас под стеклянное меню.
   */
  type Row = { k: 'top' } | { k: 'chips' } | { k: 'p'; p: ProjectListItem } | { k: 'tail' };
  const rows: Row[] = [{ k: 'top' }, ...(chipRow ? [{ k: 'chips' } as Row] : []), ...items.map((p): Row => ({ k: 'p', p })), { k: 'tail' }];
  const renderRow = ({ item, index }: { item: Row; index: number }) => {
    switch (item.k) {
      case 'top':
        return (
          <View style={[s.top, !chipRow && { marginBottom: 10 }]}>
            {!archived ? (
              <View style={s.tiles}>
                <Svc green title={t('pl_new_photo')} sub={t('pl_new_photo_sub')} onPress={() => router.push('/project/new')} style={{ flex: 1.2 }}><SvcArt /></Svc>
                <Svc title={t('pl_by_text')} sub={t('pl_by_text_sub')} icon="reorder-three-outline" onPress={() => router.push('/project/new?mode=text')} style={{ flex: 1 }} />
                <Svc title={t('projects_archive')} sub={t('pl_archive_sub')} icon="archive-outline" onPress={() => router.push('/archive')} style={{ flex: 1 }} />
              </View>
            ) : null}
            {inboxBanner}
            <Search value={q} onChangeText={setQ} placeholder={t('projects_search_ph')} />
          </View>
        );
      case 'chips':
        return <View style={s.chips}>{chipRow}</View>;
      case 'p':
        return <View style={rows[index + 1]?.k === 'p' ? s.gap : null}><ProjectItem p={item.p} /></View>;
      default:
        return (
          <View style={s.tail}>
            {items.length ? null : <EmptyState icon="search-outline" title={t('projects_none_found')} />}
            {limitBanner}
          </View>
        );
    }
  };

  return (
    <View style={s.root}>
      {header}
      <OfflineBanner />
      <FlatList
        // dev: снимки прокрутки через DevNav — eval globalThis.__projectsList.scrollToOffset({ offset: 600 })
        ref={__DEV__ ? (r) => { (globalThis as { __projectsList?: unknown }).__projectsList = r; } : undefined}
        data={rows}
        keyExtractor={(r) => (r.k === 'p' ? r.p.id : r.k)}
        renderItem={renderRow}
        stickyHeaderIndices={chipRow ? [1] : undefined}
        contentContainerStyle={[s.list, { paddingBottom: navSpace || 12 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        initialNumToRender={8}
        windowSize={7}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      />
    </View>
  );
}

const CardGap = () => <View style={{ height: 4 }} />;

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
  // без gap у контейнера: отступы между блоками задают сами строки (у FlatList gap лёг бы и между карточками)
  list: { paddingTop: 6, paddingHorizontal: 12 },
  top: { gap: 10, marginBottom: 18 },
  // sticky: при прилипании — сразу под заголовком; 8 сверху из макета (.chips padding 8 12 6) — отступом блока выше
  chips: { backgroundColor: palette.ground, marginHorizontal: -12, paddingHorizontal: 12, paddingBottom: 6, marginBottom: 10 },
  gap: { marginBottom: 4 },
  tail: { gap: 10, paddingTop: 10 },
  pc: { flexDirection: 'row', gap: 12, alignItems: 'stretch', backgroundColor: palette.white, borderRadius: 20, paddingTop: 6, paddingBottom: 6, paddingLeft: 6, paddingRight: 16 },
  pcSel: { borderWidth: 2, borderColor: palette.ink, paddingTop: 4, paddingBottom: 4, paddingLeft: 4, paddingRight: 14 },
  pt: { flex: 1, minWidth: 0, paddingTop: 6, paddingBottom: 2 },
  pn: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  pk: { fontSize: 13, lineHeight: 18, marginTop: 1 },
  pb: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 'auto' },
  pp: { flexShrink: 0, fontSize: 16, lineHeight: 21, fontWeight: '600', letterSpacing: -0.24, fontVariant: ['tabular-nums'] },
  ppUnit: { fontSize: 12, fontWeight: '500', letterSpacing: 0 },
  mini: { backgroundColor: palette.ink, borderWidth: 2, borderColor: palette.ink, padding: 2, gap: 2 },
});

