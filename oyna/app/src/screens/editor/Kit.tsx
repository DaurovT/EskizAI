/**
 * S08 Комплектация — макеты: Kit, GlassFormula (docs/design).
 * Охват «заказ / позиция / ячейка». Заказ: цены комплектаций цеха (GET …/variants) и «применить ко всему заказу»
 * (POST …/apply-kit). Позиция и ячейка: система, декоры, стеклопакет, фурнитура, детали створки — каждая строка
 * открывает лист замен (/alternatives). Своя формула стеклопакета: разбор на сервере (POST /oyna/glass/parse) на лету.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';

import { api, ApiError, errorText } from '@/api/http';
import type { Calc, Command, Doc, OrderFull, PositionOut, Variant } from '@/api/types';
import { money, num } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { C } from '@/theme';
import { Icon } from '@/ui/Icon';
import { Body, Button, Dock, Empty, Field, LoadError, Loading, Note, Row, Screen, Seg, TopBar, Txt } from '@/ui/kit';
import {
  calcDoc, cellAt, cellTitle, ConflictError, Decor, FittingSet, fittingLabel, glassLabel, GlassParse, GlassPreset, lamLabel, OptCard, Pill, plural,
  glassDecorLabel, posStore, profileColorLabel, refs, sendCommands, st, SystemRow, systemName, systemSub, Tag, usePosition, useToast,
} from './parts';

type Scope = 'order' | 'position' | 'cell';

type Names = { systems: SystemRow[]; decors: Decor[]; glass: GlassPreset[]; fittings: FittingSet[] };

/** Справочники для подписей (система, декоры, стекло, фурнитура). */
function useNames(system?: string) {
  const [n, setN] = useState<Names | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([refs.systems(), refs.decors(), refs.glass(system), refs.fittings(system)])
      .then(([systems, decors, glass, fittings]) => { if (alive) setN({ systems, decors, glass, fittings }); })
      .catch(() => { if (alive) setN({ systems: [], decors: [], glass: [], fittings: [] }); });
    return () => { alive = false; };
  }, [system]);
  return n;
}

const chambersOf = (formula: string) => Math.max(0, (formula.split('-').length - 1) / 2);
function glassSub(spec: string | undefined, glass: GlassPreset[] | undefined): string {
  if (!spec) return '';
  const p = glass?.find((g) => g.code === spec);
  const f = glassLabel(spec, glass);
  const ch = chambersOf(f);
  const parts = [p ? `${num(p.thickness_mm, 1)} мм` : '', ch ? `${ch} ${plural(ch, 'камера', 'камеры', 'камер')}` : 'одинарное'];
  if (/i(?![a-z])/.test(f)) parts.push('энергосбер.');
  return parts.filter(Boolean).join(' · ');
}

export default function Kit() {
  const { id, pos, path } = useLocalSearchParams<{ id: string; pos?: string; path?: string }>();
  const posId = typeof pos === 'string' && pos ? pos : undefined;
  const cellPath = typeof path === 'string' ? path : undefined;
  const [scope, setScope] = useState<Scope>(cellPath !== undefined && posId ? 'cell' : posId ? 'position' : 'order');
  const [formula, setFormula] = useState(false);
  const P = usePosition(id, posId);
  const [toast, showToast] = useToast();

  const back = () => (formula ? setFormula(false) : router.canGoBack() ? router.back() : router.replace(`/order/${id}`));

  const run = useCallback(async (commands: Command[], done?: string) => {
    if (!P.pos) return false;
    try {
      const out = await sendCommands(id, P.pos, commands);
      P.update(out);
      if (done) showToast(done);
      return true;
    } catch (e) {
      if (!(e instanceof ConflictError)) showToast(errorText(e));
      return false;
    }
  }, [id, P, showToast]);

  if (formula && P.pos) {
    return (
      <GlassFormula doc={P.pos.doc} path={scope === 'cell' ? cellPath : undefined} onBack={() => setFormula(false)}
        onApply={async (f) => {
          const ok = await run(scope === 'cell' && cellPath !== undefined
            ? [{ cmd: 'set_fill', path: cellPath, fill: { kind: 'glass', glass: f } }]
            : [{ cmd: 'set_setup', glass: f }], `Стеклопакет ${f}`);
          if (ok) setFormula(false);
        }} />
    );
  }

  const items: { value: Scope; title: string }[] = [{ value: 'order', title: 'Весь заказ' }];
  if (posId) items.push({ value: 'position', title: 'Эта позиция' }, { value: 'cell', title: 'Ячейка' });

  return (
    <Screen>
      <TopBar onBack={back} title="Комплектация" />
      <Body style={{ paddingHorizontal: 12, paddingTop: 8, gap: 10 }}>
        {items.length > 1 ? <Seg<Scope> style={{ marginHorizontal: 0 }} items={items} value={scope} onChange={setScope} /> : null}
        {scope === 'order' ? <OrderScope order={id} toast={showToast} /> : null}
        {scope !== 'order' ? (
          P.loading && !P.pos ? <Loading /> : P.error || !P.pos ? <LoadError message={P.error ?? 'Позиция не найдена'} onRetry={() => void P.reload(true)} /> : (
            <PositionScope order={id} p={P.pos} path={scope === 'cell' ? cellPath : undefined} cellScope={scope === 'cell'}
              onCommand={run} onFormula={() => setFormula(true)} />
          )
        ) : null}
      </Body>
      {toast}
    </Screen>
  );
}

// ---------------------------------------------------------------- весь заказ
function OrderScope({ order, toast }: { order: string; toast: (t: string) => void }) {
  const V = useLoad(() => api.get<Variant[]>(`/oyna/orders/${order}/variants`), [order]);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const names = useNames();
  if (V.loading && !V.data) return <Loading />;
  if (V.error && !V.data) return <LoadError message={V.error} onRetry={() => void V.reload()} />;
  const list = V.data ?? [];
  if (!list.length) return <Empty title="Комплектаций нет" text="Добавьте их в настройках цеха" />;
  const cur = list.find((v) => v.current);
  const sel = list.find((v) => v.kit === pick) ?? cur ?? list[0];

  const applyKit = async () => {
    setBusy(true);
    try {
      const o = await api.get<OrderFull>(`/oyna/orders/${order}`);
      const base_revs: Record<string, number> = {};
      for (const p of o.positions) base_revs[p.id] = p.rev;
      const out = await api.post<{ kit_name: string; positions: PositionOut[] }>(`/oyna/orders/${order}/apply-kit`, { kit_name: sel.kit, base_revs });
      for (const p of out.positions) posStore.set(order, p);
      posStore.setKitName(order, out.kit_name);
      toast(`«${out.kit_name}» — на весь заказ`);
      setPick(null);
      await V.reload();
    } catch (e) {
      toast(e instanceof ApiError && e.isConflict ? 'Позиции изменили на другом устройстве — обновите заказ' : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const sys = names?.systems.find((s) => s.code === sel.setup.system);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {list.map((v) => (
          <OptCard key={v.kit} on={v.kit === sel.kit} onPress={() => setPick(v.kit)}
            style={{ paddingVertical: 10, paddingHorizontal: 12, gap: 2, flexBasis: '31%', flexGrow: 1 }}>
            <Txt w={600} size={15} lines={1}>{v.kit}</Txt>
            <Txt size={13} color={C.muted} style={{ fontVariant: ['tabular-nums'] }}>{money(v.total)}</Txt>
            {v.demo || !v.can_quote ? (
              <View style={{ flexDirection: 'row', gap: 4, marginTop: 2 }}>
                {v.demo ? <Tag kind="est" title="ДЕМО" /> : null}
                {!v.can_quote ? <Tag kind="err" title="ошибки" /> : null}
              </View>
            ) : null}
          </OptCard>
        ))}
      </View>
      <View style={st.sheetBox}>
        <Line first label="Система" value={systemName(sys, sel.setup.system)} sub={systemSub(sys)} />
        <Line label="Цвет профиля" value={profileColorLabel(sel.setup.profile_color)} />
        <Line label="Ламинация снаружи / внутри" value={`${lamLabel(sel.setup, 'outside', names?.decors)} / ${lamLabel(sel.setup, 'inside', names?.decors).toLowerCase()}`} />
        <Line label="Стеклопакет" value={glassLabel(sel.setup.glass, names?.glass) || 'по системе'} sub={glassSub(sel.setup.glass, names?.glass)} />
        <Line label="Фурнитура" value={fittingLabel(names?.fittings.find((f) => f.code === sel.setup.fittings), sel.setup.fittings)[0] || 'по пазу системы'} />
      </View>
      {sel.per_m2 ? <Note style={{ paddingHorizontal: 8 }}>{money(sel.total)} сум · {num(sel.per_m2)} сум/м² · {num(sel.area_m2, 2)} м²</Note> : null}
      <Button title={sel.current ? 'Уже на всём заказе' : 'Применить ко всему заказу'} disabled={sel.current} loading={busy} onPress={() => void applyKit()} />
    </>
  );
}

// ---------------------------------------------------------------- позиция и ячейка
function PositionScope({ order, p, path, cellScope, onCommand, onFormula }: {
  order: string; p: PositionOut; path?: string; cellScope: boolean;
  onCommand: (c: Command[], done?: string) => Promise<boolean>; onFormula: () => void;
}) {
  const [calc, setCalc] = useState<Calc | null>(null);
  const [calcErr, setCalcErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    calcDoc(p.doc).then((c) => { if (alive) { setCalc(c); setCalcErr(null); } }).catch((e) => { if (alive) setCalcErr(errorText(e)); });
    return () => { alive = false; };
  }, [p.doc, p.rev]);
  const s = calc?.setup ?? p.doc.setup ?? {};
  const names = useNames(s.system);
  const alt = (what: string, pp?: string) =>
    router.push(`/order/${order}/alternatives?pos=${p.id}&what=${encodeURIComponent(what)}${pp !== undefined ? `&path=${pp}` : ''}`);

  if (cellScope && path === undefined) {
    return <Empty title="Ячейка не выбрана" text="Нажмите на ячейку на схеме в редакторе — здесь появятся её стекло и детали" />;
  }
  const cell = path !== undefined ? cellAt(p.doc, path) : null;
  if (cellScope && !cell) return <Empty title="Ячейки больше нет" text="Её объединили или разделили — выберите заново на схеме" />;

  const sys = names?.systems.find((x) => x.code === s.system);
  const price = (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 8, flexWrap: 'wrap' }}>
      <Txt size={14} color={C.muted}>{cellScope && path !== undefined ? `${cellTitle(p.doc, path)} · ` : ''}{p.room || 'Позиция'} · цена</Txt>
      {p.total != null ? <Txt w={700} size={17} style={{ fontVariant: ['tabular-nums'] }}>{num(p.total)} сум</Txt> : <Txt size={14} color={C.faint}>нет цены</Txt>}
      {p.demo ? <Tag kind="est" title="ДЕМО" /> : null}
      {!p.can_quote ? <Pill kind="err" title="есть ошибки" /> : null}
    </View>
  );

  if (cellScope && cell && path !== undefined) {
    const own = cell.fill?.kind === 'glass' ? cell.fill.glass : undefined;
    const open = cell.type === 'sash' || cell.type === 'door_sash';
    const geo = calc?.geometry?.cells.find((c) => c.path === path);
    const opt = (g: string) => {
      const code = cell.options?.[g] ?? s.options?.[g];
      const fit = geo?.fittings?.find((f) => (code ? f.code === code : f.code.includes(g)));
      return code ? fit?.name ?? code.split('.').pop()!.replace(/_/g, ' ') : fit ? `${fit.name} · по умолчанию` : 'по умолчанию';
    };
    return (
      <>
        {price}
        <View style={st.sheetBox}>
          <Line first label="Стеклопакет" value={own ? glassLabel(own, names?.glass) : `как у изделия · ${glassLabel(s.glass, names?.glass)}`}
            sub={glassSub(own ?? s.glass, names?.glass)} onPress={() => alt('glass', path)} />
          {cell.type !== 'panel' || cell.fill?.kind === 'glass' ? (
            <Line label="Декор стекла" value={glassDecorLabel(cell)} onPress={() => alt('glass_decor', path)} />
          ) : null}
          {own ? <Row label="Вернуть стекло изделия" onPress={() => void onCommand([{ cmd: 'set_fill', path, fill: null }], 'Стекло как у изделия')} chevron={false} /> : null}
          {open ? <Line label="Ручка" value={opt('handle')} onPress={() => alt('option:handle', path)} /> : null}
          {open ? <Line label="Петли" value={opt('hinge')} sub={geo?.weight_kg ? `створка ${num(geo.weight_kg, 1)} кг` : 'авто по весу'} onPress={() => alt('option:hinge', path)} /> : null}
          {open ? EXTRA_OPTIONS.map((o) => (
            <Line key={o.group} label={o.title} value={cell.options?.[o.group] ?? s.options?.[o.group] ? opt(o.group) : 'нет'} onPress={() => alt(`option:${o.group}`, path)} />
          )) : null}
        </View>
        <FormulaCard onPress={onFormula} />
        {calcErr ? <Note style={{ paddingHorizontal: 8 }}>{calcErr}</Note> : null}
      </>
    );
  }

  const fit = fittingLabel(names?.fittings.find((f) => f.code === s.fittings), s.fittings);
  return (
    <>
      {price}
      <View style={st.sheetBox}>
        <Line first label="Система" value={systemName(sys, s.system) || '…'} sub={systemSub(sys)} onPress={() => alt('system')} />
        <Line label="Цвет профиля" value={profileColorLabel(s.profile_color)} onPress={() => alt('profile_color')} />
        <Line label="Ламинация снаружи" value={lamLabel(s, 'outside', names?.decors)} onPress={() => alt('lam_out')} />
        <Line label="Ламинация внутри" value={lamLabel(s, 'inside', names?.decors)} onPress={() => alt('lam_in')} />
        <Line label="Стеклопакет" value={glassLabel(s.glass, names?.glass) || '…'} sub={glassSub(s.glass, names?.glass)} onPress={() => alt('glass')} />
        <Line label="Фурнитура" value={fit[0] || '…'} sub={fit[1]} onPress={() => alt('fittings')} />
      </View>
      <View style={[st.sheetBox, { paddingHorizontal: 16, paddingVertical: 12, gap: 8 }]}>
        <Txt size={14} color={C.muted}>Уплотнитель</Txt>
        <SmallChoice value={s.seal_color ?? 'black'} onChange={(v) => void onCommand([{ cmd: 'set_setup', seal_color: v }], 'Уплотнитель изменён')}
          items={[{ value: 'black', title: 'Чёрный' }, { value: 'grey', title: 'Серый' }]} />
        <Txt size={14} color={C.muted}>Штапик</Txt>
        <SmallChoice value={s.bead ?? 'square'} onChange={(v) => void onCommand([{ cmd: 'set_setup', bead: v }], 'Штапик изменён')}
          items={[{ value: 'square', title: 'Прямой' }, { value: 'round', title: 'Округлый' }, { value: 'profiled', title: 'Фигурный' }]} />
      </View>
      <FormulaCard onPress={onFormula} />
      {calcErr ? <Note style={{ paddingHorizontal: 8 }}>{calcErr}</Note> : null}
    </>
  );
}

/** Опции створки (§9.6) кроме ручки и петель — вариант выбирается листом замен. */
const EXTRA_OPTIONS = [
  { group: 'child_lock', title: 'Детский замок' }, { group: 'micro_vent', title: 'Микропроветривание' },
  { group: 'limiter', title: 'Ограничитель' }, { group: 'comb', title: 'Гребёнка' },
];

function SmallChoice({ items, value, onChange }: { items: { value: string; title: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {items.map((it) => {
        const on = it.value === value;
        return (
          <Pressable key={it.value} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => !on && onChange(it.value)}
            style={({ pressed }) => ({ height: 38, paddingHorizontal: 14, borderRadius: 19, justifyContent: 'center', backgroundColor: on ? C.dark : C.soft, opacity: pressed ? 0.8 : 1 })}>
            <Txt size={15} w={500} color={on ? '#fff' : C.ink}>{it.title}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Строка .row: подпись .rs сверху, значение .rt жирным, пояснение .rs */
function Line({ label, value, sub, right, onPress, first }: { label: string; value: string; sub?: string; right?: ReactNode; onPress?: () => void; first?: boolean }) {
  return (
    <Row first={first} onPress={onPress} chevron={!!onPress} right={right}
      label={(
        <View>
          <Txt size={14} color={C.muted}>{label}</Txt>
          <Txt w={600}>{value}</Txt>
          {sub ? <Note>{sub}</Note> : null}
        </View>
      )} />
  );
}

function FormulaCard({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [st.sheetBox, { transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingHorizontal: 20, paddingVertical: 10 }}>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="text" />
        </View>
        <View style={{ flex: 1 }}>
          <Txt w={500}>Своя формула стеклопакета</Txt>
          <Note>например 4t-12-4i</Note>
        </View>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------- GlassFormula
const PANE_WORD: [RegExp, string][] = [[/tn/, 'тонированное'], [/i/, 'энергосберегающее'], [/t/, 'закалённое'], [/m/, 'матовое']];
/** «4t-12-4i» → «закалённое 4 мм + энергосберегающее 4 мм» */
function describe(formula: string): string {
  const parts = formula.toLowerCase().split('-');
  const panes = parts.filter((_, i) => i % 2 === 0).map((p) => {
    const tri = /^(\d+(?:\.\d+)?)\.(\d+(?:\.\d+)?)\.(\d+)/.exec(p);
    if (tri) return `${p.endsWith('p4a') ? 'бронированное' : 'триплекс'} ${tri[1]}.${tri[2]}.${tri[3]}`;
    const m = /^(\d+(?:[.,]\d+)?)([a-z]*)$/.exec(p);
    if (!m) return p;
    const w = PANE_WORD.find(([re]) => re.test(m[2]));
    return `${w ? w[1] : 'обычное'} ${m[1]} мм`;
  });
  const argon = parts.some((p, i) => i % 2 === 1 && p.includes('ar'));
  const warm = parts.some((p, i) => i % 2 === 1 && (p.includes('tgi') || p.includes('warm')));
  return panes.join(' + ') + (argon ? ' · аргон' : '') + (warm ? ' · тёплая рамка' : '');
}

const HELP: { add: string; title: string }[] = [
  { add: 'i', title: 'i энергосбер.' }, { add: 't', title: 't закалённое' }, { add: 'tn', title: 'tn тонир.' },
  { add: 'm', title: 'm матовое' }, { add: 'ar', title: 'Аргон' }, { add: 'tgi', title: 'Тёплая рамка' },
  { add: '3.3.1', title: 'Триплекс 3.3.1' }, { add: '4.4.1', title: 'Триплекс 4.4.1' }, { add: 'p4a', title: 'Бронированное P4A' },
];
/** Подсказка-чип: суффикс к последнему стеклу; аргон и тёплая рамка — к рамкам; триплекс — вместо последнего стекла,
 * бронированное — триплекс 4.4.4p4a вместо первого (снаружи). */
function addHelp(f: string, add: string): string {
  const parts = f.split('-');
  if (add === '4.4.1' || add === '3.3.1') { parts[parts.length - 1] = add; return parts.join('-'); }
  if (add === 'p4a') { parts[0] = '4.4.4p4a'; return parts.join('-'); }
  if (add === 'ar') {
    for (let i = parts.length - 2; i >= 1; i -= 2) if (!parts[i].includes('ar')) { parts[i] = parts[i].replace(/^(\d+)/, '$1ar'); break; }
    return parts.join('-');
  }
  if (add === 'tgi') {
    for (let i = 1; i < parts.length; i += 2) if (!parts[i].includes('tgi') && !parts[i].includes('warm')) parts[i] += 'tgi';
    return parts.join('-');
  }
  const last = parts.length - 1;
  if (!parts[last].endsWith(add)) parts[last] += add;
  return parts.join('-');
}

function GlassFormula({ doc, path, onBack, onApply }: { doc: Doc; path?: string; onBack: () => void; onApply: (formula: string) => Promise<void> }) {
  const system = doc.setup?.system;
  const cell = path !== undefined ? cellAt(doc, path) : null;
  const start = (cell?.fill?.kind === 'glass' ? cell.fill.glass : doc.setup?.glass) ?? '';
  const [text, setText] = useState(glassLabel(start) || '4-12-4');
  const [res, setRes] = useState<GlassParse | null>(null);
  const [tried, setTried] = useState<{ f: string; err: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [netErr, setNetErr] = useState<string | null>(null);
  const [sysName, setSysName] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  useEffect(() => { refs.systems().then((l) => setSysName(systemName(l.find((x) => x.code === system), system))).catch(() => {}); }, [system]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const f = text.trim();
    if (!f) { setRes(null); return; }
    const my = ++seq.current;
    timer.current = setTimeout(() => {
      api.post<GlassParse>('/oyna/glass/parse', { formula: f, system })
        .then((r) => {
          if (my !== seq.current) return;
          setRes(r); setNetErr(null);
          const err = r.error ? `${r.error} (${r.code ?? '4.9'})` : null;
          if (err) setTried((t) => [{ f, err }, ...t.filter((x) => x.f !== f)].slice(0, 3));
        })
        .catch((e) => { if (my === seq.current) setNetErr(errorText(e)); });
    }, 350);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [text, system]);

  const ok = !!res?.ok && res.fits_system !== false && !netErr;
  const ch = res?.chambers ?? 0;
  const statusTag = res?.price_status === 'найдено' ? <Tag kind="ok" title="найдено" /> : res?.price_status ? <Tag kind="est" title={res.price_status} /> : null;
  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TopBar onBack={onBack} title="Стеклопакет" subtitle={cell && path !== undefined ? `только ${cellTitle(doc, path).toLowerCase()}` : undefined} />
        <Body style={{ paddingHorizontal: 12, paddingTop: 8, gap: 10 }}>
          <Field label="Формула · стекло-рамка-стекло" value={text} onChangeText={setText} autoFocus autoCapitalize="none" autoCorrect={false}
            inputStyle={{ fontSize: 22, fontVariant: ['tabular-nums'] }} error={!!res && !res.ok} />
          {res?.ok ? (
            <View style={[st.sheetBox, { paddingVertical: 16, paddingHorizontal: 20, gap: 6 }]}>
              <Txt w={600}>{num(res.thickness_mm ?? 0, 1)} мм · {ch ? `${ch} ${plural(ch, 'камера', 'камеры', 'камер')}` : 'одинарное'} · {num(res.weight_kg_m2 ?? 0, 1)} кг/м²</Txt>
              <Note>
                {describe(res.formula ?? text)}
                {res.fits_system === true && sysName ? ` · входит в ${sysName}` : ''}
              </Note>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                {res.price_sum_m2 != null ? (
                  <>
                    <Txt w={700} size={20} style={{ fontVariant: ['tabular-nums'] }}>{num(res.price_sum_m2)}</Txt>
                    <Txt size={14} color={C.muted}>сум/м²</Txt>
                  </>
                ) : <Txt size={14} color={C.muted}>нет цены</Txt>}
                {statusTag}
              </View>
              {res.fits_system === false && res.error ? <Txt size={14} w={500} color={C.danger}>{res.error} (4.6)</Txt> : null}
            </View>
          ) : null}
          {netErr ? <Note>{netErr}</Note> : null}
          {tried.length ? (
            <View style={st.sheetBox}>
              {tried.map((t, i) => (
                <Pressable key={t.f} onPress={() => setText(t.f)} style={[{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 20, paddingVertical: 8 },
                  i > 0 && { borderTopWidth: 1, borderTopColor: C.line }]}>
                  <Txt size={14} color={C.muted} style={{ flex: 1 }}>{t.f}</Txt>
                  <View style={{ flexShrink: 1, maxWidth: '75%' }}><Pill kind="err" title={t.err} /></View>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 8 }}>
            {HELP.map((h) => (
              <Pressable key={h.add} onPress={() => setText((t) => addHelp(t.trim() || '4-12-4', h.add))}
                style={({ pressed }) => ({ height: 36, borderRadius: 18, paddingHorizontal: 12, justifyContent: 'center', backgroundColor: C.card, opacity: pressed ? 0.7 : 1 })}>
                <Txt size={15} w={500}>{h.title}</Txt>
              </Pressable>
            ))}
          </View>
        </Body>
        <Dock>
          <Button title="Применить" disabled={!ok} loading={busy}
            onPress={async () => { setBusy(true); try { await onApply((res?.formula ?? text).trim()); } finally { setBusy(false); } }} />
        </Dock>
      </KeyboardAvoidingView>
    </Screen>
  );
}
