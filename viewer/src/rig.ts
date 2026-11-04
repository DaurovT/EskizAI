import {
  PART_MARGINS, dimensionAnchors, partAnchors,
  type AnchorOptions, type DimensionAnchors, type PartDimensionAnchors, type PartDimensionKey,
} from './anchors.js';
import { Box3, MathUtils, Matrix4, OrthographicCamera, PerspectiveCamera, Sphere, Vector3 } from 'three';

/**
 * Камера-«штатив» без React и DOM: орбита вокруг цели, вписывание изделия в свободную область экрана
 * (между плашками интерфейса), перспектива / ортогональ с плавным переходом («долли-зум»), виды для ввода размеров.
 *
 * Главная мысль: центр проекции сдвинут (setViewOffset) в центр свободной области — поэтому изделие
 * при вращении остаётся посередине между шапкой и инструментами, а не посередине канваса.
 * Все размеры экрана — в px канваса (в RN — pt), y вниз.
 */

export type Projection = 'perspective' | 'orthographic';

/** Сколько px канваса закрыто интерфейсом с каждой стороны. */
export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type DimensionKey = 'width' | 'height' | 'depth';

/** Положение камеры: цель, углы (как Spherical: theta — азимут от +z, phi — от вертикали), охват, FOV. */
export interface ViewPose {
  target: Vector3;
  theta: number;
  phi: number;
  /** Половина высоты кадра (всего канваса) в плоскости цели, единицы сцены. */
  span: number;
  /** Вертикальный FOV, градусы. Для ортогонали — ORTHO_FOV. */
  fov: number;
}

export interface ViewRigOptions {
  /** FOV перспективы, градусы. По умолчанию 28 — без «широкоугольного» искажения. */
  fov?: number;
  /** Отступ изделия от плашек интерфейса, px. По умолчанию 28. */
  padding?: number;
  /** Длительность перекадрирования после правки, с. По умолчанию 0.3. */
  refitDuration?: number;
  /** Длительность смены вида / проекции, с. По умолчанию 0.45. */
  viewDuration?: number;
}

/** FOV, при котором перспектива почти неотличима от ортогонали (≈2 % на глубине шкафа): на нём меняем камеру. */
export const ORTHO_FOV = 4;
/** Вид по умолчанию: спереди, чуть справа (23°) и сверху (15°). */
export const DEFAULT_THETA = 0.4;
export const DEFAULT_PHI = Math.PI / 2 - (15 * Math.PI) / 180;
const MIN_PHI = 0.15;
/** Меньше этого (px) область вписывания не делаем. */
const MIN_RECT = 80;
const MAX_PHI = Math.PI * 0.95;

/** Ниже этого FOV перспектива плавно «перетекает» в ортогональ (смесь матриц проекции) — смена камеры без скачка. */
const BLEND_FOV = 10;

const UP = new Vector3(0, 1, 0);
const tmpSphere = new Sphere();
const tmpBack = new Vector3();
const tmpOrtho = new OrthographicCamera();
const tmpMat = new Matrix4();

/** Базис камеры по углам: back — от цели к камере, right, up. */
export function viewBasis(theta: number, phi: number): { back: Vector3; right: Vector3; up: Vector3 } {
  const back = new Vector3().setFromSphericalCoords(1, phi, theta);
  const right = new Vector3().crossVectors(UP, back);
  if (right.lengthSq() < 1e-10) right.set(Math.cos(theta), 0, -Math.sin(theta));
  right.normalize();
  const up = new Vector3().crossVectors(back, right).normalize();
  return { back, right, up };
}

/**
 * Углы вида на деталь (focusPart): плоскость L×W видна (|cos| к нормали ≥ 0.5), но не строго в лоб (≤ 0.88) — иначе
 * толщина «в точку». Ближайший к текущему вид; сверху/снизу — как было. `corners` — как в partAnchors.
 */
export function partViewAngles(corners: readonly Vector3[], theta: number, phi: number): { theta: number; phi: number } {
  const o = corners[0]!;
  const n = new Vector3().subVectors(corners[4]!, o);
  if (n.lengthSq() < 1e-12) return { theta, phi };
  n.normalize();
  const back = viewBasis(theta, phi).back;
  const cz = back.dot(n);
  const want = Math.min(0.88, Math.max(0.5, Math.abs(cz)));
  let v = back;
  if (Math.abs(Math.abs(cz) - want) > 1e-3) {
    // Повернуть к нормали (или от неё) в плоскости (back, n), сохранив сторону
    const perp = back.clone().addScaledVector(n, -cz);
    // смотрим строго по нормали — приподнять камеру
    if (perp.lengthSq() < 1e-8) perp.copy(viewBasis(theta, phi).up);
    perp.normalize();
    const s = cz < 0 ? -1 : 1;
    v = perp.multiplyScalar(Math.sqrt(1 - want * want)).addScaledVector(n, s * want).normalize();
  }
  const nextPhi = Math.min(MAX_PHI, Math.max(MIN_PHI, Math.acos(Math.min(1, Math.max(-1, v.y)))));
  let nextTheta = Math.atan2(v.x, v.z);
  // без лишнего оборота: ближайший к текущему азимут
  while (nextTheta - theta > Math.PI) nextTheta -= Math.PI * 2;
  while (nextTheta - theta < -Math.PI) nextTheta += Math.PI * 2;
  if (Math.abs(v.x) < 1e-9 && Math.abs(v.z) < 1e-9) nextTheta = theta;
  return { theta: nextTheta, phi: nextPhi };
}

/** Прямоугольник, куда вписываем изделие: px канваса без плашек, отступа и полей под размеры. */
export interface FitRect {
  /** Центр (сюда ставим центр проекции). */
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export function fitRect(width: number, height: number, insets: ViewInsets, padding: number, margins?: Partial<ViewInsets>): FitRect {
  // Вписываем в любую данную область; меньше MIN_RECT px — берём MIN_RECT по центру свободного места
  const axis = (size: number, a: number, b: number) => {
    const free = size - a - b;
    if (free >= MIN_RECT) return { len: free, c: a + free / 2 };
    const len = Math.min(MIN_RECT, size);
    const c = Math.min(size - len / 2, Math.max(len / 2, a + free / 2));
    return { len, c };
  };
  const x = axis(width, insets.left + padding + (margins?.left ?? 0), insets.right + padding + (margins?.right ?? 0));
  const y = axis(height, insets.top + padding + (margins?.top ?? 0), insets.bottom + padding + (margins?.bottom ?? 0));
  return { cx: x.c, cy: y.c, w: Math.max(1, x.len), h: Math.max(1, y.len) };
}

function corners(b: Box3): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    out.push(new Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
  }
  return out;
}

/**
 * Вписать точки в прямоугольник rect (px) канваса высотой `height` при данных углах и FOV.
 * Возвращает цель и охват (span) так, что проекция точек занимает rect целиком по узкой стороне
 * и стоит по центру rect (центр проекции — в центре rect). fov ≤ ORTHO_FOV — ортогональ.
 */
export function fitPose(points: Vector3[], theta: number, phi: number, fov: number, height: number, rect: FitRect): ViewPose {
  const { back, right, up } = viewBasis(theta, phi);
  const center = new Vector3();
  for (const p of points) center.add(p);
  center.divideScalar(Math.max(1, points.length));
  const target = center.clone();
  if (fov <= ORTHO_FOV + 1e-6) {
    // Ортогональ: линейно — сразу и точно
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      const x = p.x * right.x + p.y * right.y + p.z * right.z;
      const y = p.x * up.x + p.y * up.y + p.z * up.z;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const k = Math.max((x1 - x0) / rect.w, (y1 - y0) / rect.h, 1e-9); // ед. сцены на px
    const cxw = (x0 + x1) / 2 - center.dot(right);
    const cyw = (y0 + y1) / 2 - center.dot(up);
    target.addScaledVector(right, cxw).addScaledVector(up, cyw);
    return { target, theta, phi, span: (k * height) / 2, fov: ORTHO_FOV };
  }
  const tanH = Math.tan(MathUtils.degToRad(fov) / 2);
  const f = height / 2 / tanH; // фокус в px
  const rel = new Vector3();
  const project = (d: number) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      rel.subVectors(p, target);
      const z = d - rel.dot(back);
      const sx = (f * rel.dot(right)) / z;
      const sy = (f * rel.dot(up)) / z;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    return { x0, x1, y0, y1, k: Math.max((x1 - x0) / rect.w, (y1 - y0) / rect.h) };
  };
  let d = 1;
  for (let iter = 0; iter < 5; iter++) {
    let nearest = 0;
    for (const p of points) nearest = Math.max(nearest, rel.subVectors(p, target).dot(back));
    let lo = nearest + 1e-6;
    let hi = Math.max(lo * 2, 1e-3);
    while (project(hi).k > 1 && hi < 1e9) hi *= 2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (project(mid).k > 1) lo = mid;
      else hi = mid;
    }
    d = hi;
    const pr = project(d);
    const mx = (pr.x0 + pr.x1) / 2;
    const my = (pr.y0 + pr.y1) / 2;
    if (Math.abs(mx) < 0.25 && Math.abs(my) < 0.25) break;
    target.addScaledVector(right, (mx * d) / f).addScaledVector(up, (my * d) / f);
  }
  return { target, theta, phi, span: d * tanH, fov };
}

function clonePose(p: ViewPose): ViewPose {
  return { target: p.target.clone(), theta: p.theta, phi: p.phi, span: p.span, fov: p.fov };
}

/** Скорость позы (ед./с) — чтобы новая анимация продолжала движение прежней, без остановки и рывка. */
interface PoseVelocity {
  target: Vector3;
  theta: number;
  phi: number;
  span: number;
  fov: number;
}

/**
 * Анимация позы: кубический Эрмит от текущей позы с текущей скоростью `v0` к цели с нулевой скоростью.
 * При v0 = 0 — обычный smoothstep. Перенацеливание (новая правка, клавиатура, шторка) не сбрасывает скорость.
 */
interface Tween {
  from: ViewPose;
  to: ViewPose;
  v0: PoseVelocity;
  t: number;
  duration: number;
}

const zeroVelocity = (): PoseVelocity => ({ target: new Vector3(), theta: 0, phi: 0, span: 0, fov: 0 });

/** Кратчайшая разность углов b − a. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Эрмит: значение (p0 + d·s + T·v0·h10) и скорость по нормированному t. */
function hermite(t: number): { s: number; h10: number; ds: number; dh10: number } {
  const t2 = t * t;
  return { s: t2 * (3 - 2 * t), h10: t2 * t - 2 * t2 + t, ds: 6 * t * (1 - t), dh10: 3 * t2 - 4 * t + 1 };
}

/** Скорость позы анимации в момент t (ед./с). */
function tweenVelocity(tw: Tween): PoseVelocity {
  const h = hermite(tw.t);
  const T = tw.duration;
  const f = (d: number, v: number) => (d * h.ds + T * v * h.dh10) / T;
  return {
    target: new Vector3(
      f(tw.to.target.x - tw.from.target.x, tw.v0.target.x),
      f(tw.to.target.y - tw.from.target.y, tw.v0.target.y),
      f(tw.to.target.z - tw.from.target.z, tw.v0.target.z),
    ),
    theta: f(angleDelta(tw.from.theta, tw.to.theta), tw.v0.theta),
    phi: f(tw.to.phi - tw.from.phi, tw.v0.phi),
    span: f(tw.to.span - tw.from.span, tw.v0.span),
    fov: f(tw.to.fov - tw.from.fov, tw.v0.fov),
  };
}

export interface FitOptions {
  /** Анимация: true — по умолчанию (refitDuration), число — секунды, false — сразу. */
  animate?: boolean | number;
  /** Свои углы (иначе — текущие). */
  theta?: number;
  phi?: number;
}

/**
 * Камера изделия. Использование: setViewport → setInsets → setContent(bounds) → fit();
 * каждый кадр update(dt) (true — ещё движется); активная камера — `camera` (меняется при смене проекции).
 */
export class ViewRig {
  readonly perspective: PerspectiveCamera;
  readonly orthographic: OrthographicCamera;
  /** Целевая проекция (во время перехода камера может быть ещё прежней). */
  projection: Projection = 'perspective';
  readonly baseFov: number;
  padding: number;
  readonly refitDuration: number;
  readonly viewDuration: number;
  width = 1;
  height = 1;
  insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Поля вокруг изделия под размерные линии и плашки, px. */
  margins: Partial<ViewInsets> = {};
  /** Точки, которые должны влезть в кадр (углы габарита). */
  private points: Vector3[] = [];
  private bounds = new Box3();
  pose: ViewPose;
  /** Охват «по размеру» для текущего вида — пределы зума считаются от него. */
  private fittedSpan = 1;
  private tween: Tween | null = null;
  /** near/far перспективы (меняются ступенями, не каждый кадр). */
  private clip: { near: number; far: number } | null = null;
  /** Вид до focusDimension — куда вернуться по null. */
  private saved: { theta: number; phi: number; projection: Projection } | null = null;
  focused: DimensionKey | null = null;
  /** Деталь в фокусе (focusPart): 8 углов коробки детали в сцене; кадр — по ней. */
  private part: Vector3[] | null = null;
  /** Вид до focusPart — куда вернуться по null. */
  private partSaved: { theta: number; phi: number; projection: Projection } | null = null;
  /** Поля вокруг детали в фокусе под её размеры, px. */
  partMargins: Partial<ViewInsets> = PART_MARGINS;
  /** Счётчики анимаций (замеры): начато, перезапущено поверх идущей. */
  readonly stats = { starts: 0, restarts: 0 };
  /** Вызывается после каждого изменения камеры (для оверлея размеров и invalidate). */
  onChange: (() => void) | null = null;

  constructor(options: ViewRigOptions = {}) {
    this.baseFov = options.fov ?? 28;
    this.padding = options.padding ?? 28;
    this.refitDuration = options.refitDuration ?? 0.3;
    this.viewDuration = options.viewDuration ?? 0.45;
    this.perspective = new PerspectiveCamera(this.baseFov, 1, 0.01, 100);
    this.orthographic = new OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    // aspect и рамку ведёт штатив, а не R3F
    (this.perspective as PerspectiveCamera & { manual?: boolean }).manual = true;
    (this.orthographic as OrthographicCamera & { manual?: boolean }).manual = true;
    this.pose = { target: new Vector3(), theta: DEFAULT_THETA, phi: DEFAULT_PHI, span: 1, fov: this.baseFov };
  }

  /** Активная камера: ортогональная только когда переход закончился. */
  get camera(): PerspectiveCamera | OrthographicCamera {
    return this.projection === 'orthographic' && this.pose.fov <= ORTHO_FOV + 1e-6 ? this.orthographic : this.perspective;
  }

  get animating(): boolean {
    return this.tween !== null;
  }

  setViewport(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.apply();
  }

  setInsets(insets: Partial<ViewInsets>): void {
    this.insets = { top: 0, right: 0, bottom: 0, left: 0, ...insets };
  }

  /** Габарит изделия (единицы сцены) и поля под размеры (px). */
  setContent(bounds: Box3, margins?: Partial<ViewInsets>): void {
    this.bounds.copy(bounds);
    this.points = bounds.isEmpty() ? [] : corners(bounds);
    if (margins) this.margins = margins;
  }

  get contentBounds(): Box3 {
    return this.bounds;
  }

  /** Прямоугольник вписывания (px) с текущими плашками и полями (у детали в фокусе — свои поля). */
  get rect(): FitRect {
    return fitRect(this.width, this.height, this.insets, this.padding, this.part ? this.partMargins : this.margins);
  }

  /** Деталь в фокусе (focusPart) есть. */
  get partFocused(): boolean {
    return this.part !== null;
  }

  /** Точки кадра: углы детали в фокусе (мелкая — с запасом вокруг, чтобы было видно, где она) или габарита. */
  private framePoints(): Vector3[] {
    if (!this.part) return this.points;
    const box = new Box3().setFromPoints(this.part);
    const diag = box.getSize(new Vector3()).length();
    const whole = this.bounds.isEmpty() ? 0 : this.bounds.getSize(new Vector3()).length();
    const k = diag > 1e-9 && diag < whole * 0.3 ? (whole * 0.3) / diag : 1;
    if (k === 1) return this.part;
    const c = box.getCenter(new Vector3());
    return this.part.map((p) => p.clone().sub(c).multiplyScalar(k).add(c));
  }

  private fovFor(p: Projection): number {
    return p === 'orthographic' ? ORTHO_FOV : this.baseFov;
  }

  /** Поза «по размеру» для углов и проекции. */
  fitPoseFor(theta: number, phi: number, projection: Projection = this.projection): ViewPose | null {
    const pts = this.framePoints();
    if (!pts.length) return null;
    return fitPose(pts, theta, phi, this.fovFor(projection), this.height, this.rect);
  }

  private go(to: ViewPose, animate: boolean | number | undefined, fallback: number): void {
    const duration = animate === false ? 0 : typeof animate === 'number' ? animate : fallback;
    this.fittedSpan = to.span;
    if (duration <= 0) {
      this.tween = null;
      this.pose = clonePose(to);
      this.apply();
      return;
    }
    this.stats.starts++;
    // Идёт анимация — продолжаем с её скоростью (несколько поводов подряд — одно плавное движение)
    const v0 = this.tween ? tweenVelocity(this.tween) : zeroVelocity();
    if (this.tween) this.stats.restarts++;
    this.tween = { from: clonePose(this.pose), to: clonePose(to), v0, t: 0, duration };
    this.onChange?.();
  }

  /** Вписать изделие в свободную область (при открытии, после правки, при смене плашек). */
  fit(options: FitOptions = {}): void {
    const end = this.tween?.to;
    const theta = options.theta ?? end?.theta ?? this.pose.theta;
    const phi = options.phi ?? end?.phi ?? this.pose.phi;
    const to = this.fitPoseFor(theta, phi);
    if (!to) return;
    this.go(to, options.animate, this.refitDuration);
  }

  /** Перспектива или ортогональ; переход — «долли-зум» (FOV плавно к 1°, камера отъезжает). */
  setProjection(projection: Projection, animate: boolean | number = true): void {
    if (projection === this.projection && !this.tween) return;
    this.projection = projection;
    const end = this.tween?.to ?? this.pose;
    const to = this.fitPoseFor(end.theta, end.phi, projection);
    if (!to) {
      this.pose.fov = this.fovFor(projection);
      this.apply();
      return;
    }
    this.go(to, animate, this.viewDuration);
  }

  /** Плавно на заданные углы (и проекцию) с вписыванием. */
  view(theta: number, phi: number, projection: Projection = this.projection, animate: boolean | number = true): void {
    this.projection = projection;
    const to = this.fitPoseFor(theta, phi, projection);
    if (!to) {
      // Модели ещё нет — запомнить вид: первый fit() возьмёт эти углы и проекцию
      this.tween = null;
      this.pose.theta = theta;
      this.pose.phi = phi;
      this.pose.fov = this.fovFor(projection);
      this.onChange?.();
      return;
    }
    this.go(to, animate, this.viewDuration);
  }

  /**
   * Вид для ввода размера: ширина и высота — строго спереди, ортогональ; глубина — сбоку в три четверти (ортогональ).
   * null — вернуться к виду до первого focusDimension.
   */
  focusDimension(key: DimensionKey | null, animate: boolean | number = true): void {
    if (key === null) {
      this.focused = null;
      const s = this.saved;
      this.saved = null;
      if (s) this.view(s.theta, s.phi, s.projection, animate);
      else this.onChange?.();
      return;
    }
    if (!this.saved) {
      const p = this.tween?.to ?? this.pose;
      this.saved = { theta: p.theta, phi: p.phi, projection: this.projection };
    }
    this.focused = key;
    if (key === 'depth') {
      const side = Math.sin(this.saved.theta) < 0 ? -1 : 1;
      this.view(side * MathUtils.degToRad(58), Math.PI / 2 - MathUtils.degToRad(14), 'orthographic', animate);
    } else {
      this.view(0, Math.PI / 2, 'orthographic', animate);
    }
  }

  /**
   * Камера на деталь: `corners` — 8 углов её коробки (ProductScene.partBox). Вид поворачивается ровно настолько, чтобы
   * были видны длина, ширина и толщина (partViewAngles), деталь вписывается в свободную область с полями partMargins.
   * null — вернуться к виду до первого focusPart и к габариту изделия. `turn: false` — не поворачивать (только вписать).
   */
  focusPart(corners: readonly Vector3[] | null, options: { animate?: boolean | number; turn?: boolean } = {}): void {
    const animate = options.animate ?? true;
    if (!corners) {
      if (!this.part) return;
      this.part = null;
      const s = this.partSaved;
      this.partSaved = null;
      if (s) this.view(s.theta, s.phi, s.projection, animate);
      else this.fit({ animate });
      return;
    }
    const end = this.tween?.to ?? this.pose;
    if (!this.partSaved) this.partSaved = { theta: end.theta, phi: end.phi, projection: this.projection };
    this.part = corners.map((c) => c.clone());
    const a = options.turn === false ? { theta: end.theta, phi: end.phi } : partViewAngles(this.part, end.theta, end.phi);
    this.view(a.theta, a.phi, this.projection, animate);
  }

  /** Деталь в фокусе сдвинулась (дверь открывается, «взрыв») — обновить углы без перекадрирования. */
  setPartCorners(corners: readonly Vector3[]): void {
    if (!this.part) return;
    this.part = corners.map((c) => c.clone());
    this.onChange?.();
  }

  /** Вращение пальцем (радианы). Прерывает анимацию вида, но не охват. */
  orbit(dTheta: number, dPhi: number): void {
    this.settle();
    this.pose.theta += dTheta;
    this.pose.phi = Math.min(MAX_PHI, Math.max(MIN_PHI, this.pose.phi + dPhi));
    this.apply();
  }

  /** Зум щипком: k > 1 — дальше. Пределы — 0.3…3 от «по размеру». */
  zoomTo(span: number): void {
    this.settle();
    this.pose.span = Math.min(this.fittedSpan * 3, Math.max(this.fittedSpan * 0.3, span));
    this.apply();
  }

  /** Довести анимацию до конца сразу (например, палец коснулся экрана). */
  settle(): void {
    if (!this.tween) return;
    const to = this.tween.to;
    this.tween = null;
    // Угол оставляем текущим (палец продолжит отсюда), охват и цель — конечные
    this.pose = { ...clonePose(to), theta: this.pose.theta, phi: this.pose.phi };
  }

  /** Шаг анимации; true — ещё движется. */
  update(dt: number): boolean {
    const tw = this.tween;
    if (!tw) return false;
    tw.t = Math.min(1, tw.t + dt / tw.duration);
    const { s: k, h10 } = hermite(tw.t);
    const T = tw.duration * h10;
    const p = this.pose;
    const { from, to, v0 } = tw;
    p.target.lerpVectors(from.target, to.target, k).addScaledVector(v0.target, T);
    p.theta = from.theta + angleDelta(from.theta, to.theta) * k + v0.theta * T;
    p.phi = Math.min(MAX_PHI, Math.max(MIN_PHI, MathUtils.lerp(from.phi, to.phi, k) + v0.phi * T));
    p.span = Math.max(1e-6, MathUtils.lerp(from.span, to.span, k) + v0.span * T);
    p.fov = Math.max(ORTHO_FOV, MathUtils.lerp(from.fov, to.fov, k) + v0.fov * T);
    if (tw.t >= 1) {
      this.pose = clonePose(tw.to);
      this.tween = null;
    }
    this.apply();
    return true;
  }

  /** Записать позу в обе камеры (позиция, кадр, сдвиг центра проекции в центр свободной области). */
  apply(): void {
    const p = this.pose;
    const back = tmpBack.setFromSphericalCoords(1, p.phi, p.theta);
    const radius = Math.max(this.points.length ? this.bounds.getBoundingSphere(tmpSphere).radius : 1, p.span * 0.5, 1e-4);
    const rect = this.rect;
    const ox = this.width / 2 - rect.cx;
    const oy = this.height / 2 - rect.cy;
    const aspect = this.width / this.height;
    // Перспектива
    const cam = this.perspective;
    const fov = Math.max(ORTHO_FOV, p.fov);
    const d = p.span / Math.tan(MathUtils.degToRad(fov) / 2);
    cam.fov = fov;
    cam.aspect = aspect;
    // В expo-gl буфер глубины 16 бит: near/far — впритык к изделию (с запасом на комнату).
    // Меняем их редко (с запасом ×2): смена near/far каждый кадр (зум, перелёт) на iOS вешает GL-поток expo-gl
    const needNear = Math.max(d - radius * 2.5, d / 25);
    const needFar = d + radius * 6;
    if (!this.clip || needNear < this.clip.near || needFar > this.clip.far || needNear > this.clip.near * 4) {
      this.clip = { near: Math.max(needNear * 0.5, d / 25), far: needFar * 2 };
    }
    cam.near = this.clip.near;
    cam.far = this.clip.far;
    cam.position.copy(p.target).addScaledVector(back, d);
    cam.up.copy(UP);
    cam.lookAt(p.target);
    cam.setViewOffset(this.width, this.height, ox, oy, this.width, this.height);
    cam.updateProjectionMatrix();
    // Последние градусы перехода в ортогональ: проекция — смесь перспективы и ортогонали того же охвата.
    // На ORTHO_FOV она уже ровно ортогональ — смена камеры не даёт скачка (на 4° перспектива ещё ≈0,5 % «глубины»)
    if (fov < BLEND_FOV && (this.projection === 'orthographic' || this.tween?.from.fov === ORTHO_FOV)) {
      const a = MathUtils.smoothstep(BLEND_FOV - fov, 0, BLEND_FOV - ORTHO_FOV);
      const o = tmpOrtho;
      o.left = -p.span * aspect;
      o.right = p.span * aspect;
      o.top = p.span;
      o.bottom = -p.span;
      o.near = cam.near;
      o.far = cam.far;
      o.zoom = 1;
      o.setViewOffset(this.width, this.height, ox, oy, this.width, this.height);
      o.updateProjectionMatrix();
      const pe = cam.projectionMatrix.elements;
      const oe = o.projectionMatrix.elements;
      for (let i = 0; i < 16; i++) pe[i] = pe[i]! + (oe[i]! - pe[i]!) * a;
      cam.projectionMatrixInverse.copy(tmpMat.copy(cam.projectionMatrix)).invert();
    }
    cam.updateMatrixWorld();
    // Ортогональ: тот же охват
    const o = this.orthographic;
    // near/far ортогонали — только от габарита (не от зума), чтобы не менялись каждый кадр
    const or = Math.max(this.points.length ? tmpSphere.radius : 1, 1e-4);
    const od = or * 4;
    o.left = -p.span * aspect;
    o.right = p.span * aspect;
    o.top = p.span;
    o.bottom = -p.span;
    o.near = Math.max(1e-4, od - or * 2.5);
    o.far = od + or * 6;
    o.zoom = 1;
    o.position.copy(p.target).addScaledVector(back, od);
    o.up.copy(UP);
    o.lookAt(p.target);
    o.setViewOffset(this.width, this.height, ox, oy, this.width, this.height);
    o.updateProjectionMatrix();
    o.updateMatrixWorld();
    this.onChange?.();
  }

  /** Экранные точки размеров (px) по габариту из setContent и текущей камере; null — габарита нет. */
  anchors(opts?: AnchorOptions): DimensionAnchors | null {
    if (!this.points.length) return null;
    const p = this.pose;
    const a = dimensionAnchors(this.bounds, (v) => this.project(v, v), viewBasis(p.theta, p.phi).back, opts);
    // Вводимый размер показываем, даже если он на экране короткий (маленькая свободная область)
    const f = this.focused ? a[this.focused] : null;
    if (f && !f.visible && f.length >= 4 && Number.isFinite(f.a[0])) f.visible = true;
    return a;
  }

  /** Экранные точки размеров детали в фокусе (длина, ширина, толщина по её осям); null — фокуса нет. */
  partAnchors(opts?: AnchorOptions<PartDimensionKey>): PartDimensionAnchors | null {
    if (!this.part) return null;
    return partAnchors(this.part, (v) => this.project(v, v), opts);
  }

  /** Точка сцены → px канваса (y вниз) по активной камере; z > 1 — за камерой. */
  project(p: Vector3, out: Vector3 = new Vector3()): Vector3 {
    out.copy(p).project(this.camera);
    return out.set(((out.x + 1) / 2) * this.width, ((1 - out.y) / 2) * this.height, out.z);
  }
}
