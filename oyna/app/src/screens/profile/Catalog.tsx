/**
 * Каталог (вкладка) — макет CatalogWeb, переложен на телефон: бренды → серии → позиции, поиск по артикулу,
 * счётчики «без цены» и «нужна разметка». Только просмотр: цены и разметку меняют в вебе.
 * Цена позиции: своя цена цеха поверх базовой; нет базовой — ДЕМО-цена с меткой; нет никакой — «нет цены».
 */
import { useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, RefreshControl, ScrollView, View } from 'react-native';

import { api, errorText } from '@/api/http';
import { date, num } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { C } from '@/theme';
import { Body, Card, Chip, Empty, IconButton, Loading, LoadError, Note, Row, Screen, Sheet, Txt } from '@/ui/kit';
import { MainHeader } from '@/ui/MainHeader';
import { TAB_BAR_SPACE } from '@/ui/TabBar';
import { Label, MATERIAL_TITLE, plural, ROLE_TITLE, SearchBox, St, Tag, unitTitle } from './parts';

type Series = {
  system: string; series: string; material: string; usable_for_calc: boolean; items: number; items_without_price: number;
  price_updated: string | null; incomplete: boolean;
};
type Brand = { brand: string; series: Series[] };
type Item = {
  item_id: string; system: string; article: string; color: string; role: string; unit: string; unit_confirmed: boolean; pack_kg: number | null;
  price_sum: number | null; demo_price_sum: number | null; own_price_sum: number | null; price_updated: string | null; needs_review: boolean;
};
type ItemFilter = 'all' | 'noprice' | 'demo' | 'review' | 'old';

const OLD_DAYS = 30;
const isOld = (d?: string | null) => !!d && Date.now() - new Date(d).getTime() > OLD_DAYS * 86400e3;
const dm = (d?: string | null) => (d ? date(d).slice(0, 5) : '—');
const matTitle = (m: string) => MATERIAL_TITLE[m] ?? ({ alu_accessory: 'аксессуары алюминия', pvc_accessory: 'аксессуары ПВХ', sill: 'подоконники', seal: 'уплотнители', hardware: 'фурнитура', machine: 'станки' } as Record<string, string>)[m] ?? m;
const unitLine = (it: Item) => (it.unit === 'pack' && it.pack_kg ? `бухта ${num(it.pack_kg)} кг` : it.unit === 'bar' ? 'хлыст 6 м' : unitTitle(it.unit));

function priceOf(it: Item): { value: number | null; kind: 'own' | 'base' | 'demo' | 'none' } {
  if (it.own_price_sum != null) return { value: it.own_price_sum, kind: 'own' };
  if (it.price_sum != null) return { value: it.price_sum, kind: 'base' };
  if (it.demo_price_sum != null) return { value: it.demo_price_sum, kind: 'demo' };
  return { value: null, kind: 'none' };
}

export default function Catalog() {
  const load = useLoad(async () => {
    const [brands, review] = await Promise.all([
      api.get<Brand[]>('/oyna/catalog/brands'),
      api.get<Item[]>('/oyna/catalog/review', { limit: 1000 }).catch(() => null),
    ]);
    return { brands, review };
  });
  const [series, setSeries] = useState<(Series & { brand: string }) | null>(null);
  const [rootFilter, setRootFilter] = useState<'all' | 'noprice' | 'review'>('all');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; items: Item[] | null; error: string | null }>({ q: '', items: null, error: null });
  const [detail, setDetail] = useState<Item | null>(null);

  useEffect(() => {
    if (!series) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setSeries(null); return true; });
    return () => sub.remove();
  }, [series]);

  // поиск по артикулу во всём каталоге
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) { setFound({ q: '', items: null, error: null }); return; }
    let alive = true;
    const t = setTimeout(() => {
      api.get<Item[]>('/oyna/catalog/items', { q: needle, limit: 100 })
        .then((items) => { if (alive) setFound({ q: needle, items, error: null }); })
        .catch((e) => { if (alive) setFound({ q: needle, items: null, error: errorText(e) }); });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  const brands = load.data?.brands ?? [];
  const noPrice = brands.reduce((a, b) => a + b.series.reduce((x, s) => x + s.items_without_price, 0), 0);
  const review = load.data?.review ?? null;
  const seriesName = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of brands) for (const s of b.series) m.set(s.system, `${b.brand} ${s.series}`);
    return m;
  }, [brands]);

  if (series) return <SeriesView s={series} onBack={() => setSeries(null)} onItem={setDetail} detail={detail} onCloseDetail={() => setDetail(null)} />;

  const searching = q.trim().length >= 2;
  return (
    <Screen>
      <MainHeader title="Каталог" />
      {!load.data && load.loading ? <Loading /> : !load.data && load.error ? <LoadError message={load.error} onRetry={load.reload} /> : (
        <Body style={{ paddingTop: 4, gap: 10, paddingBottom: TAB_BAR_SPACE }} refresh={<RefreshControl refreshing={load.loading} onRefresh={load.reload} />}>
          <View style={{ paddingHorizontal: 12 }}><SearchBox value={q} onChange={setQ} placeholder="Артикул" /></View>
          {!searching ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}>
              <Chip title="Все" on={rootFilter === 'all'} onPress={() => setRootFilter('all')} />
              <CountChip title="без цены" n={noPrice} red on={rootFilter === 'noprice'} onPress={() => setRootFilter(rootFilter === 'noprice' ? 'all' : 'noprice')} />
              {review ? <CountChip title="нужна разметка" n={review.length} on={rootFilter === 'review'} onPress={() => setRootFilter(rootFilter === 'review' ? 'all' : 'review')} /> : null}
            </ScrollView>
          ) : null}

          {searching ? (
            found.error ? <LoadError message={found.error} />
              : found.items === null || found.q !== q.trim() ? <Loading />
                : found.items.length === 0 ? <Empty title="Ничего не нашли" text="Поиск — по артикулу позиции" />
                  : <ItemList items={found.items} onItem={setDetail} seriesName={seriesName} />
          ) : rootFilter === 'review' && review ? (
            <>
              <Note style={{ paddingHorizontal: 20 }}>Позиции без роли или бухты без веса. Разметку делает администратор каталога Eskiz — до тех пор ядро их не использует</Note>
              {review.length ? <ItemList items={review} onItem={setDetail} seriesName={seriesName} /> : <Empty title="Разметка не нужна" />}
            </>
          ) : (
            brands.map((b) => {
              const rows = b.series.filter((s) => rootFilter !== 'noprice' || s.items_without_price > 0);
              if (!rows.length) return null;
              return (
                <View key={b.brand}>
                  <Label>{b.brand}</Label>
                  <Card>
                    {rows.map((s, i) => (
                      <Row key={s.system} first={i === 0} onPress={() => setSeries({ ...s, brand: b.brand })}
                        label={<Txt w={500} lines={1}>{s.series}</Txt>}
                        sub={<Txt size={14} color={C.muted} lines={1}>{[matTitle(s.material), `${s.items} ${plural(s.items, 'позиция', 'позиции', 'позиций')}`, s.price_updated ? `прайс ${dm(s.price_updated)}` : ''].filter(Boolean).join(' · ')}</Txt>}
                        right={s.items_without_price ? <St c="red">{`без цены · ${s.items_without_price}`}</St> : s.incomplete ? <Tag kind="n">неполная</Tag> : undefined} />
                    ))}
                  </Card>
                </View>
              );
            })
          )}
        </Body>
      )}
      <ItemSheet item={detail} onClose={() => setDetail(null)} seriesName={seriesName} />
    </Screen>
  );
}

function CountChip({ title, n, on, onPress, red }: { title: string; n: number; on: boolean; onPress: () => void; red?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={{ height: 40, borderRadius: 20, backgroundColor: on ? C.dark : C.card, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' }}>
      <Txt size={15} w={500} color={on ? '#fff' : red ? '#A1221A' : C.ink}>{`${title} · ${n}`}</Txt>
    </Pressable>
  );
}

function ItemList({ items, onItem, seriesName }: { items: Item[]; onItem: (it: Item) => void; seriesName?: Map<string, string> }) {
  return (
    <Card>
      {items.map((it, i) => {
        const p = priceOf(it);
        const sub = [ROLE_TITLE[it.role] ?? it.role, unitLine(it), it.color, seriesName ? seriesName.get(it.system) : ''].filter(Boolean).join(' · ');
        return (
          <Row key={`${it.item_id}:${it.color}`} first={i === 0} chevron={false} onPress={() => onItem(it)}
            label={<Txt w={500} lines={1} style={{ fontVariant: ['tabular-nums'] }}>{it.article}</Txt>}
            sub={<Txt size={14} color={C.muted} lines={1}>{sub}</Txt>}
            right={
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                {p.value === null ? <St c="red">нет цены</St> : (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Txt w={600} style={{ fontVariant: ['tabular-nums'] }}>{num(p.value)}</Txt>
                    {p.kind === 'demo' ? <Tag kind="est">ДЕМО</Tag> : p.kind === 'own' ? <Tag kind="ok">своя</Tag> : null}
                  </View>
                )}
                <Txt size={13} color={isOld(it.price_updated) ? '#8A4B00' : C.muted}>{dm(it.price_updated)}</Txt>
              </View>
            } />
        );
      })}
    </Card>
  );
}

function SeriesView({ s, onBack, onItem, detail, onCloseDetail }: {
  s: Series & { brand: string }; onBack: () => void; onItem: (it: Item) => void; detail: Item | null; onCloseDetail: () => void;
}) {
  const items = useLoad(() => api.get<Item[]>('/oyna/catalog/items', { system: s.system, limit: 2000 }), [s.system]);
  const [filter, setFilter] = useState<ItemFilter>('all');
  const [q, setQ] = useState('');
  const all = items.data ?? [];
  const count = (f: ItemFilter) => all.filter((it) => match(it, f)).length;
  const needle = q.trim().toLowerCase();
  const shown = all.filter((it) => match(it, filter) && (!needle || it.article.toLowerCase().includes(needle)));
  const filters: { f: ItemFilter; title: string }[] = [
    { f: 'noprice', title: 'без цены' }, { f: 'review', title: 'нужна разметка' }, { f: 'demo', title: 'ДЕМО' }, { f: 'old', title: `старше ${OLD_DAYS} дней` },
  ];
  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 6, minHeight: 56 }}>
        <IconButton name="back" label="Каталог" onPress={onBack} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt w={600} size={18} lines={1}>{`${s.brand} ${s.series}`}</Txt>
          <Txt size={14} color={C.muted} lines={1}>{[matTitle(s.material), s.usable_for_calc ? '' : 'не для расчёта', s.price_updated ? `прайс ${date(s.price_updated)}` : ''].filter(Boolean).join(' · ')}</Txt>
        </View>
      </View>
      {!items.data && items.loading ? <Loading /> : !items.data && items.error ? <LoadError message={items.error} onRetry={items.reload} /> : (
        <Body style={{ paddingTop: 4, gap: 10, paddingBottom: TAB_BAR_SPACE }} refresh={<RefreshControl refreshing={items.loading} onRefresh={items.reload} />}>
          <View style={{ paddingHorizontal: 12 }}><SearchBox value={q} onChange={setQ} placeholder="Артикул" /></View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}>
            <CountChip title="Все" n={all.length} on={filter === 'all'} onPress={() => setFilter('all')} />
            {filters.map(({ f, title }) => {
              const n = count(f);
              return n ? <CountChip key={f} title={title} n={n} red={f === 'noprice'} on={filter === f} onPress={() => setFilter(filter === f ? 'all' : f)} /> : null;
            })}
          </ScrollView>
          {s.incomplete ? <Note style={{ paddingHorizontal: 20 }}>Серия в прайсе неполная — часть профилей может не найтись</Note> : null}
          {shown.length ? <ItemList items={shown} onItem={onItem} /> : <Empty title="Позиций нет" text={needle ? 'Поиск — по артикулу позиции' : undefined} />}
        </Body>
      )}
      <ItemSheet item={detail} onClose={onCloseDetail} />
    </Screen>
  );
}

function match(it: Item, f: ItemFilter): boolean {
  if (f === 'noprice') return it.price_sum == null && it.own_price_sum == null;
  if (f === 'demo') return priceOf(it).kind === 'demo';
  if (f === 'review') return it.needs_review;
  if (f === 'old') return isOld(it.price_updated);
  return true;
}

/** Подробности позиции (просмотр) */
function ItemSheet({ item, onClose, seriesName }: { item: Item | null; onClose: () => void; seriesName?: Map<string, string> }) {
  const it = item;
  return (
    <Sheet visible={!!it} onClose={onClose} title={it?.article}>
      {it ? (
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 12, gap: 10 }}>
          <Card>
            <Row first label="Роль" value={ROLE_TITLE[it.role] ?? it.role} right={it.needs_review ? <Tag kind="est">нужна разметка</Tag> : undefined} />
            {seriesName?.get(it.system) ? <Row label="Серия" value={seriesName.get(it.system)} /> : null}
            <Row label="Цвет" value={it.color} />
            <Row label="Единица" value={unitLine(it)} right={!it.unit_confirmed ? <Tag kind="n">не сверена</Tag> : undefined} />
          </Card>
          <Card>
            <Row first label="Своя цена цеха" value={it.own_price_sum != null ? `${num(it.own_price_sum)} сум` : '—'} />
            <Row label="Базовая цена" value={it.price_sum != null ? `${num(it.price_sum)} сум` : 'нет цены'} />
            {it.demo_price_sum != null ? <Row label="ДЕМО-цена" value={`${num(it.demo_price_sum)} сум`} right={<Tag kind="est">ДЕМО</Tag>} /> : null}
            <Row label="Прайс от" value={it.price_updated ? date(it.price_updated) : '—'} />
          </Card>
          <Note style={{ paddingHorizontal: 20 }}>Цены и разметку меняют в веб-версии каталога</Note>
        </ScrollView>
      ) : null}
    </Sheet>
  );
}
