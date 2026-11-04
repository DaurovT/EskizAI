import { readFileSync } from 'node:fs';
import { Box3, PerspectiveCamera, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { contactShadowGeometry } from '../src/ao.js';
import { createWoodGrainTexture, GRAIN_TILE_MM } from '../src/materials.js';
import { ProductScene } from '../src/product.js';
import { ORTHO_FOV, ViewRig } from '../src/rig.js';
import type { ViewerModel } from '../src/types.js';

const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8')) as ViewerModel;

/** Пределы проекции углов габарита, px. */
function extent(rig: ViewRig, b: Box3) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = rig.project(new Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  return { x0, x1, y0, y1 };
}

describe('штатив камеры', () => {
  // Пенал 820 × 1800 × 450 мм, экран 390 × 600, сверху 120 px шапки, снизу 160 px инструментов
  const b = new Box3(new Vector3(0, 0, -0.45), new Vector3(0.82, 1.8, 0));
  const setup = () => {
    const rig = new ViewRig({ padding: 28 });
    rig.setViewport(390, 600);
    rig.setInsets({ top: 120, bottom: 160 });
    rig.setContent(b);
    return rig;
  };

  it('вписывает изделие в свободную область с отступом (перспектива)', () => {
    const rig = setup();
    rig.fit({ animate: false });
    const e = extent(rig, b);
    expect(e.y0).toBeGreaterThanOrEqual(120 + 28 - 0.5);
    expect(e.y1).toBeLessThanOrEqual(600 - 160 - 28 + 0.5);
    expect(e.x0).toBeGreaterThanOrEqual(28 - 0.5);
    expect(e.x1).toBeLessThanOrEqual(390 - 28 + 0.5);
    // Узкая сторона заполнена (высокий пенал — по высоте), по центру свободной области
    expect(e.y1 - e.y0).toBeGreaterThan(600 - 280 - 56 - 2);
    expect(Math.abs((e.y0 + e.y1) / 2 - (120 + (600 - 160 - 120) / 2))).toBeLessThan(1);
    expect(rig.camera.type).toBe('PerspectiveCamera');
    expect((rig.camera as { fov: number }).fov).toBe(28);
  });

  it('ортогональ после перехода, тот же кадр; focusDimension и возврат', () => {
    const rig = setup();
    rig.fit({ animate: false });
    rig.focusDimension('height');
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
    expect(rig.camera.type).toBe('OrthographicCamera');
    expect(rig.pose.fov).toBe(ORTHO_FOV);
    expect(rig.pose.theta).toBeCloseTo(0);
    const e = extent(rig, b);
    expect(e.y0).toBeGreaterThanOrEqual(148 - 0.5);
    expect(e.y1).toBeLessThanOrEqual(412 + 0.5);
    // Спереди в ортогонали ширина и высота — прямоугольник с пропорцией 820 : 1800
    expect((e.x1 - e.x0) / (e.y1 - e.y0)).toBeCloseTo(0.82 / 1.8, 2);
    const a = rig.anchors()!;
    expect(a.width.visible).toBe(true);
    expect(a.depth.visible).toBe(false); // глубина спереди — в точку
    expect(a.width.a[1]).toBeLessThan(e.y0); // линия ширины над изделием
    expect(a.height.a[0]).toBeGreaterThan(e.x1); // высота справа
    rig.focusDimension('depth');
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
    expect(rig.anchors()!.depth.visible).toBe(true);
    rig.focusDimension(null);
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
    expect(rig.camera.type).toBe('PerspectiveCamera');
    expect(rig.pose.theta).toBeCloseTo(0.4);
  });

  it('маленькая свободная область (80 px) — изделие всё равно в ней; фокус до загрузки модели', () => {
    const rig = new ViewRig({ padding: 10 });
    rig.setViewport(390, 844);
    rig.setInsets({ top: 300, bottom: 444 }); // свободно 100 px, после отступов — 80
    rig.setContent(b);
    rig.fit({ animate: false });
    const e = extent(rig, b);
    expect(e.y0).toBeGreaterThanOrEqual(310 - 0.5);
    expect(e.y1).toBeLessThanOrEqual(390 + 0.5);
    const late = new ViewRig();
    late.setViewport(390, 600);
    late.focusDimension('depth'); // модели ещё нет
    late.setContent(b);
    late.fit({ animate: false });
    expect(late.camera.type).toBe('OrthographicCamera');
    expect(Math.abs(late.pose.theta)).toBeGreaterThan(0.9);
    expect(late.anchors()!.depth.visible).toBe(true);
  });

  it('перекадрирование после правки — плавно', () => {
    const rig = setup();
    rig.fit({ animate: false });
    const span0 = rig.pose.span;
    rig.setContent(new Box3(new Vector3(0, 0, -0.45), new Vector3(2.4, 2.4, 0)));
    rig.fit();
    expect(rig.update(0.1)).toBe(true);
    expect(rig.pose.span).toBeGreaterThan(span0);
    for (let i = 0; i < 30; i++) rig.update(1 / 60);
    expect(rig.animating).toBe(false);
  });

  it('новый повод посреди анимации — движение продолжается с той же скоростью, без остановки и скачка', () => {
    const rig = setup();
    rig.fit({ animate: false });
    rig.setContent(new Box3(new Vector3(0, 0, -0.45), new Vector3(2.4, 2.4, 0)));
    rig.fit();
    const dt = 1 / 60;
    let prev = rig.pose.span;
    for (let i = 0; i < 6; i++) { prev = rig.pose.span; rig.update(dt); }
    const vBefore = (rig.pose.span - prev) / dt;
    expect(vBefore).toBeGreaterThan(0);
    // ещё правка (шире) — та же скорость в первом кадре новой анимации
    const at = rig.pose.span;
    rig.setContent(new Box3(new Vector3(0, 0, -0.45), new Vector3(3, 2.4, 0)));
    rig.fit();
    expect(rig.pose.span).toBe(at); // без скачка позы
    rig.update(dt);
    const vAfter = (rig.pose.span - at) / dt;
    expect(Math.abs(vAfter - vBefore) / vBefore).toBeLessThan(0.15);
    expect(rig.stats.restarts).toBe(1);
    for (let i = 0; i < 60; i++) rig.update(dt);
    expect(rig.animating).toBe(false);
    expect(rig.pose.span).toBeCloseTo(rig.fitPoseFor(rig.pose.theta, rig.pose.phi)!.span, 6);
  });

  it('несколько поводов в одном кадре (шторка, клавиатура, размер) — одно движение с места к последней цели', () => {
    const rig = setup();
    rig.fit({ animate: false });
    const span0 = rig.pose.span;
    rig.setInsets({ top: 80, bottom: 300 });
    rig.fit();
    rig.focusDimension('width');
    rig.fit();
    expect(rig.stats.starts).toBe(3);
    // первый кадр — с места (скорость ≈ 0), без рывка
    rig.update(1 / 60);
    expect(Math.abs(rig.pose.span - span0) / span0).toBeLessThan(0.01);
    const spans: number[] = [];
    for (let i = 0; i < 60; i++) { rig.update(1 / 60); spans.push(rig.pose.span); }
    expect(rig.camera.type).toBe('OrthographicCamera');
    expect(rig.pose.theta).toBeCloseTo(0);
    // монотонно, без «качелей» от перезапусков
    const d = spans.slice(1).map((x, i) => x - spans[i]!);
    expect(d.every((x) => x >= -1e-9) || d.every((x) => x <= 1e-9)).toBe(true);
  });

  it('смена перспективы на ортогональ и обратно — без скачка картинки', () => {
    const rig = setup();
    rig.fit({ animate: false });
    const dt = 1 / 60;
    const shot = () => {
      const pts: Vector3[] = [];
      for (let i = 0; i < 8; i++) pts.push(rig.project(new Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)));
      return pts;
    };
    const jump = (a: Vector3[], c: Vector3[]) => Math.max(...a.map((p, i) => Math.hypot(p.x - c[i]!.x, p.y - c[i]!.y)));
    for (const key of ['height', null] as const) {
      let last = shot();
      let lastType = rig.camera.type;
      rig.focusDimension(key);
      let maxStep = 0;
      let swapStep = -1;
      for (let i = 0; i < 60; i++) {
        rig.update(dt);
        const cur = shot();
        const step = jump(last, cur);
        if (rig.camera.type !== lastType) swapStep = step;
        else maxStep = Math.max(maxStep, step);
        last = cur;
        lastType = rig.camera.type;
      }
      // на кадре смены камеры картинка сдвигается не больше, чем на обычном кадре анимации
      expect(swapStep).toBeGreaterThanOrEqual(0);
      expect(swapStep).toBeLessThanOrEqual(maxStep + 0.01);
    }
    // в конце перехода перспектива уже ровно ортогональ: смена камеры не видна
    rig.focusDimension('width');
    for (let i = 0; i < 60; i++) rig.update(dt);
    expect(rig.camera.type).toBe('OrthographicCamera');
    const p = new Vector3(0.82, 1.8, -0.45);
    const a = p.clone().project(rig.perspective);
    const o = p.clone().project(rig.orthographic);
    expect(Math.hypot((a.x - o.x) * 195, (a.y - o.y) * 300)).toBeLessThan(0.01);
  });
});

describe('тени у стыков и волокна', () => {
  it('AO: один меш, полосы у ниш шкафа, без дверей', () => {
    const m = fixture('wardrobe_full.viewer.json');
    const g = contactShadowGeometry(m.parts, 0.001)!;
    const tris = g.getAttribute('position').count / 3;
    expect(tris).toBeGreaterThan(50);
    expect(tris).toBeLessThan(6000);
    expect(g.getAttribute('color').itemSize).toBe(4);
    const s = new ProductScene(m, { quality: 'medium' });
    expect(s.ao?.visible).toBe(true);
    s.setExplode(1);
    expect(s.ao?.visible).toBe(false);
    s.dispose();
  });

  it('процедурные волокна в реальном масштабе: повтор = 1000 мм / плитка', () => {
    const m = fixture('wardrobe_full.viewer.json');
    const s = new ProductScene(m, { quality: 'medium', loadTexture: null });
    const door = s.parts.find((h) => h.part.role === 'door')!;
    const map = (door.mesh.material as unknown as { map: { repeat: { x: number; y: number } } | null }).map!;
    expect(map.repeat.x).toBeCloseTo(1000 / GRAIN_TILE_MM[0]);
    expect(map.repeat.y).toBeCloseTo(1000 / GRAIN_TILE_MM[1]);
    const t = createWoodGrainTexture(64);
    const d = t.image.data as Uint8Array;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) { lo = Math.min(lo, d[i]!); hi = Math.max(hi, d[i]!); }
    expect(lo).toBeGreaterThanOrEqual(204);
    expect(hi - lo).toBeGreaterThan(15);
    s.dispose();
  });

  it('скан декора из модели: грузится, масштаб по textureSizeMm', async () => {
    const m = fixture('wardrobe_full.viewer.json');
    m.materials.ldsp_18_oak = { ...m.materials.ldsp_18_oak!, texture: 'bundled:oak', textureSizeMm: [1000, 300] };
    const { Texture } = await import('three');
    const s = new ProductScene(m, { quality: 'medium', loadTexture: async () => new Texture() });
    let changed = 0;
    s.onChange = () => changed++;
    await new Promise((r) => setTimeout(r, 0));
    const door = s.parts.find((h) => h.part.role === 'door')!;
    const mat = door.mesh.material as unknown as { map: { repeat: { x: number; y: number } }; color: { getHexString(): string } };
    expect(changed).toBe(1);
    expect(mat.map.repeat.x).toBeCloseTo(1);
    expect(mat.map.repeat.y).toBeCloseTo(1000 / 300);
    expect(mat.color.getHexString()).toBe('ffffff');
    s.dispose();
  });
});

describe('правка без рывка: шейдеры и текстуры не пересоздаются', () => {
  it('новая сцена берёт те же исходники текстур (без повторной загрузки в GPU)', () => {
    const m = fixture('wardrobe_full.viewer.json');
    const a = new ProductScene(m, { quality: 'medium', loadTexture: null });
    const b = new ProductScene(m, { quality: 'medium', loadTexture: null });
    const mapOf = (s: ProductScene) => (s.parts.find((h) => h.part.role === 'door')!.mesh.material as unknown as { map: { source: unknown } }).map;
    expect(mapOf(a)).not.toBe(mapOf(b));
    expect(mapOf(a).source).toBe(mapOf(b).source);
    a.dispose();
    // старая сцена освобождена — у новой текстура та же
    expect(mapOf(b).source).toBeTruthy();
    b.dispose();
  });

  it('warmup: заранее собирает шейдеры подсветки и «рентгена» и читает их uniforms', () => {
    const m = fixture('cabinet_door_drawer.viewer.json');
    const s = new ProductScene(m, { quality: 'medium' });
    const names: string[] = [];
    let fetched = 0;
    const program = { getUniforms: () => { fetched++; }, getAttributes: () => { fetched++; } };
    const renderer = {
      compile: (root: { traverse(f: (o: { material?: { name: string } }) => void): void }) => {
        root.traverse((o) => { if (o.material) names.push(o.material.name); });
      },
      info: { programs: [program] },
    };
    s.warmup(renderer as never, new PerspectiveCamera(), new Scene());
    expect(names).toContain('ghost');
    expect(names.some((n) => n.endsWith(':highlight'))).toBe(true);
    expect(fetched).toBe(2);
    // подсветка потом берёт те же материалы (программы уже собраны)
    const before = names.filter((n) => n.endsWith(':highlight')).length;
    const parts = s.highlight(s.parts[0]!.part.number, { ghost: true });
    expect(parts.length).toBe(1);
    expect((parts[0]!.mesh.material as { name: string }).name.endsWith(':highlight')).toBe(true);
    expect(before).toBeGreaterThan(0);
    s.dispose();
  });
});
