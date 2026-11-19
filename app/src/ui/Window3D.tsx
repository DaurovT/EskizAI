/**
 * 3D-вид окна на @react-three/fiber/native + expo-gl (по образцу eskiz-temir ModelCanvas).
 * Своя орбита: один палец — вращение, щипок — зум. Смена стороны (изнутри/снаружи) — плавный поворот камеры.
 * open — створки плавно приоткрываются. frameloop="demand": кадр только при изменениях. Фон прозрачный.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber/native';
import { Component, useCallback, useEffect, useMemo, useRef, type JSX, type ReactNode } from 'react';
import { PanResponder, StyleSheet, View, type GestureResponderEvent, type ViewStyle } from 'react-native';
import { PerspectiveCamera, Vector3 } from 'three';

import type { Doc } from '@/api/types';
import { Note } from '@/ui/kit';
import { applyOpen, buildWindow, type WindowModel } from '@/ui/window3dGeometry';

type Props = {
  doc: Doc;
  colorOut: string; // hex декора снаружи
  colorIn: string; // hex декора внутри
  depthMm?: number; // монтажная глубина профиля
  side?: 'inside' | 'outside';
  open?: boolean;
  style?: ViewStyle;
};

type Orbit = { target: Vector3; theta: number; phi: number; radius: number };
type Ctx = { invalidate: () => void; size: { w: number; h: number }; onResize?: () => void };

const FOV = 35;
const THETA0 = 0.35; // лёгкий ракурс
const PHI0 = Math.PI / 2 - 0.12; // чуть выше горизонта
const PHI_MIN = 0.25;
const PHI_MAX = Math.PI - 0.25;
const PAD = 1.18; // отступ при вписывании
const OPEN_SEC = 0.7;

const baseTheta = (side: 'inside' | 'outside') => (side === 'outside' ? THETA0 + Math.PI : THETA0);

/** Внутри Canvas: орбита → камера с плавным догоном цели. */
function Rig({ cur, goal, ctx }: { cur: { current: Orbit }; goal: { current: Orbit }; ctx: { current: Ctx } }) {
  const { camera, invalidate, size } = useThree();
  useEffect(() => {
    ctx.current.invalidate = invalidate;
    const changed = ctx.current.size.w !== size.width || ctx.current.size.h !== size.height;
    ctx.current.size = { w: size.width, h: size.height };
    if (changed) ctx.current.onResize?.();
    invalidate();
  }, [invalidate, size.width, size.height, ctx]);
  useFrame((_, delta) => {
    const c = cur.current, g = goal.current;
    const k = 1 - Math.exp(-Math.min(delta, 1 / 20) * 8);
    let dT = g.theta - c.theta;
    dT = Math.atan2(Math.sin(dT), Math.cos(dT));
    c.theta += dT * k;
    c.phi += (g.phi - c.phi) * k;
    c.radius += (g.radius - c.radius) * k;
    c.target.lerp(g.target, k);
    const moving = Math.abs(dT) > 1e-4 || Math.abs(g.phi - c.phi) > 1e-4 || Math.abs(g.radius - c.radius) > g.radius * 1e-4
      || c.target.distanceTo(g.target) > g.radius * 1e-4;
    if (!moving) { c.theta = g.theta; c.phi = g.phi; c.radius = g.radius; c.target.copy(g.target); }
    const cam = camera as PerspectiveCamera;
    const sp = Math.sin(c.phi);
    cam.position.set(
      c.target.x + c.radius * sp * Math.sin(c.theta),
      c.target.y + c.radius * Math.cos(c.phi),
      c.target.z + c.radius * sp * Math.cos(c.theta),
    );
    cam.near = Math.max(0.01, c.radius / 100);
    cam.far = c.radius * 20;
    cam.updateProjectionMatrix();
    cam.lookAt(c.target);
    if (moving) invalidate();
  });
  return null;
}

/** Внутри Canvas: анимация створок (линейный ход + плавный старт/стоп). */
function Sashes({ model, open }: { model: WindowModel; open: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  const t = useRef(open ? 1 : 0);
  const ease = (x: number) => x * x * (3 - 2 * x);
  useEffect(() => { applyOpen(model, ease(t.current)); invalidate(); }, [model, invalidate]);
  useEffect(() => { invalidate(); }, [open, invalidate]);
  useFrame((_, delta) => {
    const goal = open ? 1 : 0;
    if (t.current === goal) return;
    const step = Math.min(delta, 1 / 30) / OPEN_SEC;
    t.current = goal > t.current ? Math.min(goal, t.current + step) : Math.max(goal, t.current - step);
    applyOpen(model, ease(t.current));
    invalidate();
  });
  return null;
}

class GlBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function Window3D({ doc, colorOut, colorIn, depthMm = 70, side = 'inside', open = false, style }: Props): JSX.Element {
  const ctx = useRef<Ctx>({ invalidate: () => undefined, size: { w: 1, h: 1 } });
  const cur = useRef<Orbit>({ target: new Vector3(), theta: baseTheta(side), phi: PHI0, radius: 3 });
  const goal = useRef<Orbit>({ target: new Vector3(), theta: baseTheta(side), phi: PHI0, radius: 3 });
  const limits = useRef({ min: 0.5, max: 10 });
  const invalidate = useCallback(() => ctx.current.invalidate(), []);

  // геометрия пересобирается от изделия и цветов; старая освобождается
  const model = useMemo(() => buildWindow(doc, colorOut, colorIn, depthMm), [doc, colorOut, colorIn, depthMm]);
  useEffect(() => () => model.dispose(), [model]);

  // вписать окно (прямоугольник ш×в) в кадр с отступом
  const fitRadius = useCallback(() => {
    const { w, h } = ctx.current.size;
    const aspect = w > 1 && h > 1 ? w / h : 1;
    const tanV = Math.tan((FOV * Math.PI) / 360);
    const s = model.size;
    return Math.max(s.h / 2 / tanV, s.w / 2 / (tanV * aspect)) * PAD + s.d / 2;
  }, [model]);

  const refit = useCallback((animate: boolean) => {
    const r = fitRadius();
    limits.current = { min: r * 0.35, max: r * 2.5 };
    goal.current.radius = r;
    goal.current.target.set(0, 0, 0);
    if (!animate) { cur.current.radius = r; cur.current.target.set(0, 0, 0); }
    invalidate();
  }, [fitRadius, invalidate]);

  // новое изделие — плавно перевписать (первый раз — сразу)
  const fitted = useRef(false);
  useEffect(() => { refit(fitted.current); fitted.current = true; }, [refit]);
  useEffect(() => { ctx.current.onResize = () => refit(false); return () => { ctx.current.onResize = undefined; }; }, [refit]);

  // смена стороны — плавный поворот к стандартному ракурсу с другой стороны
  const prevSide = useRef(side);
  useEffect(() => {
    if (prevSide.current === side) return;
    prevSide.current = side;
    goal.current.theta = baseTheta(side);
    goal.current.phi = PHI0;
    refit(true);
  }, [side, refit]);

  // ----- жесты: один палец — вращение, два — щипок -----
  const g = useRef({ touches: 0, dist: 0, startR: 3, lx: 0, ly: 0 });
  const responder = useMemo(() => {
    const read = (e: GestureResponderEvent) => {
      const t = e.nativeEvent.touches;
      if (t.length >= 2) return { n: t.length, dist: Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY), x: 0, y: 0 };
      return { n: Math.max(1, t.length), dist: 0, x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
    };
    const rebase = (e: GestureResponderEvent) => {
      const r = read(e);
      Object.assign(g.current, { touches: r.n, dist: r.dist, lx: r.x, ly: r.y, startR: goal.current.radius });
    };
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => rebase(e),
      onPanResponderMove: (e) => {
        const r = read(e);
        if (r.n !== g.current.touches) { rebase(e); return; }
        const o = goal.current, c = cur.current;
        if (r.n >= 2) {
          if (r.dist > 0 && g.current.dist > 0) {
            o.radius = Math.min(limits.current.max, Math.max(limits.current.min, g.current.startR * (g.current.dist / r.dist)));
            c.radius = o.radius; // жест — без сглаживания
          }
        } else {
          const dx = r.x - g.current.lx, dy = r.y - g.current.ly;
          g.current.lx = r.x; g.current.ly = r.y;
          o.theta -= dx * 0.008;
          o.phi = Math.min(PHI_MAX, Math.max(PHI_MIN, o.phi - dy * 0.008));
          c.theta = o.theta; c.phi = o.phi;
        }
        invalidate();
      },
    });
  }, [invalidate]);

  return (
    <View style={[st.wrap, style]}>
      <GlBoundary fallback={<View style={st.fallback}><Note center>3D недоступно на этом устройстве</Note></View>}>
        <View style={StyleSheet.absoluteFill} {...responder.panHandlers}>
          <Canvas
            frameloop="demand"
            camera={{ fov: FOV, near: 0.01, far: 100, position: [0, 0, 3] }}
            gl={{ antialias: true, alpha: true, premultipliedAlpha: false }}
            onCreated={(s) => {
              // expo-gl не отдаёт журнал шейдеров — проверка three.js падает на .trim()
              s.gl.debug.checkShaderErrors = false;
              s.gl.setClearColor(0x000000, 0);
              ctx.current.invalidate = () => s.invalidate();
            }}
            style={{ flex: 1 }}
          >
            <ambientLight intensity={0.8} />
            <directionalLight position={[1.2, 2.5, 3]} intensity={1.5} />
            <directionalLight position={[-1.2, 2.5, -3]} intensity={1.1} />
            <directionalLight position={[-3, 0.5, 0.5]} intensity={0.35} />
            <primitive object={model.root} />
            <Sashes model={model} open={open} />
            <Rig cur={cur} goal={goal} ctx={ctx} />
          </Canvas>
        </View>
      </GlBoundary>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, overflow: 'hidden' },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
