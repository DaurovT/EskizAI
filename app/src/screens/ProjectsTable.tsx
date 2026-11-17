/**
 * «Проекты — таблица» широкого планшета (TProjects2.dc.html): строка инструментов («Проекты · N активных», поиск, архив),
 * фильтр этапов сегментами с количеством и сортировка по дате изменения, таблица (эскиз, изделие, клиент, этап, сумма,
 * изменён) и справа панель 340 выбранного проекта: эскиз, сумма, дата, версия, «Открыть», «Клиенту», «Смета и раскрой».
 * Данные и поиск — из ProjectsList (src/screens/ProjectsList.tsx), телефонный список не меняется.
 */
import { router } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../api';
import type { ProjectListItem, ProjectStatus } from '../api/types';
import { useResource } from '../hooks/useResource';
import { useT } from '../i18n';
import { shortDate } from '../lib/clientRequests';
import { formatRange } from '../lib/format';
import { relDay } from '../lib/inbox';
import { displayTitle } from '../lib/projectTitle';
import { defaultSketch } from '../lib/sketch';
import { priceStore } from '../state/prices';
import { Cap2, DBtn, DCard, DSeg, GridBg, KV2, Pill, Toolbar, dk, type PillTone } from '../ui/Desktop';
import { EmptyState, OfflineBanner, Press, resolveFont } from '../ui/kit';
import { useLayout } from '../ui/layout';
import { SketchDrawing, SketchThumb } from '../ui/ProductSketch';
import { palette, statusTone } from '../ui/theme';

const PILL_TONE: Record<string, PillTone> = { gray: 'n', blue: 'b', amber: 'a', green: 'g', red: 'r' };
const pillTone = (s: string): PillTone => PILL_TONE[statusTone[s] ?? 'gray'] ?? 'n';
const noSum = (s: string) => s.replace(/ (сум|so‘m)$/, '');

export function ProjectsTable({ all, order, q, setQ, refreshing, onRefresh, banner, footer }: {
  all: ProjectListItem[];
  /** Этапы в порядке чипов (только те, что есть). */
  order: ProjectStatus[];
  q: string; setQ: (v: string) => void; refreshing: boolean; onRefresh: () => void;
  /** Плашки над таблицей (входящие чертежи). */
  banner?: ReactNode;
  /** Плашка тарифа под таблицей. */
  footer?: ReactNode;
}) {
  const { t, td, lang } = useT();
  // iPad 13" в портрете (1032): уже доски 1194 — клиент второй строкой под изделием, колонки и панель уже
  const compact = useLayout().width < 1150;
  const [filter, setFilter] = useState<ProjectStatus | 'all'>('all');
  const [desc, setDesc] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const counts = useMemo(() => {
    const c: Partial<Record<ProjectStatus, number>> = {};
    for (const p of all) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [all]);
  const items = useMemo(() => {
    const list = filter === 'all' ? all : all.filter((p) => p.status === filter);
    return [...list].sort((a, b) => (desc ? -1 : 1) * (new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()));
  }, [all, filter, desc]);
  const cur = items.find((p) => p.id === sel) ?? items[0] ?? null;
  const active = all.filter((p) => p.status !== 'delivered' && p.status !== 'cancelled').length;
  const title = (p: ProjectListItem) => displayTitle(p.title, p.product_type ? td(`pk_${p.product_type}`, t('new_title_sketch')) : t('new_title_sketch'));
  const filters = [{ value: 'all' as const, label: t('all'), n: all.length }, ...order.filter((s) => counts[s]).map((s) => ({ value: s, label: td(`st_${s}`, s), n: counts[s] ?? 0 }))];

  return (
    <View style={s.root}>
      <Toolbar title={t('projects_title')} sub={t('tab_pr_active', { n: active })}>
        <View style={s.srch}>
          <Ionicons name="search" size={15} color={palette.faint} />
          <TextInput value={q} onChangeText={setQ} placeholder={t('tab_pr_search')} placeholderTextColor={palette.faint}
            style={resolveFont(s.srchIn)} returnKeyType="search" accessibilityLabel={t('tab_pr_search')} />
        </View>
        <DBtn icon="archive-outline" title={t('projects_archive')} onPress={() => router.push('/archive')} />
        <DBtn icon="notifications-outline" label={t('pl_notifications')} onPress={() => router.push('/notifications')} />
      </Toolbar>
      <View style={s.fbar}>
        <DSeg value={filter} onChange={setFilter} options={filters} />
        <View style={{ flex: 1 }} />
        <Press feedback="opacity" onPress={() => setDesc(!desc)} accessibilityRole="button">
          <Cap2>{t('tab_pr_sort', { dir: desc ? '↓' : '↑' })}</Cap2>
        </Press>
      </View>
      <OfflineBanner />
      {banner ? <View style={{ paddingHorizontal: 14, paddingTop: 10 }}>{banner}</View> : null}
      <View style={s.panes}>
        <View style={s.tbl}>
          <View style={[s.tr, s.thd]}>
            <View style={s.c0} />
            <Text style={resolveFont([s.th, s.c1])} numberOfLines={1}>{compact ? `${t('tab_pr_col_item')} · ${t('tab_pr_col_client').toLowerCase()}` : t('tab_pr_col_item')}</Text>
            {compact ? null : <Text style={resolveFont([s.th, s.c2])}>{t('tab_pr_col_client')}</Text>}
            <Text style={resolveFont([s.th, compact ? s.c3c : s.c3])}>{t('tab_pr_col_stage')}</Text>
            <Text style={resolveFont([s.th, compact ? s.c4c : s.c4, { textAlign: 'right' }])}>{t('tab_pr_col_sum')}</Text>
            <Text style={resolveFont([s.th, compact ? s.c5c : s.c5, { textAlign: 'right' }])} numberOfLines={1}>{t('tab_pr_col_changed')}</Text>
          </View>
          <FlatList
            data={items}
            keyExtractor={(p) => p.id}
            renderItem={({ item: p }) => <Row p={p} title={title(p)} on={p.id === cur?.id} compact={compact} onPress={() => setSel(p.id)} />}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<View style={{ padding: 24 }}><EmptyState icon="search-outline" title={t('projects_none_found')} compact /></View>}
            ListFooterComponent={footer ? <View style={{ padding: 14 }}>{footer}</View> : undefined}
          />
        </View>
        {cur ? <Detail key={cur.id} p={cur} title={title(cur)} width={compact ? 300 : 340} /> : <View style={[s.det, { width: compact ? 300 : 340 }]} />}
      </View>
    </View>
  );
}

/** Строка таблицы .tr 48: эскиз 40, изделие, клиент, этап, сумма, когда изменён. */
function Row({ p, title: name, on, compact, onPress }: { p: ProjectListItem; title: string; on: boolean; compact: boolean; onPress: () => void }) {
  const { t, td, lang } = useT();
  const cached = priceStore.use((st) => st[p.id]);
  const price = p.price ?? cached ?? null;
  return (
    <Press feedback="row" onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }}
      accessibilityLabel={[name, p.client?.name, td(`st_${p.status}`, p.status), price ? formatRange(price, lang) : null].filter(Boolean).join(', ')}
      style={[s.tr, s.row, on && { backgroundColor: dk.sel }]}>
      <View style={s.c0}><SketchThumb sketch={p.sketch} kind={p.product_type} size={40} /></View>
      {compact ? (
        <View style={s.c1}>
          <Text style={resolveFont(s.name)} numberOfLines={1}>{name}</Text>
          <Text style={resolveFont([s.cl, { fontSize: 12, lineHeight: 16 }])} numberOfLines={1}>{p.client?.name || t('projects_no_client')}</Text>
        </View>
      ) : (
        <>
          <Text style={resolveFont([s.name, s.c1])} numberOfLines={1}>{name}</Text>
          <Text style={resolveFont([s.cl, s.c2])} numberOfLines={1}>{p.client?.name || t('projects_no_client')}</Text>
        </>
      )}
      <View style={compact ? s.c3c : s.c3}>
        {p.is_example ? <Pill tone="a" label={t('pl_example_free')} /> : <Pill tone={pillTone(p.status)} label={td(`st_${p.status}`, p.status)} />}
      </View>
      <Text style={resolveFont([s.sum, compact ? s.c4c : s.c4])} numberOfLines={1}>{price ? noSum(formatRange(price, lang)) : '—'}</Text>
      <Text style={resolveFont([s.date, compact ? s.c5c : s.c5])} numberOfLines={1}>{dayShort(p.updated_at, lang)}</Text>
    </Press>
  );
}

/** «сегодня», «вчера», иначе «15 нояб». */
const dayShort = (iso: string, lang: 'ru' | 'uz') => {
  const r = relDay(iso, lang);
  return /\d/.test(r) ? shortDate(iso, lang) : r;
};

/** .det — панель выбранного проекта. */
function Detail({ p, title, width }: { p: ProjectListItem; title: string; width: number }) {
  const { t, td, lang } = useT();
  const versions = useResource(() => api.listVersions(p.id).catch(() => []), [p.id]);
  const v = (versions.data ?? []).find((x) => x.is_current) ?? null;
  const cached = priceStore.use((st) => st[p.id]);
  const price = p.price ?? cached ?? null;
  const sketch = p.sketch ?? defaultSketch(p.product_type);
  const src = v ? (v.source === 'ai' ? t('tab_pr_src_ai') : v.source === 'restore' ? t('tab_pr_src_restore') : t('tab_pr_src_manual')) : null;
  return (
    <View style={[s.det, { width }]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={resolveFont(s.dn)} numberOfLines={2}>{title}</Text>
          <Cap2 style={{ fontSize: 13 }}>{p.client?.name || t('projects_no_client')}</Cap2>
        </View>
        <Pill tone={pillTone(p.status)} label={td(`st_${p.status}`, p.status)} style={{ marginTop: 3 }} />
      </View>
      <View style={s.hero}>
        <GridBg step={14} color={dk.grid} rows={16} cols={24} />
        <SketchDrawing sketch={sketch} size={150} style={!p.sketch ? { opacity: 0.4 } : undefined} />
        {v ? <Cap2 style={s.heroCap}>{t('tab_pr_sketch_v', { n: v.number })}</Cap2> : null}
      </View>
      <DCard style={{ paddingVertical: 4, paddingHorizontal: 12 }}>
        <KV2 k={t('tab_pr_sum_client')} v={price ? noSum(formatRange(price, lang)) : '—'} />
        <KV2 k={t('tab_pr_col_changed')} v={dayShort(p.updated_at, lang)} />
        <KV2 k={t('tab_pr_version')} v={v ? [`v${v.number}`, src].filter(Boolean).join(' · ') : '—'} last />
      </DCard>
      <View style={{ flex: 1 }} />
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <DBtn icon="cube-outline" title={t('tab_pr_open')} onPress={() => router.push(`/project/${p.id}/editor`)} style={{ flex: 1 }} />
        <DBtn icon="paper-plane-outline" title={t('tab_pr_to_client')} onPress={() => router.push(`/project/${p.id}/send`)} style={{ flex: 1 }} />
      </View>
      <DBtn primary tall title={t('tab_pr_estimate')} onPress={() => router.push(`/project/${p.id}/estimate`)} />
      <Press feedback="opacity" onPress={() => router.push(`/project/${p.id}`)} accessibilityRole="button" style={{ alignSelf: 'center', paddingVertical: 4 }}>
        <Cap2 style={{ color: palette.greenPress, fontWeight: '600' }}>{t('tab_pr_card')}</Cap2>
      </Press>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.ground },
  srch: { width: 240, height: 32, borderRadius: 8, backgroundColor: palette.white, borderWidth: 1, borderColor: dk.btnLine, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10 },
  srchIn: { flex: 1, fontSize: 13, lineHeight: 17, color: palette.ink, paddingVertical: 0 },
  fbar: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: dk.line, backgroundColor: dk.tb },
  panes: { flex: 1, minHeight: 0, flexDirection: 'row' },
  tbl: { flex: 1, minWidth: 0, backgroundColor: palette.white },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 },
  thd: { height: 34, borderBottomWidth: 1, borderBottomColor: '#EAE8E3' },
  th: { fontSize: 12, lineHeight: 16, fontWeight: '600', color: dk.th },
  row: { height: 48, borderBottomWidth: 1, borderBottomColor: '#F2F0EC' },
  c0: { width: 44 },
  c1: { flex: 1.6, minWidth: 0 },
  c2: { flex: 1.1, minWidth: 0 },
  c3: { width: 104 },
  c4: { width: 108 },
  c5: { width: 78 },
  c3c: { width: 92 },
  c4c: { width: 96 },
  c5c: { width: 64 },
  name: { fontSize: 14, lineHeight: 19, fontWeight: '600', color: palette.ink },
  cl: { fontSize: 14, lineHeight: 19, color: palette.muted2 },
  sum: { fontSize: 14, lineHeight: 19, fontWeight: '600', color: palette.ink, textAlign: 'right', fontVariant: ['tabular-nums'] },
  date: { fontSize: 13, lineHeight: 17, color: palette.faint, textAlign: 'right' },
  det: { width: 340, borderLeftWidth: 1, borderLeftColor: dk.line, backgroundColor: dk.pane, padding: 16, gap: 12 },
  dn: { fontSize: 18, lineHeight: 23, fontWeight: '700', color: palette.ink },
  hero: { height: 200, borderRadius: 12, backgroundColor: '#FCFBF8', borderWidth: 1, borderColor: dk.cardLine, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  heroCap: { position: 'absolute', left: 10, bottom: 10 },
});
