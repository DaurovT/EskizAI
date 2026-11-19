/**
 * Лист «Замена тянет другие» — макет SwapConfirm (docs/design).
 * Отдельного предпросмотра на сервере нет — считаем честно: расчёт позиции до, после смены системы
 * (set_setup сбрасывает набор фурнитуры — подберётся по пазу) и, если стеклопакет не входит в штапик (4.6), —
 * после замены стекла на ближайший подходящий пресет. Разница — по расчёту сервера (POST /oyna/positions/calc).
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { errorText } from '@/api/http';
import type { Calc, Command, Doc } from '@/api/types';
import { apply } from '@/lib/tree';
import { C } from '@/theme';
import { Button, LoadError, Loading, Note, Txt } from '@/ui/kit';
import { altCommand } from './Alternatives';
import {
  calcDoc, ConflictError, delta, FittingSet, fittingLabel, glassLabel, GlassPreset, refs, RouteSheet, sendCommands, Soft,
  systemName, usePosition, WHAT_TITLE,
} from './parts';

type Line = { title: string; sub?: string; delta?: number | null; bold?: boolean; danger?: boolean };
type Plan = { title: string; cap: string; lines: Line[]; commands: Command[]; newBlocks: string[]; cta: string };

const total = (c: Calc) => c.price?.total ?? null;
const diff = (a: number | null, b: number | null) => (a != null && b != null ? b - a : null);
const blocks = (c: Calc) => c.violations.filter((v) => (v.severity === 'block' || v.severity === 'lock') && !v.accepted);

async function planSystem(doc: Doc, value: string): Promise<Plan> {
  const [systems, before] = await Promise.all([refs.systems(), calcDoc(doc)]);
  const sOld = systems.find((x) => x.code === before.setup.system);
  const sNew = systems.find((x) => x.code === value);
  const nameOld = systemName(sOld, before.setup.system), nameNew = systemName(sNew, value);
  const cmds: Command[] = [{ cmd: 'set_setup', system: value }];
  const d1 = apply(doc, cmds);
  const after1 = await calcDoc(d1);
  const lines: Line[] = [];
  let finalCalc = after1;

  // стекло не входит в штапик новой системы (4.6) — ближайший подходящий пресет той же камерности
  const bad46 = after1.violations.filter((v) => v.code === '4.6');
  let glassNote = '';
  if (bad46.length) {
    const presets: GlassPreset[] = await refs.glass(value);
    const fits = presets.filter((g) => g.fits_system);
    const oldGlass = before.setup.glass;
    const oldThick = before.geometry?.cells.find((c) => c.glass_thickness_mm)?.glass_thickness_mm
      ?? presets.find((g) => g.code === oldGlass)?.thickness_mm ?? 24;
    const lowE = /i/.test(glassLabel(oldGlass, presets));
    const pick = [...fits].sort((a, b) => {
      const la = /i/.test(a.formula.split(' ')[0]) === lowE ? 0 : 1, lb = /i/.test(b.formula.split(' ')[0]) === lowE ? 0 : 1;
      return la - lb || Math.abs(a.thickness_mm - oldThick) - Math.abs(b.thickness_mm - oldThick);
    })[0];
    if (pick) {
      const glassCmds: Command[] = [];
      if (bad46.some((v) => v.path === undefined || !hasOwnFill(d1, v.path))) {
        glassCmds.push({ cmd: 'set_setup', glass: pick.code });
      }
      for (const v of bad46) if (v.path !== undefined && hasOwnFill(d1, v.path)) glassCmds.push({ cmd: 'set_fill', path: v.path, fill: { kind: 'glass', glass: pick.code } });
      const d2 = apply(d1, glassCmds);
      const after2 = await calcDoc(d2);
      lines.push({ title: 'Профиль, армирование, штапик', sub: `пересоберём под ${sNew?.series ?? nameNew}`, delta: diff(total(before), total(after1)) });
      lines.unshift({
        title: `Стеклопакет ${glassLabel(oldGlass, presets)} → ${glassLabel(pick.code, presets)}`,
        sub: `${oldThick} мм не входит (4.6)`, delta: diff(total(after1), total(after2)),
      });
      const beads = (sNew?.glass_range_mm ?? []).map((r) => r[1]);
      glassNote = beads.length ? ` Штапик ${sNew?.series ?? nameNew} — до ${Math.max(...beads)} мм, заменим автоматически:` : ' Стекло заменим автоматически:';
      cmds.push(...glassCmds);
      finalCalc = after2;
    } else {
      lines.push({ title: 'Стеклопакет не входит в систему', sub: 'подходящего пресета нет — выберите стекло вручную (4.6)', danger: true });
    }
  }
  if (!lines.some((l) => l.title.startsWith('Профиль'))) {
    lines.push({ title: 'Профиль, армирование, штапик', sub: `пересоберём под ${sNew?.series ?? nameNew}`, delta: diff(total(before), total(after1)) });
  }
  if (before.setup.fittings !== finalCalc.setup.fittings) {
    const fits: FittingSet[] = await refs.fittings().catch(() => []);
    const fo = fittingLabel(fits.find((f) => f.code === before.setup.fittings), before.setup.fittings)[0];
    const fn = fittingLabel(fits.find((f) => f.code === finalCalc.setup.fittings), finalCalc.setup.fittings)[0];
    lines.push({ title: `Фурнитура ${fo} → ${fn}`, sub: 'подберём по пазу системы (7.2)' });
  }
  lines.push({ title: 'Итого по заказу', delta: diff(total(before), total(finalCalc)), bold: true });
  const was = new Set(blocks(before).map((v) => `${v.code}:${v.path ?? ''}`));
  const newBlocks = blocks(finalCalc).filter((v) => !was.has(`${v.code}:${v.path ?? ''}`)).map((v) => `${v.code} · ${v.title}${v.msg ? ` — ${v.msg}` : ''}`);
  return {
    title: `Сменить на ${nameNew}?`, cap: `Сейчас ${nameOld}.${glassNote || ' Что изменится:'}`, lines, commands: cmds, newBlocks, cta: 'Сменить систему',
  };
}

const hasOwnFill = (doc: Doc, path: string) => findFill(doc, path) !== null;
function findFill(doc: Doc, path: string) {
  let n = doc.frame.root;
  for (const i of path.split('.').filter((x) => x !== '')) {
    const p = n.parts?.[Number(i)];
    if (!p) return null;
    n = p.cell ? { cell: p.cell } : (p.node ?? {});
  }
  return n.cell?.fill?.kind === 'glass' ? n.cell.fill : null;
}

/** Любая другая замена — до/после по расчёту. */
async function planGeneric(doc: Doc, what: string, value: string, path?: string): Promise<Plan> {
  const cmd = altCommand(what, value, path, doc);
  const [before, after] = await Promise.all([calcDoc(doc), calcDoc(apply(doc, [cmd]))]);
  const was = new Set(blocks(before).map((v) => `${v.code}:${v.path ?? ''}`));
  return {
    title: `${WHAT_TITLE[what] ?? 'Замена'}: заменить?`, cap: 'Что изменится:', commands: [cmd],
    lines: [{ title: 'Итого по заказу', delta: diff(total(before), total(after)), bold: true }],
    newBlocks: blocks(after).filter((v) => !was.has(`${v.code}:${v.path ?? ''}`)).map((v) => `${v.code} · ${v.title}`), cta: 'Заменить',
  };
}

export default function Swap() {
  const { id, pos, what: w, value: val, path: pth } = useLocalSearchParams<{ id: string; pos?: string; what?: string; value?: string; path?: string }>();
  const what = typeof w === 'string' && w ? w : 'system';
  const value = typeof val === 'string' ? val : '';
  const path = typeof pth === 'string' ? pth : undefined;
  const P = usePosition(id, pos);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doc = P.pos?.doc;
  useEffect(() => {
    if (!doc || !value) return;
    let alive = true;
    setErr(null);
    (what === 'system' ? planSystem(doc, value) : planGeneric(doc, what, value, path))
      .then((p) => { if (alive) setPlan(p); })
      .catch((e) => { if (alive) setErr(e instanceof Error && !(e as { status?: number }).status ? e.message : errorText(e)); });
    return () => { alive = false; };
  }, [doc, what, value, path]);

  const confirm = async () => {
    if (!P.pos || !plan) return;
    setBusy(true);
    try {
      const out = await sendCommands(id, P.pos, plan.commands);
      P.update(out);
      router.back();
    } catch (e) {
      if (!(e instanceof ConflictError)) setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!value) return <RouteSheet><LoadError message="Не выбрано, на что менять" /></RouteSheet>;
  if (P.error && !P.pos) return <RouteSheet><LoadError message={P.error} onRetry={() => void P.reload(true)} /></RouteSheet>;
  if (!plan) return <RouteSheet>{err ? <LoadError message={err} /> : <Loading />}</RouteSheet>;

  return (
    <RouteSheet footer={(
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Soft title="Отмена" onPress={() => router.back()} style={{ flex: 1 }} />
        <Button title={plan.cta} onPress={() => void confirm()} loading={busy} style={{ flex: 1 }} />
      </View>
    )}>
      <Txt w={700} size={20} style={{ paddingHorizontal: 8, lineHeight: 26 }}>{plan.title}</Txt>
      <Txt size={14} color={C.muted} style={{ paddingHorizontal: 8, paddingBottom: 6 }}>{plan.cap}</Txt>
      <View style={{ backgroundColor: C.soft, borderRadius: 28, overflow: 'hidden' }}>
        {plan.lines.map((l, i) => (
          <View key={i} style={[{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 20, paddingVertical: 8 },
            i > 0 && { borderTopWidth: 1, borderTopColor: '#E6E5E1' }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Txt w={l.bold ? 700 : 500} color={l.danger ? C.danger : C.ink}>{l.title}</Txt>
              {l.sub ? <Note>{l.sub}</Note> : null}
            </View>
            {l.delta !== undefined ? (
              <Txt w={600} style={{ fontVariant: ['tabular-nums'] }}>{l.delta == null ? 'нет цены' : delta(l.delta)}</Txt>
            ) : null}
          </View>
        ))}
      </View>
      {plan.newBlocks.length ? (
        <View style={{ backgroundColor: C.errBg, borderRadius: 20, padding: 14, gap: 4 }}>
          <Txt w={600} color={C.errFg}>После замены появятся ошибки</Txt>
          {plan.newBlocks.map((b) => <Txt key={b} size={14} color={C.errFg}>{b}</Txt>)}
        </View>
      ) : null}
      {err ? <Note style={{ paddingHorizontal: 8, color: C.danger }}>{err}</Note> : null}
    </RouteSheet>
  );
}

