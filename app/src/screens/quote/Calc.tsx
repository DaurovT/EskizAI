/**
 * S09 Расчёт заказа — макеты Calc, CalcNoPrice (P.1), CalcDemo (D.1), CalcMeasurer.
 * GET /oyna/orders/{id}/calc?kit= — итог, $ по курсу, спецификация группами; себестоимость/наценка/маржа — только владельцу.
 * Переключатель комплектаций цеха перезапрашивает расчёт с ?kit=. Скидка — PATCH заказа. Нет цены — ввод владельцем (PUT /oyna/company/prices).
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { api, errorText } from '@/api/http';
import type { CustomLine, OrderFull, PositionOut } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { num } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { Act, Button, Chip, ErrorText, Field, IconButton, LoadError, Loading, Note, Screen, Seg, Sheet, Stepper, TopBar, Txt } from '@/ui/kit';
import { C } from '@/theme';
import {
  Banner, CalcGroup, CatalogItem, CompanyOut, FootBar, MissingPrice, OrderCalc, Pill, ROLE_TITLE, SoftButton, Tag, mln, perM2, plural, unitRu,
} from './parts';

const NONE = '';

export default function Calc() {
  const p = useLocalSearchParams<{ id: string; kit?: string }>();
  const id = String(p.id);
  const { role, isOwner } = useAuth();
  const [kit, setKit] = useState<string | null>(p.kit ? String(p.kit) : null);
  const [discOpen, setDiscOpen] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [lineFor, setLineFor] = useState<string | null>(null);   // «Добавить строку» — позиция

  const base = useLoad(async () => {
    const [order, company] = await Promise.all([
      api.get<OrderFull>(`/oyna/orders/${id}`),
      api.get<CompanyOut>('/oyna/company').catch(() => null),
    ]);
    return { order, company };
  }, [id]);
  // до загрузки заказа не знаем его комплектацию — ждём, чтобы не считать дважды
  const kitName: string | null | undefined = kit ?? (base.data ? base.data.order.kit_name : undefined);
  const calc = useLoad(() => (kitName === undefined ? Promise.resolve(null)
    : api.get<OrderCalc>(`/oyna/orders/${id}/calc`, { kit: kitName ?? undefined })), [id, kitName]);

  const pickKit = (name: string) => {
    setKit(name);
    router.setParams({ kit: name });
  };

  const order = base.data?.order;
  const kits = base.data?.company?.kits ?? [];
  const c = calc.data;

  /** номер позиции по помещению (missing[].position — room) */
  const posNo = useMemo(() => {
    const m = new Map<string, number>();
    (order?.positions ?? []).filter((x) => !x.deleted).forEach((x, i) => { if (x.room && !m.has(x.room)) m.set(x.room, i + 1); });
    return m;
  }, [order]);

  const missing = useMemo(() => {
    const seen = new Map<string, MissingPrice & { positions: string[] }>();
    for (const m of c?.missing ?? []) {
      const k = m.item_id || m.name;
      const pos = m.position ? String(posNo.get(m.position) ?? m.position) : '';
      const cur = seen.get(k);
      if (cur) { if (pos && !cur.positions.includes(pos)) cur.positions.push(pos); }
      else seen.set(k, { ...m, positions: pos ? [pos] : [] });
    }
    return [...seen.values()];
  }, [c, posNo]);

  const roleSuffix = !isOwner && role ? ` · ${ROLE_TITLE[role]}` : '';
  const head = (
    <TopBar title={`Расчёт${roleSuffix}`} onBack={() => router.back()}
      right={<IconButton name="file" label="Документы" onPress={() => router.push(`/order/${id}/docs`)} />} />
  );

  if (base.error && !base.data) return <Screen>{head}<LoadError message={base.error} onRetry={base.reload} /></Screen>;
  if (!c && calc.error) return <Screen>{head}<LoadError message={calc.error} onRetry={calc.reload} /></Screen>;
  if (!c || !order) return <Screen>{head}<Loading /></Screen>;

  const area = order.area_m2;
  const goods = c.total - (order.extras_total ?? 0);
  const per = area ? Math.round(goods / area) : null;
  const incomplete = missing.length > 0;
  const allPos = [...new Set(missing.flatMap((m) => m.positions))];
  const first = missing[0];

  return (
    <Screen>
      {head}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 16, gap: 10 }}>
        {kits.length ? (
          <Seg style={{ marginHorizontal: 0 }} items={kits.map((k) => ({ value: k.name, title: k.name }))} value={kitName ?? NONE} onChange={pickKit} />
        ) : null}

        {incomplete ? (
          <Banner kind="err"
            title={allPos.length > 1 ? `Нет цены у позиций ${allPos.join(', ')}` : allPos.length ? `Нет цены у позиции ${allPos[0]}` : 'Нет цены в расчёте'}
            text={`${first.name}${missing.length > 1 ? ` и ещё ${missing.length - 1}` : ''} · КП не отправить${isOwner ? '' : ' · попросите владельца внести цену'}`}
            action={isOwner ? 'Ввести' : undefined} onAction={() => setPriceOpen(true)} />
        ) : null}
        {c.demo ? (
          <Banner kind="est" title="В расчёте есть ДЕМО-цены" text="Это не цены поставщика. КП уйдёт с меткой «ДЕМО»" />
        ) : null}

        <View style={{ backgroundColor: C.card, borderRadius: 28, paddingVertical: 16, paddingHorizontal: 20 }}>
          <Txt size={14} color={C.muted}>
            {['Клиенту', area ? `${num(area, 1)} м²` : '', per ? `${perM2(per)}/м²` : '', c.discount_pct ? `скидка ${num(c.discount_pct, 1)}%` : '']
              .filter(Boolean).join(' · ')}
          </Txt>
          <Txt size={30} w={700} style={{ lineHeight: 36, letterSpacing: -0.6, fontVariant: ['tabular-nums'] }}>
            {incomplete ? 'от ' : ''}{num(c.total)} <Txt size={17} w={500} color={C.muted}>сум</Txt>
          </Txt>
          {c.total_usd && c.usd_rate ? (
            <Txt size={14} color={C.muted} style={{ fontVariant: ['tabular-nums'] }}>${num(c.total_usd)} по курсу {num(c.usd_rate)}</Txt>
          ) : null}
          {isOwner && c.cost !== undefined ? <OwnerStats c={c} /> : null}
        </View>

        <Txt size={15} w={600} color={C.muted} style={{ paddingHorizontal: 8, paddingTop: 2 }}>Спецификация</Txt>
        <View style={{ backgroundColor: C.card, borderRadius: 28, overflow: 'hidden' }}>
          {specRows(c, isOwner).map((r, i) => (
            <SpecRow key={r.key} first={i === 0} title={r.title} sub={r.sub} value={r.value} status={r.status} />
          ))}
          {!c.groups.length ? <View style={{ padding: 20 }}><Note>В заказе пока нет позиций</Note></View> : null}
        </View>
        <CustomLines positions={order.positions.filter((x) => !x.deleted)} onAdd={(pid) => setLineFor(pid)}
          onRemove={async (pos, i) => {
            const doc = { ...pos.doc, custom_lines: (pos.doc.custom_lines ?? []).filter((_, k) => k !== i) };
            try { await api.put(`/oyna/orders/${id}/positions/${pos.id}`, { doc, base_rev: pos.rev }); } catch { /* перечитаем */ }
            void base.reload(); void calc.reload();
          }} />
        {calc.loading ? <Note center>Пересчитываем…</Note> : null}
        {calc.error ? <ErrorText>{calc.error}</ErrorText> : null}
      </ScrollView>

      <FootBar>
        <SoftButton title={c.discount_pct ? `Скидка ${num(c.discount_pct, 1)}%` : 'Скидка'} onPress={() => setDiscOpen(true)} />
        <Button title="Отправить КП" style={{ flex: 1 }} disabled={incomplete} onPress={() => router.push(`/order/${id}/quote`)} />
      </FootBar>

      <LineSheet orderId={id} pos={order.positions.find((x) => x.id === lineFor) ?? null} positions={order.positions.filter((x) => !x.deleted)}
        onPick={setLineFor} onClose={() => setLineFor(null)}
        onSaved={() => { setLineFor(null); void base.reload(); void calc.reload(); }} />
      <DiscountSheet visible={discOpen} onClose={() => setDiscOpen(false)} orderId={id} value={c.discount_pct}
        onSaved={() => { setDiscOpen(false); void calc.reload(); void base.reload(); }} />
      {isOwner ? (
        <PriceSheet visible={priceOpen} onClose={() => setPriceOpen(false)} items={missing}
          onSaved={() => { setPriceOpen(false); void calc.reload(); }} />
      ) : null}
    </Screen>
  );
}

/** Себестоимость · Наценка · Маржа (только владелец; сервер другим не отдаёт) */
function OwnerStats({ c }: { c: OrderCalc }) {
  const v = c.markup_value ?? 0;
  const [label, value] = c.markup_kind === 'margin' ? ['Доля маржи', `${num(v, 1)}%`]
    : c.markup_kind === 'per_m2' ? ['Наценка', `+${perM2(v)}/м²`] : ['Наценка', `+${num(v, 1)}%`];
  const hint = c.markup_kind === 'margin' ? 'доля маржи в цене' : c.markup_kind === 'per_m2' ? 'сумма за м²' : 'на себестоимость';
  const cell = (cap: string, val: string, flex: number, a11y?: string) => (
    <View style={{ flex }} accessible accessibilityLabel={`${cap}: ${val}${a11y ? `, ${a11y}` : ''}`}>
      <Txt size={14} color={C.muted}>{cap}</Txt>
      <Txt w={700} style={{ fontVariant: ['tabular-nums'] }}>{val}</Txt>
    </View>
  );
  return (
    <View style={{ flexDirection: 'row', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.line }}>
      {cell('Себестоимость', mln(c.cost), 1.35)}
      {cell(label, value, 1, hint)}
      {cell('Маржа', c.margin !== undefined ? mln(c.margin) : '—', 1)}
    </View>
  );
}

type SpecItem = { key: string; title: string; sub?: string; value?: string; status?: 'none' | 'demo' };

/** Строки спецификации: группы сервера, «добавлен автоматически» после фурнитуры, сопутствующие товары — строкой каждый */
function specRows(c: OrderCalc, owner: boolean): SpecItem[] {
  const out: SpecItem[] = [];
  const auto: SpecItem[] = c.auto_added.map((s, i) => {
    const sp = s.indexOf(' ');
    const code = sp > 0 ? s.slice(0, sp) : s;
    const title = sp > 0 ? s.slice(sp + 1) : s;
    return { key: `auto${i}`, title: title.charAt(0).toUpperCase() + title.slice(1), sub: `добавлен автоматически · ${code}` };
  });
  let autoPlaced = false;
  for (const g of c.groups) {
    if (g.key === 'extras') {
      g.lines.forEach((l, i) => out.push({
        key: `ex${i}`, title: l.name, sub: `сопутствующий товар · ${num(l.qty, 2)} шт`, value: owner && l.total !== undefined ? mln(l.total) : undefined,
      }));
      continue;
    }
    const status = g.price_status === 'none' ? 'none' : g.price_status === 'demo' ? 'demo' : undefined;
    out.push({ key: g.key, title: g.title, sub: groupSub(g), status,
      value: status === 'none' ? (owner ? '—' : undefined) : owner && g.cost !== undefined ? mln(g.cost) : undefined });
    if (g.key === 'fitting' && auto.length) { out.push(...auto); autoPlaced = true; }
  }
  if (!autoPlaced) {
    const extrasAt = out.findIndex((x) => x.key.startsWith('ex'));
    out.splice(extrasAt < 0 ? out.length : extrasAt, 0, ...auto);
  }
  return out;
}

/** Подпись группы: что внутри · количество (как «рама, створки, импосты · 14 хлыстов», «4-12-4i · 10,4 м²») */
function groupSub(g: CalcGroup): string {
  const names = g.lines.map((l) => l.name.replace(/^Стеклопакет\s+/, ''));
  const shown = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '');
  const what = g.key === 'work' ? names.join(', ').toLowerCase() : shown;
  let qty: string;
  if (g.bars) qty = `${g.bars} ${plural(g.bars, 'хлыст', 'хлыста', 'хлыстов')}`;
  else if (g.unit === 'pcs') qty = `${num(g.qty)} шт`;
  else qty = `${num(g.qty, 1)} ${unitRu(g.unit)}`;
  const sup = [...new Set(g.lines.map((l) => l.supplier_name ?? l.supplier).filter(Boolean))];
  const supText = sup.length ? `поставщик: ${sup.join(', ')}` : '';
  return (g.key === 'work' ? [what, supText] : [what, qty, supText]).filter(Boolean).join(' · ');
}

// ---------- свои строки позиций (doc.custom_lines, §9.7) ----------
function CustomLines({ positions, onAdd, onRemove }: {
  positions: PositionOut[]; onAdd: (pos: string) => void; onRemove: (pos: PositionOut, i: number) => void;
}) {
  const rows = positions.flatMap((p, pi) => (p.doc.custom_lines ?? []).map((l, i) => ({ p, pi, l, i })));
  if (!positions.length) return null;
  return (
    <>
      <Txt size={15} w={600} color={C.muted} style={{ paddingHorizontal: 8, paddingTop: 2 }}>Свои строки</Txt>
      <View style={{ backgroundColor: C.card, borderRadius: 28, overflow: 'hidden' }}>
        {rows.map(({ p, pi, l, i }, k) => (
          <View key={`${p.id}:${i}`} style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingLeft: 20, paddingRight: 8, paddingVertical: 8 },
            k > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Txt w={500}>{l.name}</Txt>
              <Txt size={14} color={C.muted}>{`Позиция ${pi + 1}${p.room ? ` · ${p.room}` : ''} · ${num(l.qty, 2)} ${l.unit} × ${num(l.price_sum)}${l.no_markup ? ' · без наценки' : ''}`}</Txt>
            </View>
            <Txt w={600} style={{ fontVariant: ['tabular-nums'] }}>{mln(l.qty * l.price_sum)}</Txt>
            <IconButton name="close" label="Убрать строку" onPress={() => onRemove(p, i)} />
          </View>
        ))}
        <View style={[{ padding: 12 }, rows.length > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}>
          <SoftButton title="Добавить строку" onPress={() => onAdd(positions[0].id)} />
        </View>
      </View>
      <Note style={{ paddingHorizontal: 8 }}>Работа или материал, которых нет в каталоге — в цену позиции, с наценкой</Note>
    </>
  );
}

function LineSheet({ orderId, pos, positions, onPick, onClose, onSaved }: {
  orderId: string; pos: PositionOut | null; positions: PositionOut[]; onPick: (id: string) => void; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [unit, setUnit] = useState('шт');
  const [price, setPrice] = useState('');
  const [noMarkup, setNoMarkup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (pos) { setName(''); setQty('1'); setUnit('шт'); setPrice(''); setNoMarkup(false); setErr(null); } }, [pos?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = Number(qty.replace(',', '.')), pr = Number(price);
  const ok = !!pos && name.trim().length > 0 && q > 0 && pr >= 0 && price !== '';
  const save = async () => {
    if (!pos || !ok) return;
    setBusy(true); setErr(null);
    const line: CustomLine = { name: name.trim(), qty: q, unit: unit.trim() || 'шт', price_sum: pr, ...(noMarkup ? { no_markup: true } : {}) };
    const doc = { ...pos.doc, custom_lines: [...(pos.doc.custom_lines ?? []), line] };
    try { await api.put(`/oyna/orders/${orderId}/positions/${pos.id}`, { doc, base_rev: pos.rev }); onSaved(); }
    catch (e) { setErr(errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <Sheet visible={!!pos} onClose={onClose} title="Своя строка в позиции">
      <View style={{ paddingHorizontal: 12, gap: 8, paddingBottom: 8 }}>
        {positions.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} keyboardShouldPersistTaps="handled">
            {positions.map((p, i) => <Chip key={p.id} title={`${i + 1}${p.room ? ` · ${p.room}` : ''}`} on={p.id === pos?.id} onPress={() => onPick(p.id)} />)}
          </ScrollView>
        ) : null}
        <Field label="Название" value={name} onChangeText={setName} placeholder="Демонтаж решётки" />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="Количество" value={qty} onChangeText={setQty} keyboardType="decimal-pad" style={{ flex: 1 }} />
          <Field label="Ед." value={unit} onChangeText={setUnit} style={{ width: 96 }} />
        </View>
        <Field label="Цена за единицу, сум" value={price} onChangeText={(t) => setPrice(t.replace(/[^\d]/g, ''))} keyboardType="number-pad" placeholder="0" />
        <Chip title="Без наценки" on={noMarkup} onPress={() => setNoMarkup(!noMarkup)} />
        <ErrorText>{err}</ErrorText>
        <Button title="Добавить" onPress={() => void save()} disabled={!ok} loading={busy} />
      </View>
    </Sheet>
  );
}

function SpecRow({ title, sub, value, status, first }: SpecItem & { first?: boolean }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingHorizontal: 20, paddingVertical: 10 },
      !first && { borderTopWidth: 1, borderTopColor: C.line }]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <Txt w={500} style={{ lineHeight: 21 }}>{title}</Txt>
          {status === 'none' ? <Pill kind="red" title="нет цены" small /> : status === 'demo' ? <Tag kind="est" title="ДЕМО" /> : null}
        </View>
        {sub ? <Txt size={14} color={C.muted} style={{ lineHeight: 19 }}>{sub}</Txt> : null}
      </View>
      {value ? <Txt w={600} style={{ lineHeight: 21, fontVariant: ['tabular-nums'] }}>{value}</Txt> : null}
    </View>
  );
}

// ---------- скидка ----------
function DiscountSheet({ visible, onClose, orderId, value, onSaved }: { visible: boolean; onClose: () => void; orderId: string; value: number; onSaved: () => void }) {
  const [v, setV] = useState(value);
  useEffect(() => { if (visible) setV(value); }, [visible, value]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api.patch(`/oyna/orders/${orderId}`, { discount_pct: v }); onSaved(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="Скидка клиенту">
      <View style={{ paddingHorizontal: 16, gap: 14, paddingBottom: 8 }}>
        <View style={{ backgroundColor: C.card, borderRadius: 20, padding: 16, flexDirection: 'row', alignItems: 'center' }}>
          <Txt w={500} style={{ flex: 1 }}>Скидка на заказ</Txt>
          <Stepper value={v} onChange={setV} min={0} max={50} step={1} format={(x) => `${x}%`} />
        </View>
        <Note>Скидка считается от суммы изделий, сопутствующие товары — без скидки. Цена округляется до 1000 сум.</Note>
        <ErrorText>{err}</ErrorText>
        <Button title="Сохранить" loading={busy} onPress={save} />
      </View>
    </Sheet>
  );
}

// ---------- ввод цены (P.1) ----------
const COLORS = ['Белый', 'Ламинация', 'Цветной', 'Вакуум', 'Внешний внутренний', 'Эксклюзив'];
type Resolved = { color: string | null; unit: string | null; colors: string[] };

function PriceSheet({ visible, onClose, items, onSaved }: { visible: boolean; onClose: () => void; items: (MissingPrice & { positions: string[] })[]; onSaved: () => void }) {
  const [info, setInfo] = useState<Record<string, Resolved>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [colors, setColors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const resolve = useCallback(async () => {
    const out: Record<string, Resolved> = {};
    await Promise.all(items.filter((m) => m.item_id).map(async (m) => {
      try {
        const list = await api.get<CatalogItem[]>('/oyna/catalog/items', { q: m.article ?? undefined, limit: 200 });
        const hit = list.find((x) => x.item_id === m.item_id);
        out[m.item_id!] = { color: hit?.color ?? null, unit: hit?.unit ?? null, colors: [...new Set(list.filter((x) => x.article === m.article).map((x) => x.color))] };
      } catch {
        out[m.item_id!] = { color: null, unit: null, colors: [] };
      }
    }));
    setInfo(out);
  }, [items]);
  useEffect(() => { if (visible && items.some((m) => m.item_id)) void resolve(); }, [visible, resolve, items]);

  const withId = items.filter((m) => m.item_id);
  const settingsOnly = items.filter((m) => !m.item_id);

  const save = async () => {
    const rows = withId.map((m) => {
      const id = m.item_id!;
      const price = Number((prices[id] ?? '').replace(/\s/g, '').replace(',', '.'));
      const color = info[id]?.color ?? colors[id];
      return price > 0 && color ? { item_id: id, color, price_sum: price } : null;
    }).filter(Boolean);
    if (!rows.length) { setErr('Введите цену и выберите цвет'); return; }
    setBusy(true); setErr(null);
    try { await api.put('/oyna/company/prices', rows); onSaved(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Ввести цену">
      <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 12, paddingBottom: 8 }}
        keyboardShouldPersistTaps="handled">
        <Note>Цена цеха ляжет поверх базового прайса и сразу попадёт в расчёт.</Note>
        {withId.map((m) => {
          const id = m.item_id!;
          const r = info[id];
          const unit = r?.unit ? unitRu(r.unit) : '';
          return (
            <View key={id} style={{ backgroundColor: C.card, borderRadius: 20, padding: 16, gap: 10 }}>
              <View>
                <Txt w={600}>{m.name}</Txt>
                <Note>{[m.article, r?.color, m.positions.length ? `позиция ${m.positions.join(', ')}` : ''].filter(Boolean).join(' · ')}</Note>
              </View>
              {r && !r.color ? (
                <View style={{ gap: 8 }}>
                  <Note>Цвет (ценовая группа)</Note>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {(r.colors.length ? r.colors : COLORS).map((col) => (
                      <Chip key={col} title={col} on={colors[id] === col} onPress={() => setColors((s) => ({ ...s, [id]: col }))} />
                    ))}
                  </View>
                </View>
              ) : null}
              <Field label={unit ? `Цена, сум за ${unit}` : 'Цена, сум'} keyboardType="numeric" value={prices[id] ?? ''}
                onChangeText={(t) => setPrices((s) => ({ ...s, [id]: t.replace(/[^\d.,\s]/g, '') }))} style={{ backgroundColor: C.soft }} />
            </View>
          );
        })}
        {settingsOnly.length ? (
          <View style={{ backgroundColor: C.card, borderRadius: 20, padding: 16, gap: 8 }}>
            <Txt w={600}>В настройках цеха</Txt>
            <Note>{settingsOnly.map((m) => m.name).join(', ')} — цены работ, стекла и материалов задаются в настройках.</Note>
            <Act title="Открыть настройки" onPress={() => { onClose(); router.push('/profile'); }} style={{ alignSelf: 'flex-start' }} />
          </View>
        ) : null}
        <ErrorText>{err}</ErrorText>
        {withId.length ? <Button title="Сохранить цены" loading={busy} onPress={save} /> : null}
      </ScrollView>
    </Sheet>
  );
}
