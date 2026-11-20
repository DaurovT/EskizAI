/**
 * S09 Расчёт заказа — макет «Ядро v3» X6Calc (+ CalcNoPrice (P.1), CalcDemo (D.1), CalcMeasurer из docs/design).
 * Комплектации, итог (себестоимость · наценка · маржа — владельцу), «Своя строка» и «Скидка», свёрнутые группы
 * Материалы (профиль · хлысты, стеклопакеты, фурнитура, прочее) / Работы / Товары / Свои строки, «Отправить КП».
 * GET /oyna/orders/{id}/calc?kit= — итог, $ по курсу, спецификация группами; себестоимость/наценка/маржа — только владельцу.
 * Переключатель комплектаций цеха перезапрашивает расчёт с ?kit=. Скидка — PATCH заказа. Нет цены — ввод владельцем (PUT /oyna/company/prices).
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { api, errorText } from '@/api/http';
import type { CustomLine, OrderFull, PositionOut } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { num } from '@/lib/format';
import { cells } from '@/lib/tree';
import { Icon } from '@/ui/Icon';
import { PriceLine } from '@/ui/v3';
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
  const [lineFor, setLineFor] = useState<string | null>(null);   // «Своя строка» — позиция
  const [openSet, setOpen] = useState<Set<string>>(() => new Set(['mat']));   // раскрытые группы (Материалы — сразу, как в макете)

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

  const positions = order.positions.filter((x) => !x.deleted);
  const groups = specGroups(c, positions, isOwner);
  const removeLine = async (pos: PositionOut, i: number) => {
    const doc = { ...pos.doc, custom_lines: (pos.doc.custom_lines ?? []).filter((_, k) => k !== i) };
    try { await api.put(`/oyna/orders/${id}/positions/${pos.id}`, { doc, base_rev: pos.rev }); } catch { /* перечитаем */ }
    void base.reload(); void calc.reload();
  };
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });

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

        {/* итог: клиенту, себестоимость · наценка · маржа (владельцу) */}
        <View style={{ backgroundColor: C.card, borderRadius: 28, paddingVertical: 16, paddingHorizontal: 20 }}>
          <Txt size={14} color="#5F5C57">
            {['Клиенту', area ? `${num(area, 1)} м²` : '', per ? `${perM2(per)}/м²` : '', c.discount_pct ? `скидка ${num(c.discount_pct, 1)}%` : '']
              .filter(Boolean).join(' · ')}
          </Txt>
          <PriceLine value={`${incomplete ? 'от ' : ''}${num(c.total)}`} />
          {c.total_usd && c.usd_rate ? (
            <Txt size={14} color={C.muted} style={{ fontVariant: ['tabular-nums'] }}>${num(c.total_usd)} по курсу {num(c.usd_rate)}</Txt>
          ) : null}
          {isOwner && c.cost !== undefined ? <OwnerStats c={c} /> : null}
        </View>

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <SmallSoft title="Своя строка" plus disabled={!positions.length} onPress={() => positions[0] && setLineFor(positions[0].id)} />
          <SmallSoft title={c.discount_pct ? `Скидка ${num(c.discount_pct, 1)}%` : 'Скидка'} onPress={() => setDiscOpen(true)} />
        </View>

        {/* спецификация: Материалы / Работы / Товары / Свои строки — свёрнуты, по нажатию строки внутри */}
        <View style={{ backgroundColor: C.card, borderRadius: 28, overflow: 'hidden' }}>
          {groups.map((g, gi) => {
            const isOpen = openSet.has(g.key);
            return (
              <View key={g.key}>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: isOpen }} onPress={() => toggle(g.key)}
                  style={({ pressed }) => [s.row, gi > 0 && s.sep, pressed && { backgroundColor: '#F7F7F5' }]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                      <Txt w={600} style={{ lineHeight: 21 }}>{g.title}</Txt>
                      {g.status === 'none' ? <Pill kind="red" title="нет цены" small /> : g.status === 'demo' ? <Tag kind="est" title="ДЕМО" /> : null}
                    </View>
                    {g.sub ? <Txt size={14} color="#5F5C57" lines={2} style={{ lineHeight: 19 }}>{g.sub}</Txt> : null}
                  </View>
                  {g.value ? <Txt w={600} style={{ fontVariant: ['tabular-nums'] }}>{g.value}</Txt> : null}
                  <View style={{ transform: [{ rotate: isOpen ? '180deg' : '0deg' }] }}><Icon name="chevron_down" size={20} color="#B4B1AB" /></View>
                </Pressable>
                {isOpen ? g.items.map((it) => (
                  <View key={it.key} style={[s.child, s.sep]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                        <Txt size={14} lines={2} style={{ lineHeight: 19 }}>{it.title}</Txt>
                        {it.status === 'none' ? <Pill kind="red" title="нет цены" small /> : it.status === 'demo' ? <Tag kind="est" title="ДЕМО" /> : null}
                      </View>
                      {it.sub ? <Txt size={13} color={C.muted} lines={2}>{it.sub}</Txt> : null}
                    </View>
                    {it.value ? <Txt size={14} color="#5F5C57" style={{ fontVariant: ['tabular-nums'] }}>{it.value}</Txt> : null}
                    {it.line ? <IconButton name="close" label="Убрать строку" bg={C.soft} onPress={() => void removeLine(it.line!.p, it.line!.i)} /> : null}
                  </View>
                )) : null}
              </View>
            );
          })}
          {!groups.length ? <View style={{ padding: 20 }}><Note>В заказе пока нет позиций</Note></View> : null}
        </View>
        {calc.loading ? <Note center>Пересчитываем…</Note> : null}
        {calc.error ? <ErrorText>{calc.error}</ErrorText> : null}
      </ScrollView>

      <FootBar>
        <Button title="Отправить КП" style={{ flex: 1 }} disabled={incomplete} onPress={() => router.push(`/order/${id}/quote`)} />
      </FootBar>

      <LineSheet orderId={id} pos={order.positions.find((x) => x.id === lineFor) ?? null} positions={positions}
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

// ---------- спецификация группами (X6Calc): Материалы · Работы · Товары · Свои строки ----------
type Status = 'none' | 'demo' | undefined;
type SpecItem = { key: string; title: string; sub?: string; value?: string; status?: Status; line?: { p: PositionOut; i: number } };
type SpecGroup = { key: string; title: string; sub: string; value?: string; status?: Status; items: SpecItem[] };

const PROFILE_KEYS = ['profile', 'reinforcement', 'bead'];
const NOT_MATERIAL = ['work', 'custom', 'extras'];
const statusOf = (gs: CalcGroup[]): Status => (gs.some((g) => g.price_status === 'none') ? 'none' : gs.some((g) => g.price_status === 'demo') ? 'demo' : undefined);
const costOf = (gs: CalcGroup[], owner: boolean) => {
  if (!owner || !gs.length || gs.every((g) => g.cost === undefined)) return undefined;
  return mln(gs.reduce((a, g) => a + (g.cost ?? 0), 0));
};
const suppliers = (gs: CalcGroup[]) => {
  const sup = [...new Set(gs.flatMap((g) => g.lines.map((l) => l.supplier_name ?? l.supplier)).filter(Boolean))];
  return sup.length ? `поставщик: ${sup.join(', ')}` : '';
};

/** Группы расчёта сервера → свёрнутые разделы макета. Количество стеклопакетов и створок — по изделиям заказа (× количество). */
function specGroups(c: OrderCalc, positions: PositionOut[], owner: boolean): SpecGroup[] {
  const out: SpecGroup[] = [];
  const by = (keys: string[]) => c.groups.filter((g) => keys.includes(g.key));
  // --- материалы
  const mat = c.groups.filter((g) => !NOT_MATERIAL.includes(g.key));
  if (mat.length) {
    let panes = 0, sashes = 0;
    for (const p of positions) {
      let list: { cell: { type: string; fill?: { kind: string } } }[] = [];
      try { list = cells(p.doc); } catch { list = []; }
      const q = p.qty || 1;
      panes += q * list.filter((x) => x.cell.type !== 'panel' || x.cell.fill?.kind === 'glass').length;
      sashes += q * list.filter((x) => x.cell.type === 'sash' || x.cell.type === 'door_sash').length;
    }
    const items: SpecItem[] = [];
    const prof = by(PROFILE_KEYS);
    if (prof.length) {
      const bars = prof.reduce((a, g) => a + (g.bars ?? 0), 0);
      items.push({ key: 'profile', title: `Профиль${bars ? ` · ${bars} ${plural(bars, 'хлыст', 'хлыста', 'хлыстов')}` : ''}`, sub: suppliers(prof) || undefined,
        value: costOf(prof, owner), status: statusOf(prof) });
    }
    const glass = by(['glass']);
    if (glass.length) {
      items.push({ key: 'glass', title: `Стеклопакеты${panes ? ` · ${panes} шт` : ''}`, sub: [glass[0].lines.map((l) => l.name.replace(/^Стеклопакет\s+/, '')).slice(0, 2).join(', '), suppliers(glass)].filter(Boolean).join(' · ') || undefined,
        value: costOf(glass, owner), status: statusOf(glass) });
    }
    const fit = by(['fitting']);
    if (fit.length) {
      items.push({ key: 'fitting', title: `Фурнитура${sashes ? ` · ${sashes} ${plural(sashes, 'створка', 'створки', 'створок')}` : ''}`, sub: suppliers(fit) || undefined,
        value: costOf(fit, owner), status: statusOf(fit) });
    }
    const rest = mat.filter((g) => ![...PROFILE_KEYS, 'glass', 'fitting'].includes(g.key));
    if (rest.length) {
      const n = rest.reduce((a, g) => a + g.lines.length, 0);
      items.push({ key: 'rest', title: `Прочее · ${n} ${plural(n, 'строка', 'строки', 'строк')}`, sub: rest.map((g) => g.title.toLowerCase()).join(', '),
        value: costOf(rest, owner), status: statusOf(rest) });
    }
    c.auto_added.forEach((a, i) => {
      const sp = a.indexOf(' ');
      const code = sp > 0 ? a.slice(0, sp) : a, title = sp > 0 ? a.slice(sp + 1) : a;
      items.push({ key: `auto${i}`, title: title.charAt(0).toUpperCase() + title.slice(1), sub: `добавлен автоматически · ${code}` });
    });
    const names = [prof.length ? 'профиль' : '', glass.length ? 'стекло' : '', fit.length ? 'фурнитура' : '', rest.length ? 'прочее' : ''].filter(Boolean);
    out.push({ key: 'mat', title: 'Материалы', sub: names.join(', '), value: costOf(mat, owner), status: statusOf(mat), items });
  }
  // --- работы
  const work = by(['work']);
  if (work.length) {
    const lines = work.flatMap((g) => g.lines);
    out.push({ key: 'work', title: 'Работы', sub: [lines.map((l) => l.name.toLowerCase()).slice(0, 4).join(', '), suppliers(work)].filter(Boolean).join(' · '),
      value: costOf(work, owner), status: statusOf(work),
      items: lines.map((l, i) => ({ key: `w${i}`, title: l.name, sub: `${num(l.qty, 2)} ${unitRu(work[0].unit)}` })) });
  }
  // --- товары (сопутствующие)
  const ex = by(['extras']);
  if (ex.length) {
    const lines = ex.flatMap((g) => g.lines);
    out.push({ key: 'goods', title: 'Товары', sub: lines.map((l) => l.name.toLowerCase()).join(', '),
      value: owner ? mln(lines.reduce((a, l) => a + (l.total ?? 0), 0)) : undefined,
      items: lines.map((l, i) => ({ key: `g${i}`, title: l.name, sub: `${num(l.qty, 2)} шт`, value: owner && l.total !== undefined ? mln(l.total) : undefined })) });
  }
  // --- свои строки позиций (doc.custom_lines, §9.7) — со снятием
  const own = positions.flatMap((p, pi) => (p.doc.custom_lines ?? []).map((l, i) => ({ p, pi, l, i })));
  const cust = by(['custom']);
  if (own.length || cust.length) {
    out.push({ key: 'own', title: 'Свои строки', sub: own.length ? own.map((x) => x.l.name.toLowerCase()).slice(0, 3).join(', ') : 'работа или материал не из каталога',
      value: costOf(cust, owner),
      items: own.map(({ p, pi, l, i }) => ({
        key: `${p.id}:${i}`, title: l.name, line: { p, i }, value: mln(l.qty * l.price_sum),
        sub: `Позиция ${pi + 1}${p.room ? ` · ${p.room}` : ''} · ${num(l.qty, 2)} ${l.unit} × ${num(l.price_sum)}${l.no_markup ? ' · без наценки' : ''}`,
      })) });
  }
  return out;
}

/** .soft.sm на сером фоне — белая, 44 */
function SmallSoft({ title, onPress, plus, disabled }: { title: string; onPress: () => void; plus?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={({ pressed }) => [s.soft, { opacity: disabled ? 0.45 : pressed ? 0.8 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
      {plus ? <Icon name="plus" size={18} /> : null}
      <Txt size={15} w={500}>{title}</Txt>
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingHorizontal: 20, paddingVertical: 10 },
  child: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingLeft: 36, paddingRight: 12, paddingVertical: 8 },
  sep: { borderTopWidth: 1, borderTopColor: C.line },
  soft: { flex: 1, height: 44, borderRadius: 999, backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 14 },
});

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
