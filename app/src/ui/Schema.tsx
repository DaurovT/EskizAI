/**
 * Схема окна (вид изнутри, FR-E1) из дерева изделия — рисуется на телефоне, работает без сети.
 * Знак открывания по ГОСТ: вершина треугольника смотрит на петли; откидное — пунктир к низу.
 * highlight — подсветка ячеек по нарушениям (FR-E6): красный — block/lock, жёлтый — warn.
 */
import { Pressable, View } from 'react-native';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';

import type { Doc, Severity, Violation } from '@/api/types';
import { layout } from '@/lib/tree';
import { C, F } from '@/theme';

const FRAME = 64; // видимая ширина рамы в мм (паспорт ПВХ 60) — только для рисунка
const SASH = 70;

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

export function Schema({ doc, width, maxHeight, dims = true, view = 'inside', selected, onCellPress, violations, highlight }: SchemaProps) {
  const W = doc.frame.w, H = doc.frame.h;
  const pad = dims ? 34 : 4;
  let k = (width - 2 * pad) / W;
  if (maxHeight) k = Math.min(k, (maxHeight - 2 * pad) / H);
  const vw = W * k + 2 * pad, vh = H * k + 2 * pad;
  const mirror = view === 'outside';
  const X = (x: number) => pad + (mirror ? W - x : x) * k;
  const Y = (y: number) => pad + y * k;
  const L = layout(doc);
  const hl = highlight ?? hlFromViolations(violations);
  const fr = FRAME * k;

  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    const a = X(x0), b = X(x1);
    return { x: Math.min(a, b), y: Y(y0), width: Math.abs(b - a), height: Y(y1) - Y(y0) };
  };

  return (
    <View style={{ width: vw, height: vh }}>
      <Svg width={vw} height={vh}>
        <Rect {...rect(0, 0, W, H)} fill="#F7F6F3" stroke={C.ink} strokeWidth={1.6} />
        {L.cells.map(({ path, cell, box, sides }) => {
          const inset = (s: string) => (s === 'frame' ? FRAME : s === 'mullion' ? 42 : 0);
          const lx0 = box.x0 + inset(sides.l), lx1 = box.x1 - inset(sides.r), ly0 = box.y0 + inset(sides.t), ly1 = box.y1 - inset(sides.b);
          const open = cell.type === 'sash' || cell.type === 'door_sash';
          const g = open ? { x0: lx0 + SASH * 0.6, y0: ly0 + SASH * 0.6, x1: lx1 - SASH * 0.6, y1: ly1 - SASH * 0.6 } : { x0: lx0, y0: ly0, x1: lx1, y1: ly1 };
          const sev = hl[path];
          const stroke = sev === 'block' ? C.dangerLine : sev === 'warn' ? '#F2B705' : selected === path ? C.accent : C.ink;
          const sw = sev || selected === path ? 2.6 : 0.9;
          const fill = cell.type === 'panel' ? '#D9D9D9' : '#DCEBF5';
          const mx = (g.x0 + g.x1) / 2, my = (g.y0 + g.y1) / 2;
          const hinge = cell.hinge ?? 'left';
          const op = cell.open ?? 'turn';
          return (
            <G key={path || 'root'}>
              {open ? <Rect {...rect(lx0 - 8, ly0 - 8, lx1 + 8, ly1 + 8)} fill="#F7F6F3" stroke={C.ink} strokeWidth={1.1} /> : null}
              <Rect {...rect(g.x0, g.y0, g.x1, g.y1)} fill={fill} stroke={stroke} strokeWidth={sw} />
              {open && (op === 'turn' || op === 'tilt_turn') && (hinge === 'left' || hinge === 'right') ? (
                <>
                  <Line x1={X(hinge === 'left' ? g.x1 : g.x0)} y1={Y(g.y0)} x2={X(hinge === 'left' ? g.x0 : g.x1)} y2={Y(my)} stroke={C.ink} strokeWidth={0.9} />
                  <Line x1={X(hinge === 'left' ? g.x1 : g.x0)} y1={Y(g.y1)} x2={X(hinge === 'left' ? g.x0 : g.x1)} y2={Y(my)} stroke={C.ink} strokeWidth={0.9} />
                  {cell.handle !== false ? <Rect {...rect(hinge === 'left' ? g.x1 - 14 : g.x0, my - 50, hinge === 'left' ? g.x1 : g.x0 + 14, my + 50)} fill={C.ink} /> : null}
                </>
              ) : null}
              {open && (op === 'tilt' || op === 'tilt_turn') ? (
                <>
                  <Line x1={X(g.x0)} y1={Y(g.y0)} x2={X(mx)} y2={Y(g.y1)} stroke={C.ink} strokeWidth={0.9} strokeDasharray={op === 'tilt_turn' ? '5 4' : undefined} />
                  <Line x1={X(g.x1)} y1={Y(g.y0)} x2={X(mx)} y2={Y(g.y1)} stroke={C.ink} strokeWidth={0.9} strokeDasharray={op === 'tilt_turn' ? '5 4' : undefined} />
                </>
              ) : null}
              {cell.type === 'fixed' ? (
                <SvgText x={X(mx)} y={Y(my) + 4} fontSize={11} fontFamily={F.medium} fill={C.faint} textAnchor="middle">Г</SvgText>
              ) : null}
              {cell.mosquito ? (
                <SvgText x={Math.min(X(g.x0), X(g.x1)) + 5} y={Y(g.y1) - 5} fontSize={9} fontFamily={F.regular} fill={C.muted}>сетка</SvgText>
              ) : null}
            </G>
          );
        })}
        {L.mullions.map((m, i) => (m.orient === 'v'
          ? <Rect key={i} {...rect(m.at - 21, m.from + (m.from === 0 ? FRAME : 21), m.at + 21, m.to - (m.to === H ? FRAME : 21))} fill="#F7F6F3" stroke={C.ink} strokeWidth={0.9} />
          : <Rect key={i} {...rect(m.from + (m.from === 0 ? FRAME : 21), m.at - 21, m.to - (m.to === W ? FRAME : 21), m.at + 21)} fill="#F7F6F3" stroke={C.ink} strokeWidth={0.9} />))}
        {dims ? (
          <G>
            <Line x1={X(0)} y1={vh - 12} x2={X(W)} y2={vh - 12} stroke={C.faint} strokeWidth={0.8} />
            <SvgText x={vw / 2} y={vh - 16} fontSize={12} fontFamily={F.semibold} fill={C.dim} textAnchor="middle">{String(W)}</SvgText>
            <Line x1={vw - 12} y1={Y(0)} x2={vw - 12} y2={Y(H)} stroke={C.faint} strokeWidth={0.8} />
            <SvgText x={vw - 16} y={vh / 2} fontSize={12} fontFamily={F.semibold} fill={C.dim} textAnchor="middle"
              transform={`rotate(-90 ${vw - 16} ${vh / 2})`}>{String(H)}</SvgText>
            {doc.frame.root.parts && doc.frame.root.split !== 'h' ? (() => {
              let x = 0;
              return (L.sizes[''] ?? []).map((s, i) => {
                const a = X(x), b = X(x + s); x += s;
                return <SvgText key={i} x={(a + b) / 2} y={14} fontSize={11} fontFamily={F.medium} fill={C.muted} textAnchor="middle">{String(Math.round(s))}</SvgText>;
              });
            })() : null}
            {doc.frame.root.parts && doc.frame.root.split === 'h' ? (() => {
              let y = 0;
              return (L.sizes[''] ?? []).map((s, i) => {
                const a = Y(y), b = Y(y + s); y += s;
                return <SvgText key={i} x={14} y={(a + b) / 2} fontSize={11} fontFamily={F.medium} fill={C.muted} textAnchor="middle"
                  transform={`rotate(-90 14 ${(a + b) / 2})`}>{String(Math.round(s))}</SvgText>;
              });
            })() : null}
          </G>
        ) : null}
      </Svg>
      {onCellPress ? L.cells.map(({ path, box }) => {
        const r = rect(box.x0, box.y0, box.x1, box.y1);
        return (
          <Pressable key={`t${path}`} accessibilityRole="button" accessibilityLabel={`Ячейка ${path || 'целиком'}`}
            onPress={() => onCellPress(path)} style={{ position: 'absolute', left: r.x, top: r.y, width: r.width, height: r.height }} />
        );
      }) : null}
    </View>
  );
}
