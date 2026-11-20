/**
 * Добивки и работы (v3: лист «Добивки» на шаге 3 мастера и раздел «Добивки» в редакторе):
 * подоконник, отлив, откосы, москитка, демонтаж, этаж, работа снаружи + «Проём подробнее» (глубина откоса, четверть, что рядом).
 * Правки — командами ядра (set_extras, set_cell, set_meta): мастер применяет их на телефоне, редактор — шлёт на сервер.
 */
import { Pressable, StyleSheet, View } from 'react-native';

import type { Command, Doc } from '@/api/types';
import { cells } from '@/lib/tree';
import { C } from '@/theme';
import { Row, Seg, Switch, Txt } from '@/ui/kit';
import { Ban, isOpening, st } from './parts';

const SILL = [15, 25, 30, 40, 60];
const DISMANTLE = [{ value: 'none', title: 'Нет' }, { value: 'wood', title: 'Дерево' }, { value: 'pvc', title: 'ПВХ' }, { value: 'metal', title: 'Металл' }];
const DISMANTLE_OF: Record<string, string> = { wood: 'деревянного', pvc: 'пластикового', metal: 'металлического', alu: 'алюминиевого' };
const SLOPES = [100, 150, 200, 250, 300, 400];
const QUARTERS = [30, 50, 65, 80];
const NEARBY = ['Батарея', 'Кондиционер', 'Решётка', 'Розетка', 'Карниз', 'Труба'];

/** inSheet — внутри белого листа редактора (без своей карточки, кнопки серые); иначе — белая карточка на сером фоне. */
export function ExtrasPanel({ doc, run, floorDefault, inSheet, details = true }: {
  doc: Doc; run: (c: Command[]) => void; floorDefault?: number; inSheet?: boolean; details?: boolean;
}) {
  const ex = doc.extras ?? {};
  const set = (a: Record<string, unknown>) => run([{ cmd: 'set_extras', ...a }]);
  const openCells = cells(doc).filter((c) => isOpening(c.cell));
  const mosquito = openCells.some((c) => c.cell.mosquito);
  const setMosquito = (v: boolean) => {
    const target = v ? openCells.filter((c) => c.cell.type === 'sash' && c.cell.open !== 'tilt') : openCells;
    const list = target.length ? target : openCells;
    if (list.length) run(list.map((c) => ({ cmd: 'set_cell', path: c.path, mosquito: v })));
  };
  const sill = ex.sill || null;
  const dismantle = ex.dismantle || 'none';
  const floor = ex.floor ?? floorDefault ?? 1;
  const o = doc.opening ?? {};
  const nearby = o.nearby ?? [];
  const meta = (opening: Record<string, unknown>) => run([{ cmd: 'set_meta', opening }]);
  const box = inSheet ? null : st.sheet;
  const pad = inSheet ? 4 : 20;

  return (
    <View style={{ gap: 10 }}>
      <View style={box}>
        <Row first label="Подоконник" sub="глубина, см" right={<Switch value={!!sill} onChange={(v) => set({ sill: v ? { depth_cm: 30 } : false })} />} />
        {sill ? (
          <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 20, paddingBottom: 14 }}>
            {SILL.map((v) => <Chip key={v} title={String(v)} on={sill.depth_cm === v} flex onPress={() => set({ sill: { depth_cm: v } })} />)}
          </View>
        ) : null}
        <Row label="Отлив" right={<Switch value={!!ex.drip} onChange={(v) => set({ drip: v })} />} />
        <Row label="Откосы" right={<Switch value={!!ex.slopes} onChange={(v) => set({ slopes: v })} />} />
        {openCells.length ? <Row label="Москитка" sub="на открывающуюся створку" right={<Switch value={mosquito} onChange={setMosquito} />} /> : null}
        <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14, gap: 8, borderTopWidth: 1, borderTopColor: C.line }}>
          <Txt w={500}>Демонтаж</Txt>
          <Seg items={DISMANTLE} value={dismantle} onChange={(v) => set({ dismantle: v === 'none' ? false : v })} style={s.segIn} />
        </View>
        <Row label="Этаж" right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Pressable accessibilityLabel="Ниже" onPress={() => set({ floor: Math.max(1, floor - 1) })} style={st.stpBtn}><Txt size={20} w={600}>−</Txt></Pressable>
            <Txt size={17} w={600} style={{ minWidth: 28, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{String(floor)}</Txt>
            <Pressable accessibilityLabel="Выше" onPress={() => set({ floor: Math.min(60, floor + 1) })} style={st.stpBtn}><Txt size={20} w={600}>+</Txt></Pressable>
          </View>
        } />
        <Row label="Работа снаружи" sub="без балкона, с улицы" right={<Switch value={!!ex.outside} onChange={(v) => set({ outside: v })} />} />
      </View>
      {ex.dismantle && !ex.slopes ? (
        <Ban kind="est" icon="warn" title="Откосы не отмечены" body={`После демонтажа ${DISMANTLE_OF[ex.dismantle] ?? 'старого'} окна обычно нужны (9.3)`}
          action="Добавить" onAction={() => set({ slopes: true })} />
      ) : null}
      {details ? (
        <View style={[box, { paddingHorizontal: pad, paddingVertical: inSheet ? 4 : 16, gap: 10 }]}>
          <Txt size={15} w={600} color={C.muted}>Проём подробнее</Txt>
          <Txt w={500}>Глубина откоса, мм</Txt>
          <View style={s.wrap}>
            {SLOPES.map((v) => (
              <Chip key={v} title={String(v)} on={o.slope_depth_mm === v}
                onPress={() => meta({ slope_depth_mm: o.slope_depth_mm === v ? 0 : v })} />
            ))}
          </View>
          {o.quarter_mm ? (
            <>
              <Txt w={500}>Четверть, мм</Txt>
              <View style={s.wrap}>
                {QUARTERS.map((v) => <Chip key={v} title={String(v)} on={o.quarter_mm === v} onPress={() => meta({ quarter_mm: v })} />)}
              </View>
            </>
          ) : null}
          <Txt w={500}>Что рядом</Txt>
          <View style={s.wrap}>
            {NEARBY.map((v) => (
              <Chip key={v} title={v} on={nearby.includes(v)}
                onPress={() => meta({ nearby: nearby.includes(v) ? nearby.filter((x) => x !== v) : [...nearby, v] })} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** .chip внутри белого листа — серая, выбранная тёмная */
function Chip({ title, on, onPress, flex }: { title: string; on?: boolean; onPress: () => void; flex?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: !!on }} onPress={onPress}
      style={[s.chip, { backgroundColor: on ? C.dark : C.soft }, flex && { flex: 1, paddingHorizontal: 0 }]}>
      <Txt size={15} w={500} color={on ? '#fff' : C.ink}>{title}</Txt>
    </Pressable>
  );
}

const s = StyleSheet.create({
  segIn: { marginHorizontal: 0, backgroundColor: '#EDECE9' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { height: 40, borderRadius: 20, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
});
