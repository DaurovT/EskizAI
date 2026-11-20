/**
 * Схема окна (вид изнутри, FR-E1) из дерева изделия — рисуется на телефоне, работает без сети.
 * Знак открывания по ГОСТ: вершина треугольника смотрит на петли; откидное — пунктир к низу;
 * подвесное — треугольник вершиной вверх; среднеподвесное — ромб пунктиром (shapes_contract §3).
 * Фигурная рама — полоса по контуру (outline), стекло и импосты обрезаны контуром; раскладка, декор стекла.
 * Составное изделие — рамы в ряд (развёртка), между ними стык с подписью угла; тап отдаёт путь «A<i>/…».
 * highlight — подсветка ячеек по нарушениям (FR-E6): красный — block/lock, жёлтый — warn.
 * Раздел 11: раздвижные — полотна внахлёст по направляющим, стрелка сдвига у подвижных, «Г» у глухих (тап — путь полотна «0», «1», …);
 * гильотинное окно — стрелка хода у подвижной части, знак откидывания у tilt_clean; гильотина — модули, стойки, полотна,
 * стрелки вверх, подпись привода; угол без стойки — стык без стойки «без стойки 90°».
 */
import { ReactNode, useRef } from 'react';
import { Pressable, View } from 'react-native';
import Svg, { ClipPath, Defs, G, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';

import type { Addon, Cell, Doc, Frame, Severity, Violation } from '@/api/types';
import { isDark, profileHex } from '@/lib/decors';
import { forgedDecor } from '@/lib/decorPattern';
import {
  asmFrames, asmJoints, boxPts, clipPoly, frameShape, guillotineSpec, insetPoly, isAssembly, isShaped, layout, lineSpan, outline, slidingSpec,
  type Box, type Layout, type Pt,
} from '@/lib/tree';
import { C, F } from '@/theme';

const FRAME = 64; // видимая ширина рамы в мм (паспорт ПВХ 60) — только для рисунка
const SASH = 70;
const GOLD = '#C9A44C';
const TINT: Record<string, string> = { bronze: '#CDB58E', grey: '#A7AEB3', blue: '#9CC5EA' };
const STAINED = ['#D2574A', '#3F86C6', '#EFC64A', '#4FA66B'];

export type SchemaProps = {
  doc: Doc; width: number; maxHeight?: number; dims?: boolean; view?: 'inside' | 'outside';
  selected?: string | null; onCellPress?: (path: string) => void;
  violations?: Violation[]; highlight?: Record<string, Severity>;
};

export function hlFromViolations(vs?: Violation[]): Record<string, Severity> {
  const out: Record<string, Severity> = {};
  for (const v of vs ?? []) {
    if (v.accepted || v.path === undefined || v.path === null) continue;
    const p = v.path ?? '';
    if (v.severity === 'block' || v.severity === 'lock') out[p] = 'block';
    else if (v.severity === 'warn' && out[p] !== 'block') out[p] = 'warn';
  }
  return out;
}

// ---------------------------------------------------------------- геометрия рисунка (px)
export type SchemaFrameGeo = { index: number; prefix: string; frame: Frame; x: number; y: number; w: number; h: number };
/** Сколько мм рисунка снаружи рамы: доп. профили (§9.3) и короб рольставней (§9.4). */
export type Margins = { l: number; r: number; t: number; b: number };
const SHUTTER_BOX = 180;
const addonSize = (a: Addon) => (a.type === 'extender' ? a.size_mm ?? 40 : a.type === 'base_profile' ? a.size_mm ?? 30
  : a.type === 'canopy' ? 70 : a.type === 'cover_strip' ? 40 : 20);
const sidesOf = (a: Addon): ('l' | 'r' | 't' | 'b')[] => (a.side === 'all' ? ['l', 'r', 't', 'b']
  : [({ left: 'l', right: 'r', top: 't', bottom: 'b' } as const)[a.side]]);
export function docMargins(doc: Doc): Margins {
  const m: Margins = { l: 0, r: 0, t: 0, b: 0 };
  if (isAssembly(doc)) return m;
  for (const a of doc.addons ?? []) for (const sd of sidesOf(a)) m[sd] += addonSize(a);
  if (doc.shutter) m.t += SHUTTER_BOX;
  return m;
}

export type SchemaGeo = {
  k: number; pad: number; top: number; vw: number; vh: number; gap: number; mirror: boolean; margins: Margins;
  frames: SchemaFrameGeo[];
  joints: { index: number; x: number; label: string; joint: string }[];
};

/** Масштаб и место каждой рамы на рисунке: окно — одна рама; сборка — рамы в ряд с зазором под стык. */
export function schemaGeometry(doc: Doc, width: number, maxHeight: number | undefined, dims: boolean, view: 'inside' | 'outside' = 'inside'): SchemaGeo {
  const pad = dims ? 34 : 4;
  const mirror = view === 'outside';
  const margins = docMargins(doc);
  if (!isAssembly(doc)) {
    const W = doc.frame.w || 1, H = doc.frame.h || 1;
    const TW = W + margins.l + margins.r, TH = H + margins.t + margins.b;
    let k = (width - 2 * pad) / TW;
    if (maxHeight) k = Math.min(k, (maxHeight - 2 * pad) / TH);
    k = Math.max(k, 0.001);
    const left = mirror ? margins.r : margins.l;
    return {
      k, pad, top: 0, vw: TW * k + 2 * pad, vh: TH * k + 2 * pad, gap: 0, mirror, joints: [], margins,
      frames: [{ index: 0, prefix: '', frame: doc.frame, x: pad + left * k, y: pad + margins.t * k, w: W * k, h: H * k }],
    };
  }
  const frames = asmFrames(doc), joints = asmJoints(doc);
  const n = frames.length;
  const sumW = frames.reduce((a, f) => a + f.w, 0) || 1;
  const H = frames.reduce((a, f) => Math.max(a, f.h), 0) || 1;
  const gap = width < 120 ? 3 : 14;
  const top = width >= 140 ? 18 : 0;               // полоса под подписи углов
  let k = (width - 2 * pad - gap * (n - 1)) / sumW;
  if (maxHeight) k = Math.min(k, (maxHeight - 2 * pad - top) / H);
  k = Math.max(k, 0.001);
  const order = frames.map((_, i) => i);
  if (mirror) order.reverse();
  const out: SchemaFrameGeo[] = [];
  const js: SchemaGeo['joints'] = [];
  let x = pad;
  order.forEach((i, pos) => {
    const f = frames[i];
    out.push({ index: i, prefix: `A${i}/`, frame: f, x, y: pad + top + (H - f.h) * k, w: f.w * k, h: f.h * k });
    x += f.w * k;
    if (pos < n - 1) {
      const ji = mirror ? i - 1 : i;
      const j = joints[ji] ?? { joint: 'straight', angle: 180 };
      js.push({ index: ji, x: x + gap / 2, joint: j.joint, label: jointLabel(j) });
      x += gap;
    }
  });
  return { k, pad, top, vw: x + pad, vh: H * k + 2 * pad + top, gap, mirror, frames: out, joints: js, margins };
}

/** подпись стыка над схемой сборки */
export const jointLabel = (j: { joint: string; angle: number }) => (j.joint === 'angle' ? `${j.angle}°` : j.joint === 'post' ? 'стойка'
  : j.joint === 'corner_free' ? `без стойки ${j.angle}°` : '180°');

const pathD = (pts: Pt[]) => (pts.length ? `M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L')}Z` : '');

let seq = 0;

export function Schema({ doc, width, maxHeight, dims = true, view = 'inside', selected, onCellPress, violations, highlight }: SchemaProps) {
  const uid = useRef(`s${++seq}`).current;
  const G0 = schemaGeometry(doc, width, maxHeight, dims, view);
  const { k, vw, vh } = G0;
  const hl = highlight ?? hlFromViolations(violations);
  // цвет профиля = видимый цвет стороны (ламинация, иначе цвет в массе); ручка контрастная
  const prof = profileHex(doc.setup, view);
  const knob = isDark(prof) ? '#D8D6D0' : C.ink;
  const asm = isAssembly(doc);
  const mg = G0.margins;
  const H = (asm ? G0.frames.reduce((a, f) => Math.max(a, f.frame.h), 0) : doc.frame.h) + mg.t + mg.b;
  const W = (asm ? G0.frames.reduce((a, f) => a + f.frame.w, 0) : doc.frame.w) + mg.l + mg.r;

  const taps: { path: string; x: number; y: number; w: number; h: number }[] = [];
  // FrameArt вызывается функцией (не <FrameArt/>): он заполняет taps, и это должно случиться ДО отрисовки
  // областей нажатия ниже — дочерний компонент отрендерился бы позже, и taps был бы пуст (ячейки не выбирались).
  const art = G0.frames.map((fg) => (
    <G key={fg.prefix || 'f'}>
      {FrameArt({ uid: `${uid}${fg.index}`, fg, k, mirror: G0.mirror, prof, knob, hl, selected: selected ?? null, taps, small: vw < 140 })}
    </G>
  ));

  return (
    <View style={{ width: vw, height: vh }}>
      <Svg width={vw} height={vh}>
        {!asm ? <OutsideArt doc={doc} fg={G0.frames[0]} k={k} mirror={G0.mirror} prof={prof} /> : null}
        {art}
        {!asm && doc.grille ? <GrilleArt fg={G0.frames[0]} k={k} forged={doc.grille.pattern === 'forged'} /> : null}
        {G0.joints.map((j) => {
          const f = G0.frames[0];
          const yTop = G0.pad + G0.top, yBot = f.y + f.h;
          return (
            <G key={`j${j.index}`}>
              {j.joint === 'corner_free' ? (
                // угол без стойки: стекло к стеклу — только шов, без профиля
                <Rect x={j.x - 1.5} y={yTop + 2} width={3} height={Math.max(1, yBot - yTop - 4)} fill="#DCEBF5" stroke={C.ink} strokeWidth={0.6} strokeDasharray="3 2" />
              ) : (
                <Rect x={j.x - G0.gap / 2 + 1} y={yTop + 2} width={Math.max(1, G0.gap - 2)} height={Math.max(1, yBot - yTop - 4)}
                  fill={j.joint === 'post' ? '#55524D' : '#C9C6C0'} stroke={C.ink} strokeWidth={0.6} />
              )}
              {G0.top ? <SvgText x={j.x} y={G0.pad + 12} fontSize={11} fontFamily={F.semibold} fill={C.dim} textAnchor="middle">{j.label}</SvgText> : null}
            </G>
          );
        })}
        {dims ? (
          <G>
            <Line x1={G0.pad} y1={vh - 12} x2={vw - G0.pad} y2={vh - 12} stroke={C.faint} strokeWidth={0.8} />
            <SvgText x={vw / 2} y={vh - 16} fontSize={12} fontFamily={F.semibold} fill={C.dim} textAnchor="middle">{String(W)}</SvgText>
            <Line x1={vw - 12} y1={vh - G0.pad - H * k} x2={vw - 12} y2={vh - G0.pad} stroke={C.faint} strokeWidth={0.8} />
            <SvgText x={vw - 16} y={vh - G0.pad - (H * k) / 2} fontSize={12} fontFamily={F.semibold} fill={C.dim} textAnchor="middle"
              transform={`rotate(-90 ${vw - 16} ${vh - G0.pad - (H * k) / 2})`}>{String(H)}</SvgText>
            {!asm ? <PartDims doc={doc} fg={G0.frames[0]} k={k} mirror={G0.mirror} /> : null}
          </G>
        ) : null}
      </Svg>
      {onCellPress ? taps.map((t) => (
        <Pressable key={`t${t.path}`} accessibilityRole="button" accessibilityLabel={`Ячейка ${t.path || 'целиком'}`}
          onPress={() => onCellPress(t.path)} style={{ position: 'absolute', left: t.x, top: t.y, width: t.w, height: t.h }} />
      )) : null}
    </View>
  );
}

/** Размеры частей корня сверху / слева (схема с размерами). */
function PartDims({ doc, fg, k, mirror }: { doc: Doc; fg: SchemaFrameGeo; k: number; mirror: boolean }) {
  const root = doc.frame.root;
  if (!root.parts) return null;
  const L = layout(doc);
  const X = (x: number) => fg.x + (mirror ? doc.frame.w - x : x) * k;
  const Y = (y: number) => fg.y + y * k;
  let acc = 0;
  return (
    <>
      {(L.sizes[''] ?? []).map((s, i) => {
        if (root.split !== 'h' && root.split !== 'vslide') {
          const a = X(acc), b = X(acc + s); acc += s;
          return <SvgText key={i} x={(a + b) / 2} y={14} fontSize={11} fontFamily={F.medium} fill={C.muted} textAnchor="middle">{String(Math.round(s))}</SvgText>;
        }
        const a = Y(acc), b = Y(acc + s); acc += s;
        return <SvgText key={i} x={14} y={(a + b) / 2} fontSize={11} fontFamily={F.medium} fill={C.muted} textAnchor="middle"
          transform={`rotate(-90 14 ${(a + b) / 2})`}>{String(Math.round(s))}</SvgText>;
      })}
    </>
  );
}

// ---------------------------------------------------------------- одна рама
function FrameArt({ uid, fg, k, mirror, prof, knob, hl, selected, taps, small }: {
  uid: string; fg: SchemaFrameGeo; k: number; mirror: boolean; prof: string; knob: string;
  hl: Record<string, Severity>; selected: string | null; taps: { path: string; x: number; y: number; w: number; h: number }[]; small: boolean;
}) {
  const f = fg.frame;
  const W = f.w;
  const X = (x: number) => fg.x + (mirror ? W - x : x) * k;
  const Y = (y: number) => fg.y + y * k;
  const P = (pts: Pt[]) => pathD(pts.map(([x, y]) => [X(x), Y(y)]));
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    const a = X(x0), b = X(x1);
    return { x: Math.min(a, b), y: Y(y0), width: Math.abs(b - a), height: Math.max(0, Y(y1) - Y(y0)) };
  };
  const L = layout({ kind: 'window', frame: f });
  const sel = selected;
  const ctx: ArtCtx = { fg, k, X, Y, rect, prof, knob, hl, selected: sel, taps, small, L, mirror };
  if (f.root?.sliding) return slidingArt(ctx);
  if (f.root?.guillotine) return guillotineArt(ctx);
  const shaped = isShaped(f);
  const contour = shaped ? outline(f) : null;
  const inner = contour ? insetPoly(contour, FRAME) : null;
  const sashOut = contour ? insetPoly(contour, FRAME - 8) : null;
  const glassIn = contour ? insetPoly(contour, FRAME + SASH * 0.6) : null;
  const shape = frameShape(f);
  const rise = shape.shape === 'arch' ? shape.params.rise ?? 0 : 0;

  const defs: ReactNode[] = [];
  const body: ReactNode[] = [];
  if (inner) defs.push(<ClipPath key="in" id={`${uid}in`}><Path d={P(inner)} /></ClipPath>);

  L.cells.forEach((lc, ci) => {
    const { path: sub, cell, box, sides } = lc;
    const path = fg.prefix + sub;
    const r = rect(box.x0, box.y0, box.x1, box.y1);
    taps.push({ path, x: r.x, y: r.y, w: r.width, h: r.height });
    const inset = (s: string) => (s === 'frame' ? FRAME : s === 'mullion' ? 42 : 0);
    const lx0 = box.x0 + inset(sides.l), lx1 = box.x1 - inset(sides.r), ly0 = box.y0 + inset(sides.t), ly1 = box.y1 - inset(sides.b);
    if (lx1 <= lx0 || ly1 <= ly0) return;
    const open = cell.type === 'sash' || cell.type === 'door_sash';
    const g: Box = open ? { x0: lx0 + SASH * 0.6, y0: ly0 + SASH * 0.6, x1: lx1 - SASH * 0.6, y1: ly1 - SASH * 0.6 } : { x0: lx0, y0: ly0, x1: lx1, y1: ly1 };
    if (g.x1 <= g.x0 || g.y1 <= g.y0) return;
    const sev = hl[path];
    const stroke = sev === 'block' ? C.dangerLine : sev === 'warn' ? '#F2B705' : selected === path ? C.accent : C.ink;
    const sw = sev || selected === path ? 2.6 : 0.9;
    // контуры створки и стекла: у фигурной рамы — прямоугольник ∩ контур
    const sashPoly = open ? (sashOut ? clipPoly(boxPts({ x0: lx0 - 8, y0: ly0 - 8, x1: lx1 + 8, y1: ly1 + 8 }), sashOut) : null) : null;
    const glassPoly = glassIn || inner ? clipPoly(boxPts(g), (open ? glassIn : inner)!) : null;
    if (glassPoly && glassPoly.length < 3) return;
    const gb: Box = glassPoly ? bbox(glassPoly) : g;
    const mx = (g.x0 + g.x1) / 2, my = (gb.y0 + gb.y1) / 2;
    // верх стекла над точкой x (у фигурной ячейки — по контуру)
    const topAt = (x: number) => (glassPoly ? lineSpan(glassPoly, 'v', Math.max(gb.x0 + 0.5, Math.min(gb.x1 - 0.5, x)))?.[0] ?? gb.y0 : g.y0);
    const hinge = cell.hinge ?? 'left';
    const op = cell.open ?? 'turn';
    const clipId = `${uid}c${ci}`;
    defs.push(<ClipPath key={clipId} id={clipId}>{glassPoly ? <Path d={P(glassPoly)} /> : <Rect {...rect(g.x0, g.y0, g.x1, g.y1)} />}</ClipPath>);
    const glassFill = fillColor(cell);
    const line = { stroke: C.ink, strokeWidth: 0.9 } as const;
    const dash = '5 4';
    const signs: ReactNode[] = [];
    if (open && (op === 'turn' || op === 'tilt_turn' || op === 'folding') && (hinge === 'left' || hinge === 'right')) {
      const a = hinge === 'left' ? g.x1 : g.x0, b = hinge === 'left' ? g.x0 : g.x1;
      signs.push(<Line key="t1" x1={X(a)} y1={Y(topAt(a))} x2={X(b)} y2={Y(my)} {...line} />, <Line key="t2" x1={X(a)} y1={Y(g.y1)} x2={X(b)} y2={Y(my)} {...line} />);
    }
    if (open && (op === 'tilt' || op === 'tilt_turn')) {
      const da = op === 'tilt_turn' ? dash : undefined;
      signs.push(<Line key="k1" x1={X(g.x0)} y1={Y(topAt(g.x0))} x2={X(mx)} y2={Y(g.y1)} {...line} strokeDasharray={da} />,
        <Line key="k2" x1={X(g.x1)} y1={Y(topAt(g.x1))} x2={X(mx)} y2={Y(g.y1)} {...line} strokeDasharray={da} />);
    }
    if (open && op === 'top_hung') {
      signs.push(<Line key="h1" x1={X(g.x0)} y1={Y(g.y1)} x2={X(mx)} y2={Y(topAt(mx))} {...line} />,
        <Line key="h2" x1={X(g.x1)} y1={Y(g.y1)} x2={X(mx)} y2={Y(topAt(mx))} {...line} />);
    }
    if (open && op === 'pivot') {
      const pm = (topAt(mx) + g.y1) / 2;
      signs.push(<Path key="p" d={pathD([[X(mx), Y(topAt(mx))], [X(g.x1), Y(pm)], [X(mx), Y(g.y1)], [X(g.x0), Y(pm)]])} fill="none" {...line} strokeDasharray={dash} />);
    }
    if (open && (op === 'sliding' || op === 'psk' || op === 'hs')) {
      // сдвижные: стрелка в сторону сдвига (от «петель»); PSK / HS — подпись
      const toLeft = hinge === 'right';
      const a0 = g.x0 + (g.x1 - g.x0) * 0.2, a1 = g.x1 - (g.x1 - g.x0) * 0.2;
      const [from, to] = toLeft ? [a1, a0] : [a0, a1];
      const hd = Math.min(60, (g.x1 - g.x0) * 0.1), dir = to > from ? -1 : 1;
      signs.push(<Line key="s1" x1={X(from)} y1={Y(my)} x2={X(to)} y2={Y(my)} {...line} />,
        <Path key="s2" d={`M${X(to + dir * hd)} ${Y(my - hd * 0.6)}L${X(to)} ${Y(my)}L${X(to + dir * hd)} ${Y(my + hd * 0.6)}`} fill="none" {...line} />);
      if (op !== 'sliding' && !small) signs.push(<SvgText key="s3" x={X(mx)} y={Y(my) - 6} fontSize={10} fontFamily={F.semibold} fill={C.muted} textAnchor="middle">{op === 'psk' ? 'PSK' : 'HS'}</SvgText>);
    }
    if (open && op === 'vslide') {
      // гильотинное (§11.2): подвижная часть — стрелка хода (нижняя вверх, верхняя вниз); tilt_clean — знак откидывания пунктиром
      if (cell.slide !== 'fixed') signs.push(...arrowV(X(mx), Y(gb.y0 + (gb.y1 - gb.y0) * (lc.vslide === 'top' ? 0.25 : 0.75)),
        Y(gb.y0 + (gb.y1 - gb.y0) * (lc.vslide === 'top' ? 0.75 : 0.25)), Math.min(60, (g.x1 - g.x0) * 0.1) * k, 'v'));
      if (cell.tilt_clean) {
        signs.push(<Line key="c1" x1={X(g.x0)} y1={Y(topAt(g.x0))} x2={X(mx)} y2={Y(g.y1)} {...line} strokeDasharray={dash} />,
          <Line key="c2" x1={X(g.x1)} y1={Y(topAt(g.x1))} x2={X(mx)} y2={Y(g.y1)} {...line} strokeDasharray={dash} />);
      }
    }
    const knobs: ReactNode[] = [];
    if (open && cell.handle !== false) {
      if ((op === 'turn' || op === 'tilt_turn' || op === 'folding' || op === 'psk' || op === 'hs') && (hinge === 'left' || hinge === 'right')) {
        knobs.push(<Rect key="kn" {...rect(hinge === 'left' ? g.x1 - 14 : g.x0, my - 50, hinge === 'left' ? g.x1 : g.x0 + 14, my + 50)} fill={knob} />);
      } else if (op === 'top_hung') {
        knobs.push(<Rect key="kn" {...rect(mx - 50, g.y1 - 14, mx + 50, g.y1)} fill={knob} />);
      } else if (op === 'pivot') {
        knobs.push(<Rect key="kn" {...rect(mx - 50, topAt(mx), mx + 50, topAt(mx) + 14)} fill={knob} />);
      } else if (op === 'vslide' && lc.vslide === 'bottom' && cell.slide !== 'fixed') {
        // замок на встречной планке — сверху нижнего полотна
        knobs.push(<Rect key="kn" {...rect(mx - 50, ly0 - 4, mx + 50, ly0 + 10)} fill={knob} />);
      }
    }
    const gpx = Math.abs(X(g.x1) - X(g.x0));
    body.push(
      <G key={path || 'root'}>
        {open ? (sashPoly ? <Path d={P(sashPoly)} fill={prof} stroke={C.ink} strokeWidth={1.1} />
          : <Rect {...rect(lx0 - 8, ly0 - 8, lx1 + 8, ly1 + 8)} fill={prof} stroke={C.ink} strokeWidth={1.1} />) : null}
        {glassPoly ? <Path d={P(glassPoly)} fill={glassFill} /> : <Rect {...rect(g.x0, g.y0, g.x1, g.y1)} fill={glassFill} />}
        <G clipPath={`url(#${clipId})`}>
          <GlassDecorArt cell={cell} g={gb} X={X} Y={Y} k={k} />
          <MuntinArt cell={cell} g={gb} X={X} Y={Y} k={k} prof={prof} rise={rise} frameW={W} small={small} />
          {signs}
        </G>
        {glassPoly ? <Path d={P(glassPoly)} fill="none" stroke={stroke} strokeWidth={sw} /> : <Rect {...rect(g.x0, g.y0, g.x1, g.y1)} fill="none" stroke={stroke} strokeWidth={sw} />}
        {knobs}
        {(cell.type === 'fixed' || (op === 'vslide' && cell.slide === 'fixed' && !cell.tilt_clean)) && !cell.muntins && !(cell.fill?.kind === 'glass' && cell.fill.decor) && gpx > 18 ? (
          <SvgText x={X(mx)} y={Y((gb.y0 + gb.y1) / 2) + 4} fontSize={11} fontFamily={F.medium} fill={C.faint} textAnchor="middle">Г</SvgText>
        ) : null}
        {cell.mosquito && gpx > 40 ? (
          <SvgText x={Math.min(X(g.x0), X(g.x1)) + 5} y={Y(g.y1) - 5} fontSize={9} fontFamily={F.regular} fill={C.muted}>{mosqLabel(cell.mosquito, cell)}</SvgText>
        ) : null}
        {open && cell.open_dir === 'out' && gpx > 40 ? (
          <SvgText x={X(mx)} y={Y(gb.y0) + 13} fontSize={9} fontFamily={F.medium} fill={C.accentText} textAnchor="middle">наружу</SvgText>
        ) : null}
        {cell.vent ? <Rect {...rect(mx - 150, ly0 + (open ? 10 : 4), mx + 150, ly0 + (open ? 26 : 18))} rx={2} fill="#55524D" /> : null}
        {cell.type === 'door_sash' && cell.threshold === 'low_alu' && sides.b === 'frame' ? (
          <Rect {...rect(box.x0 + FRAME, box.y1 - 22, box.x1 - FRAME, box.y1)} fill="#A9ACAE" stroke={C.ink} strokeWidth={0.6} />
        ) : null}
      </G>,
    );
  });

  const H = f.h;
  const mullions = L.mullions.map((m, i) => (m.orient === 'v'
    ? <Rect key={i} {...rect(m.at - 21, m.from + (m.from === 0 ? FRAME : 21), m.at + 21, m.to - (m.to === H ? FRAME : 21))} fill={prof} stroke={C.ink} strokeWidth={0.9} />
    : <Rect key={i} {...rect(m.from + (m.from === 0 ? FRAME : 21), m.at - 21, m.to - (m.to === W ? FRAME : 21), m.at + 21)} fill={prof} stroke={C.ink} strokeWidth={0.9} />));

  return (
    <G>
      {defs.length ? <Defs>{defs}</Defs> : null}
      {contour ? <Path d={P(contour)} fill={prof} stroke={C.ink} strokeWidth={1.6} /> : <Rect {...rect(0, 0, W, H)} fill={prof} stroke={C.ink} strokeWidth={1.6} />}
      {body}
      {inner ? <G clipPath={`url(#${uid}in)`}>{mullions}</G> : mullions}
      {inner ? <Path d={P(inner)} fill="none" stroke={C.ink} strokeWidth={0.9} /> : null}
    </G>
  );
}

// ---------------------------------------------------------------- раздвижные и гильотина (§11)
type ArtCtx = {
  fg: SchemaFrameGeo; k: number; X: (x: number) => number; Y: (y: number) => number;
  rect: (x0: number, y0: number, x1: number, y1: number) => { x: number; y: number; width: number; height: number };
  prof: string; knob: string; hl: Record<string, Severity>; selected: string | null;
  taps: { path: string; x: number; y: number; w: number; h: number }[]; small: boolean; L: Layout; mirror: boolean;
};
const GLASS = '#DCEBF5';
const line0 = { stroke: C.ink, strokeWidth: 0.9 } as const;

/** Стрелка в px: из a в b по оси (v — вертикальная, x = c; h — горизонтальная, y = c), голова hd px. */
function arrowV(c: number, a: number, b: number, hd: number, o: 'v' | 'h'): ReactNode[] {
  const h = Math.max(3, hd), dir = b > a ? -1 : 1;
  const P = (u: number, v: number) => (o === 'v' ? `${v} ${u}` : `${u} ${v}`);
  return [
    o === 'v' ? <Line key="av1" x1={c} y1={a} x2={c} y2={b} {...line0} /> : <Line key="av1" x1={a} y1={c} x2={b} y2={c} {...line0} />,
    <Path key="av2" d={`M${P(b + dir * h, c - h * 0.6)}L${P(b, c)}L${P(b + dir * h, c + h * 0.6)}`} fill="none" {...line0} />,
  ];
}
const selStroke = (path: string, hl: Record<string, Severity>, selected: string | null) => {
  const sev = hl[path];
  return {
    stroke: sev === 'block' ? C.dangerLine : sev === 'warn' ? '#F2B705' : selected === path ? C.accent : C.ink,
    strokeWidth: sev || selected === path ? 2.6 : 0.9,
  };
};

/** Раздвижная (§11.1): рама, полотна внахлёст — внутренние направляющие поверх наружных. */
function slidingArt({ fg, k, X, Y, rect, prof, knob, hl, selected, taps, small, L, mirror }: ArtCtx): ReactNode {
  const f = fg.frame, W = f.w, H = f.h;
  const sp = slidingSpec(f)!;
  const pano = sp.kind === 'panoramic';
  const FR = pano ? 48 : FRAME;
  const door = sp.kind !== 'window';
  const BOT = door && sp.threshold === 'low' ? 30 : door && sp.threshold === 'flush' ? 12 : FR;
  const LF = pano ? 46 : SASH;
  // ближняя к смотрящему направляющая — поверх: изнутри — внутренняя (больший номер), снаружи — наружная
  const leaves = [...L.cells].sort((a, b) => ((a.leaf!.rail - b.leaf!.rail) * (mirror ? -1 : 1)) || (a.leaf!.index - b.leaf!.index));
  const ov = sp.overlap;
  const body: ReactNode[] = [];
  for (const c of leaves) {
    const lf = c.leaf!;
    const path = fg.prefix + c.path.slice(c.path.lastIndexOf('/') + 1);
    const x0 = Math.max(c.box.x0, FR - 8), x1 = Math.min(c.box.x1, W - FR + 8);
    const y0 = FR - 8, y1 = Math.min(H, H - BOT + 8);
    const g: Box = { x0: x0 + LF, y0: y0 + LF, x1: x1 - LF, y1: y1 - LF };
    // тап — по своей (не перекрытой соседом) части полотна
    const t = rect(c.box.x0 + (lf.index ? ov / 2 : 0), 0, c.box.x1 - (lf.index < sp.n - 1 ? ov / 2 : 0), H);
    taps.push({ path, x: t.x, y: t.y, w: t.width, h: t.height });
    const ss = selStroke(path, hl, selected);
    const mx = (g.x0 + g.x1) / 2, my = (g.y0 + g.y1) / 2;
    const gpx = Math.abs(X(g.x1) - X(g.x0));
    const signs: ReactNode[] = [];
    if (lf.moving && g.x1 > g.x0) {
      const a = lf.dir > 0 ? g.x0 + (g.x1 - g.x0) * 0.2 : g.x1 - (g.x1 - g.x0) * 0.2;
      const b = lf.dir > 0 ? g.x1 - (g.x1 - g.x0) * 0.2 : g.x0 + (g.x1 - g.x0) * 0.2;
      signs.push(...arrowV(Y(my), X(a), X(b), Math.min(60, (g.x1 - g.x0) * 0.1) * k, 'h'));
      // ручка — на стойке против хода
      const hx = lf.dir > 0 ? x0 + LF * 0.3 : x1 - LF * 0.3 - 14;
      signs.push(<Rect key="kn" {...rect(hx, my - 60, hx + 14, my + 60)} fill={knob} />);
    }
    body.push(
      <G key={path}>
        <Rect {...rect(x0, y0, x1, y1)} fill={prof} stroke={C.ink} strokeWidth={1.1} />
        {g.x1 > g.x0 && g.y1 > g.y0 ? <Rect {...rect(g.x0, g.y0, g.x1, g.y1)} fill={GLASS} {...ss} /> : null}
        {signs}
        {!lf.moving && gpx > 18 ? <SvgText x={X(mx)} y={Y(my) + 4} fontSize={11} fontFamily={F.medium} fill={C.faint} textAnchor="middle">Г</SvgText> : null}
      </G>,
    );
  }
  return (
    <G>
      <Rect {...rect(0, 0, W, H)} fill={prof} stroke={C.ink} strokeWidth={1.6} />
      <Rect {...rect(FR, FR, W - FR, H - BOT)} fill="#C9D7E0" stroke={C.ink} strokeWidth={0.6} />
      {body}
      {door && sp.threshold !== 'standard' ? (
        <Rect {...rect(0, H - BOT, W, H)} fill="#A9ACAE" stroke={C.ink} strokeWidth={0.6} />
      ) : null}
      {door && sp.threshold === 'flush' ? (
        <Line x1={X(-60)} y1={Y(H) + 1} x2={X(W + 60)} y2={Y(H) + 1} stroke={C.muted} strokeWidth={1} strokeDasharray="4 3" />
      ) : null}
      {!small && pano ? (
        <SvgText x={X(W / 2)} y={Y(FR / 2) + 3.5} fontSize={Math.min(10, Math.max(7, FR * k * 0.8))} fontFamily={F.medium} fill={C.dim} textAnchor="middle">
          {FR * k >= 7 ? 'панорамная' : ''}
        </SvgText>
      ) : null}
    </G>
  );
}

const DRIVE_TITLE: Record<string, string> = { manual: 'привод ручной', electric: 'электропривод', remote: 'электропривод + пульт' };
/** Гильотина (§11.3): модули в ряд, стойки, в модуле полотна сверху вниз; подвижные — стрелка вверх. */
function guillotineArt({ fg, k, X, Y, rect, prof, hl, selected, small, L }: ArtCtx): ReactNode {
  const f = fg.frame, W = f.w, H = f.h;
  const g = guillotineSpec(f)!;
  const TR = 110, BR = 70, PW = 90, SIDE = 50, PF = 40;
  const mw = W / g.modules;
  const ph = (H - TR - BR) / g.panels;
  const between = g.posts === 'between';
  const xs = Array.from({ length: g.modules + 1 }, (_, m) => m * mw);
  const half = (m: number) => (m === 0 || m === g.modules ? (between ? PW : SIDE) : between ? PW / 2 : 4);
  const body: ReactNode[] = [];
  for (const c of L.cells) {
    const { module: m, panel: p, moving } = c.gpanel!;
    const path = fg.prefix + c.path.slice(c.path.lastIndexOf('/') + 1);
    const x0 = xs[m] + half(m), x1 = xs[m + 1] - half(m + 1);
    const y0 = TR + p * ph, y1 = TR + (p + 1) * ph;
    if (x1 - x0 < 2 * PF) continue;
    const gl: Box = { x0: x0 + PF, y0: y0 + PF, x1: x1 - PF, y1: y1 - PF };
    const ss = selStroke(path, hl, selected);
    const mx = (gl.x0 + gl.x1) / 2;
    body.push(
      <G key={path}>
        <Rect {...rect(x0, y0, x1, y1)} fill={prof} stroke={C.ink} strokeWidth={0.9} />
        {gl.y1 > gl.y0 ? <Rect {...rect(gl.x0, gl.y0, gl.x1, gl.y1)} fill={GLASS} {...ss} /> : null}
        {moving && gl.y1 > gl.y0 ? arrowV(X(mx), Y(gl.y0 + (gl.y1 - gl.y0) * 0.8), Y(gl.y0 + (gl.y1 - gl.y0) * 0.2), Math.min(60, (gl.y1 - gl.y0) * 0.15) * k, 'v') : null}
        {!moving && Math.abs(X(gl.x1) - X(gl.x0)) > 18 ? (
          <SvgText x={X(mx)} y={Y((gl.y0 + gl.y1) / 2) + 4} fontSize={11} fontFamily={F.medium} fill={C.faint} textAnchor="middle">Г</SvgText>
        ) : null}
      </G>,
    );
  }
  const fs = Math.min(10, TR * k * 0.7);
  return (
    <G>
      <Rect {...rect(0, 0, W, TR)} fill={prof} stroke={C.ink} strokeWidth={1.4} />
      <Rect {...rect(0, H - BR, W, H)} fill={prof} stroke={C.ink} strokeWidth={1.4} />
      {xs.map((x, m) => {
        const w = m === 0 || m === g.modules ? half(m) : between ? PW : 0;
        if (!w) return <Line key={`d${m}`} x1={X(x)} y1={Y(TR)} x2={X(x)} y2={Y(H - BR)} stroke={C.ink} strokeWidth={0.8} />;
        const a = m === 0 ? 0 : m === g.modules ? W - w : x - w / 2;
        return <Rect key={`p${m}`} {...rect(a, TR, a + w, H - BR)} fill={between ? '#8E8B85' : prof} stroke={C.ink} strokeWidth={1} />;
      })}
      {body}
      {!small && fs >= 7 ? (
        <SvgText x={X(W / 2)} y={Y(TR / 2) + fs * 0.35} fontSize={fs} fontFamily={F.medium} fill={C.dim} textAnchor="middle">{DRIVE_TITLE[g.drive]}</SvgText>
      ) : null}
    </G>
  );
}

function bbox(p: Pt[]): Box {
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Заливка стекла: матовое — светло-серое, тонированное — оттенок, зеркальное — серо-голубое; панель — серая. */
function fillColor(cell: Cell): string {
  if (cell.type === 'panel' && cell.fill?.kind !== 'glass') return '#D9D9D9';
  const f = cell.fill?.kind === 'glass' ? cell.fill : null;
  switch (f?.decor) {
    case 'matte': return '#E7E9EA';
    case 'tinted': return TINT[f.tint ?? 'bronze'] ?? TINT.bronze;
    case 'mirror': return '#AFC0CC';
    case 'stained': return '#EAF1F6';
    default: return '#DCEBF5';
  }
}

type Pen = { g: Box; X: (x: number) => number; Y: (y: number) => number; k: number };

/** Декор стекла поверх заливки: витраж — цветные ромбы, узорчатое — волны, зеркальное — блики. */
function GlassDecorArt({ cell, g, X, Y }: Pen & { cell: Cell }) {
  const f = cell.fill?.kind === 'glass' ? cell.fill : null;
  const gw = g.x1 - g.x0, gh = g.y1 - g.y0;
  if (f?.decor === 'stained') {
    const d = Math.max(60, Math.min(gw, gh) / 3);
    const out: ReactNode[] = [];
    let n = 0;
    for (let j = 0; j * d <= gh + d && n < 160; j++) {
      for (let i = 0; i * d <= gw + d && n < 160; i++) {
        for (const off of [0, 0.5]) {
          const cx = g.x0 + (i + off) * d, cy = g.y0 + (j + off) * d;
          const pts = [[cx, cy - d / 2], [cx + d / 2, cy], [cx, cy + d / 2], [cx - d / 2, cy]].map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
          out.push(<Polygon key={n++} points={pts} fill={STAINED[(i + j * 2 + (off ? 1 : 0)) % STAINED.length]} fillOpacity={0.55} stroke="#3A3530" strokeWidth={0.7} />);
        }
      }
    }
    return <>{out}</>;
  }
  if (f?.decor === 'pattern') {
    const step = Math.max(40, gh / 10);
    const out: ReactNode[] = [];
    for (let y = g.y0 + step / 2, i = 0; y < g.y1; y += step, i++) {
      const segs = Math.max(2, Math.round(gw / step));
      let d = `M${X(g.x0)} ${Y(y)}`;
      for (let s = 0; s < segs; s++) {
        const x0 = g.x0 + (gw * s) / segs, x1 = g.x0 + (gw * (s + 1)) / segs;
        d += ` Q${X((x0 + x1) / 2)} ${Y(y + (s % 2 ? step / 3 : -step / 3))} ${X(x1)} ${Y(y)}`;
      }
      out.push(<Path key={i} d={d} fill="none" stroke="#FFFFFF" strokeOpacity={0.8} strokeWidth={1} />);
    }
    return <>{out}</>;
  }
  if (f?.decor === 'mirror') {
    return (
      <>
        <Line x1={X(g.x0 + gw * 0.15)} y1={Y(g.y1)} x2={X(g.x0 + gw * 0.6)} y2={Y(g.y0)} stroke="#FFFFFF" strokeOpacity={0.7} strokeWidth={2} />
        <Line x1={X(g.x0 + gw * 0.35)} y1={Y(g.y1)} x2={X(g.x0 + gw * 0.8)} y2={Y(g.y0)} stroke="#FFFFFF" strokeOpacity={0.5} strokeWidth={1} />
      </>
    );
  }
  return null;
}

/** Раскладка (shapes_contract §2): прутки внутри стеклопакета тоньше, накладные — толще и с тенью. */
function MuntinArt({ cell, g, X, Y, k, prof, rise, frameW, small }: Pen & { cell: Cell; prof: string; rise: number; frameW: number; small: boolean }) {
  const m = cell.muntins;
  if (!m) return null;
  const color = m.color === 'gold' ? GOLD : m.color === 'decor' ? prof : '#FFFFFF';
  const overlay = m.kind === 'overlay';
  const w = Math.max(overlay ? 2.6 : 2, (m.width_mm ?? (overlay ? 26 : 18)) * k * (overlay ? 1 : 0.8));
  // окантовка заметная: белая раскладка на голубом стекле иначе не видна (особенно на солнце)
  const edge = isDark(color) ? 'rgba(255,255,255,0.6)' : 'rgba(40,36,30,0.6)';
  const segs: [number, number, number, number][] = [];
  const arcs: string[] = [];
  const gw = g.x1 - g.x0, gh = g.y1 - g.y0;
  const big = gw + gh;
  if (m.pattern === 'grid' || m.pattern === 'cross') {
    const v = m.pattern === 'cross' ? 1 : Math.max(0, m.v ?? 0), h = m.pattern === 'cross' ? 1 : Math.max(0, m.h ?? 0);
    for (let i = 1; i <= v; i++) { const x = g.x0 + (gw * i) / (v + 1); segs.push([x, g.y0, x, g.y1]); }
    for (let i = 1; i <= h; i++) { const y = g.y0 + (gh * i) / (h + 1); segs.push([g.x0, y, g.x1, y]); }
  } else if (m.pattern === 'sun') {
    // центр — середина низа дуги: по ширине рамы, по высоте — линия пят арки (или низ стекла)
    const cx = Math.max(g.x0, Math.min(g.x1, frameW / 2));
    const cy = rise > 0 ? Math.max(g.y0, Math.min(g.y1, rise)) : g.y1;
    const v = Math.max(1, m.v ?? 3), h = Math.max(0, m.h ?? 1);
    for (let i = 1; i <= v; i++) {
      const a = (Math.PI * i) / (v + 1);
      segs.push([cx, cy, cx - Math.cos(a) * big, cy - Math.sin(a) * big]);
    }
    const R = cy - g.y0;
    for (let j = 1; j <= h; j++) {
      const r = (R * j) / (h + 1.2);
      const xa = Math.min(X(cx - r), X(cx + r)), xb = Math.max(X(cx - r), X(cx + r));
      arcs.push(`M${xa} ${Y(cy)} A${r * k} ${r * k} 0 0 1 ${xb} ${Y(cy)}`);
    }
    if (cy < g.y1 - 1) segs.push([g.x0, cy, g.x1, cy]);
  } else if (m.pattern === 'decor') {
    // кованая вставка — общая форма со схемой 3D (lib/decorPattern)
    for (const line of forgedDecor(g)) arcs.push(line.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join(''));
  }
  const sw = m.pattern === 'decor' ? Math.max(small ? 0.8 : 1.2, w * 0.6) : w;
  const draw = (stroke: string, width: number, key: string) => (
    <G key={key} opacity={overlay ? 1 : 0.9}>
      {segs.map(([x1, y1, x2, y2], i) => <Line key={`l${i}`} x1={X(x1)} y1={Y(y1)} x2={X(x2)} y2={Y(y2)} stroke={stroke} strokeWidth={width} strokeLinecap="butt" />)}
      {arcs.map((d, i) => <Path key={`a${i}`} d={d} fill="none" stroke={stroke} strokeWidth={width} />)}
    </G>
  );
  return (
    <>
      {draw(edge, sw + (overlay ? 2.4 : 2), 'e')}
      {draw(color, sw, 'c')}
    </>
  );
}

const mosqLabel = (m: Cell['mosquito'], cell?: Cell) => {
  const t = m && typeof m === 'object' ? m.type : cell?.type === 'door_sash' ? 'door' : 'frame';
  return ({ frame: 'сетка', sliding: 'сетка разд.', pleated: 'плиссе', door: 'сетка-дверь', antipet: 'антикошка' } as Record<string, string>)[t] ?? 'сетка';
};

/** Снаружи рамы: доп. профили полосами по сторонам (§9.3), короб рольставней сверху (§9.4). */
function OutsideArt({ doc, fg, k, mirror, prof }: { doc: Doc; fg: SchemaFrameGeo; k: number; mirror: boolean; prof: string }) {
  const out: ReactNode[] = [];
  const acc = { l: 0, r: 0, t: 0, b: 0 };
  const x0 = fg.x, y0 = fg.y, x1 = fg.x + fg.w, y1 = fg.y + fg.h;
  const vis = (sd: 'l' | 'r' | 't' | 'b') => (mirror && sd === 'l' ? 'r' : mirror && sd === 'r' ? 'l' : sd);
  (doc.addons ?? []).forEach((a, i) => {
    const t = addonSize(a) * k;
    const fill = a.type === 'cover_strip' ? '#E9E7E2' : a.type === 'canopy' ? '#B9BCBF' : a.type === 'frame_connector' ? '#CFCCC6' : prof;
    for (const sd0 of sidesOf(a)) {
      const sd = vis(sd0);
      const o = acc[sd] * k;
      let r: { x: number; y: number; width: number; height: number };
      if (sd === 't') r = { x: x0 - acc.l * k, y: y0 - o - t, width: fg.w + (acc.l + acc.r) * k, height: t };
      else if (sd === 'b') r = { x: x0 - acc.l * k, y: y1 + o, width: fg.w + (acc.l + acc.r) * k, height: t };
      else if (sd === 'l') r = { x: x0 - o - t, y: y0 - acc.t * k, width: t, height: fg.h + (acc.t + acc.b) * k };
      else r = { x: x1 + o, y: y0 - acc.t * k, width: t, height: fg.h + (acc.t + acc.b) * k };
      if (a.type === 'canopy' && sd === 't') {
        const ext = 50 * k;
        out.push(<Path key={`a${i}${sd}`} d={`M${r.x - ext} ${r.y + r.height}L${r.x + r.width + ext} ${r.y + r.height}L${r.x + r.width} ${r.y}L${r.x} ${r.y}Z`} fill={fill} stroke={C.ink} strokeWidth={0.8} />);
      } else {
        out.push(<Rect key={`a${i}${sd}`} {...r} fill={fill} stroke={C.ink} strokeWidth={0.8} />);
      }
      acc[sd] += addonSize(a);
    }
  });
  if (doc.shutter) {
    const t = SHUTTER_BOX * k;
    const r = { x: x0 - acc.l * k, y: y0 - acc.t * k - t, width: fg.w + (acc.l + acc.r) * k, height: t };
    out.push(
      <G key="sh">
        <Rect {...r} fill="#DAD7D1" stroke={C.ink} strokeWidth={1} />
        {r.height > 12 && r.width > 80 ? (
          <SvgText x={r.x + r.width / 2} y={r.y + r.height / 2 + 4} fontSize={Math.min(11, r.height * 0.6)} fontFamily={F.medium} fill={C.dim} textAnchor="middle">
            {`${doc.shutter.type === 'roller' ? 'рольставни' : 'жалюзи'}${doc.shutter.control === 'electric' ? ' · эл.' : ''}`}
          </SvgText>
        ) : null}
      </G>,
    );
  }
  return <>{out}</>;
}

/** Решётка поверх окна (§9.4): прутья; кованая — с кольцами. */
function GrilleArt({ fg, k, forged }: { fg: SchemaFrameGeo; k: number; forged: boolean }) {
  const W = fg.frame.w, H = fg.frame.h;
  const n = Math.max(2, Math.round(W / 130));
  const sw = Math.max(1, 14 * k);
  const out: ReactNode[] = [];
  for (let i = 1; i < n; i++) {
    const x = fg.x + (fg.w * i) / n;
    out.push(<Line key={`v${i}`} x1={x} y1={fg.y} x2={x} y2={fg.y + fg.h} stroke="#2F2E2C" strokeWidth={sw} />);
  }
  for (const f of [0.08, 0.5, 0.92]) out.push(<Line key={`h${f}`} x1={fg.x} y1={fg.y + fg.h * f} x2={fg.x + fg.w} y2={fg.y + fg.h * f} stroke="#2F2E2C" strokeWidth={sw} />);
  if (forged) {
    const r = Math.min(W / n, H / 6) * 0.32 * k;
    for (let i = 1; i < n; i += 2) {
      const cx = fg.x + (fg.w * (i + 0.5)) / n;
      out.push(<Path key={`c${i}`} d={`M${cx - r} ${fg.y + fg.h * 0.29} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`} fill="none" stroke="#2F2E2C" strokeWidth={sw * 0.8} />);
      out.push(<Path key={`d${i}`} d={`M${cx - r} ${fg.y + fg.h * 0.71} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`} fill="none" stroke="#2F2E2C" strokeWidth={sw * 0.8} />);
    }
  }
  return <G opacity={0.85}>{out}</G>;
}
