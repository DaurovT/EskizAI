import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AmbientLight,
  Color,
  CubeUVReflectionMapping,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Scene,
  Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';
import { ProductScene, parseViewerModel, strokePolyline, type ViewerModel } from '../src/index.js';
import { thumbnailRgba } from '../src/thumbnail/index.js';

const fixture = (name: string): ViewerModel =>
  parseViewerModel(JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')));

const wardrobe = () => fixture('wardrobe_decor.viewer.json');
const kitchen = () => fixture('kitchen_decor.viewer.json');
const showcase = () => fixture('decor_showcase.viewer.json');
/** Та же модель без декора и подсветки (база для сравнения draw calls). */
const plain = (m: ViewerModel): ViewerModel => ({ ...m, parts: m.parts.map((p) => ({ ...p, decor: undefined })), lights: [] });
const worldBox = (m: Mesh) => m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);

describe('пути декора', () => {
  it('путь ядра (move + line/arc) и путь контракта (start без move) дают одну ломаную', () => {
    const core = strokePolyline({
      path: [
        { kind: 'move', x: 10, y: 10 },
        { kind: 'line', x: 90, y: 10 },
        { kind: 'line', x: 90, y: 50 },
        { kind: 'line', x: 10, y: 50 },
        { kind: 'line', x: 10, y: 10 },
      ],
      closed: true,
    });
    expect(core.closed).toBe(true);
    expect(core.pts).toEqual([
      [10, 10],
      [90, 10],
      [90, 50],
      [10, 50],
    ]);
    const contract = strokePolyline({
      start: [10, 10],
      path: [
        { kind: 'line', x: 90, y: 10 },
        { kind: 'line', x: 90, y: 50 },
        { kind: 'line', x: 10, y: 50 },
        { kind: 'line', x: 10, y: 10 },
      ],
    });
    expect(contract.pts).toEqual(core.pts);
    // Без move и без start: замкнутый путь начинается в конце последнего сегмента
    const bare = strokePolyline({ path: contract.pts.slice(1).concat([[10, 10]]).map(([x, y]) => ({ kind: 'line', x, y })), closed: true });
    expect(bare.pts[0]).toEqual([10, 10]);
  });

  it('дуга по часовой — точки на окружности, угол убывает', () => {
    const l = strokePolyline({
      path: [
        { kind: 'move', x: 100, y: 0 },
        { kind: 'arc', x: 0, y: -100, cx: 0, cy: 0, clockwise: true },
      ],
      closed: false,
    });
    expect(l.pts.length).toBeGreaterThan(4);
    for (const [x, y] of l.pts) expect(Math.hypot(x, y)).toBeCloseTo(100, 6);
    expect(l.pts[1]![1]).toBeLessThan(0); // пошли вниз (по часовой)
  });
});

describe('декор фасадов', () => {
  it('покраска: цвет и блеск → материал; у фасада с декором — цвет вершин и metalMask', () => {
    const s = new ProductScene(showcase(), { units: 'mm', quality: 'medium' });
    const door = s.parts.find((h) => h.part.key === 'sections[0].doors.door[1]')!;
    expect(door.materialKey).toBe('paint:#1f2a44:gloss|gold');
    const mat = door.mesh.material as MeshStandardMaterial;
    expect(mat.color.getHexString()).toBe(new Color('#1F2A44').getHexString());
    expect(mat.roughness).toBeCloseTo(0.15);
    expect(mat.vertexColors).toBe(true);
    expect(door.mesh.geometry.getAttribute('color')).toBeDefined();
    expect(door.mesh.geometry.getAttribute('metalMask')).toBeDefined();
    const matte = s.parts.find((h) => h.part.key === 'sections[2].doors.door[1]')!;
    expect((matte.mesh.material as MeshStandardMaterial).roughness).toBeCloseTo(0.8);
    const satin = s.parts.find((h) => h.part.key.startsWith('sections[1].fill[0].doors.door'))!;
    expect((satin.mesh.material as MeshStandardMaterial).roughness).toBeCloseTo(0.45);
    // Пазы темнее лица фасада
    const col = door.mesh.geometry.getAttribute('color');
    let min = 1;
    for (let i = 0; i < col.count; i++) min = Math.min(min, col.getX(i));
    expect(min).toBeLessThan(0.7);
    s.dispose();
  });

  it('вставки: по одной на фасад, название и отделка; накладка выступает над фасадом', () => {
    const s = new ProductScene(showcase(), { units: 'mm' });
    const names = new Set(s.decor.map((d) => d.name));
    expect(names).toContain('Вставка (золото)');
    expect(names).toContain('Вставка (латунь)');
    expect(names).toContain('Кант (хром)');
    // Молдинг 9 мм: меш фасада выходит вперёд дальше лица (z лица = 18 мм у дверей шкафа)
    const arched = s.parts.find((h) => h.part.key === 'sections[1].fill[0].doors.door[1]')!;
    s.root.updateMatrixWorld(true);
    expect(worldBox(arched.mesh).max.z).toBeGreaterThan(18 + 8);
    s.dispose();
  });

  it('draw calls на medium: декор фасадов почти бесплатен (≤ +20 % вместе с LED-профилями)', () => {
    for (const m of [wardrobe(), kitchen()]) {
      const a = new ProductScene(plain(m), { quality: 'medium' }).stats().drawCalls;
      const s = new ProductScene(m, { quality: 'medium' });
      const b = s.stats().drawCalls;
      expect(b).toBeLessThanOrEqual(Math.ceil(a * 1.2));
      // Декор без LED — ноль лишних вызовов: всё в меше фасада
      const noLights = new ProductScene({ ...m, lights: [] }, { quality: 'medium' }).stats().drawCalls;
      expect(noLights).toBe(a);
      s.dispose();
    }
  });

  it('тап по вставке → kind decor и фасад; по фрезеровке → сама деталь', () => {
    const s = new ProductScene(showcase(), { units: 'mm' });
    s.root.updateMatrixWorld(true);
    const d = s.decor.find((x) => x.finish === 'gold')!;
    const g = d.part.mesh.geometry;
    const pos = g.getAttribute('position');
    // Центр треугольника вставки → луч спереди
    const c = new Vector3();
    for (let k = 0; k < 3; k++) c.add(new Vector3().fromBufferAttribute(pos, d.triStart * 3 + k));
    c.divideScalar(3).applyMatrix4(d.part.mesh.matrixWorld);
    const ray = new Raycaster(c.clone().add(new Vector3(0, 0, 500)), new Vector3(0, 0, -1));
    const hit = s.pick(ray)!;
    expect(hit.kind).toBe('decor');
    expect(hit.key).toBe('sections[0].doors.door[1]');
    expect(hit.decor?.name).toBe('Вставка (золото)');
    expect(hit.node).toBe('sections[0].doors.door[1]');
    // Середина фасада (без вставки) — деталь
    const mid = worldBox(d.part.mesh).getCenter(new Vector3());
    const hit2 = s.pick(new Raycaster(mid.clone().add(new Vector3(0, 0, 500)), new Vector3(0, 0, -1)))!;
    expect(hit2.kind).toBe('part');
    s.dispose();
  });

  it('скругление из decor.radius без контура; декор едет и разлетается с фасадом', () => {
    const s = new ProductScene(showcase(), { units: 'mm' });
    const door = s.parts.find((h) => h.part.key === 'sections[1].fill[0].doors.door[1]')!;
    expect(door.part.contour).toBeNull();
    // Угла прямоугольника нет: ближайшая к углу вершина дальше 10 мм (радиус 40)
    s.root.updateMatrixWorld(true);
    const bb = worldBox(door.mesh);
    const pos = door.mesh.geometry.getAttribute('position');
    let best = Infinity;
    const v = new Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(door.mesh.matrixWorld);
      best = Math.min(best, Math.hypot(v.x - bb.min.x, v.y - bb.min.y));
    }
    expect(best).toBeGreaterThan(10);
    const c0 = worldBox(door.mesh).getCenter(new Vector3());
    s.setExplode(1);
    s.root.updateMatrixWorld(true);
    expect(worldBox(door.mesh).getCenter(new Vector3()).distanceTo(c0)).toBeGreaterThan(50);
    s.dispose();
  });

  it('превью без WebGL: краска и вставки видны (есть золотые пиксели)', () => {
    const img = thumbnailRgba(showcase(), { width: 160, height: 120, supersample: 1 });
    let navy = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const [r, g, b] = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
      if (b > r + 20 && b > 50 && r < 80) navy++;
    }
    expect(navy).toBeGreaterThan(50);
  });
});

describe('фурнитура: кнопка и Gola, металл без карты окружения', () => {
  it('кнопка — тело вращения перед фасадом, едет с ящиком; Gola — профиль на корпусе', () => {
    const s = new ProductScene(kitchen(), { units: 'mm' });
    const gola = s.hardware.find((h) => h.item.kind === 'gola')!;
    expect(gola.item.node).toBeNull();
    // C-профиль: больше 12 треугольников бокса
    expect(gola.mesh.geometry.getAttribute('position').count / 3).toBeGreaterThan(12);
    s.dispose();
    const w = new ProductScene(wardrobe(), { units: 'mm' });
    const knob = w.hardware.find((h) => h.item.kind === 'knob')!;
    w.root.updateMatrixWorld(true);
    const face = worldBox(knob.parent!.mesh).max.z;
    expect(worldBox(knob.mesh).max.z).toBeGreaterThan(face + 25);
    const c0 = worldBox(knob.mesh).getCenter(new Vector3());
    w.setNodeOpen(knob.item.node!, 1);
    w.root.updateMatrixWorld(true);
    expect(worldBox(knob.mesh).getCenter(new Vector3()).distanceTo(c0)).toBeGreaterThan(100);
    w.dispose();
  });

  it('medium: металл и глянец получают свою «студию» (CubeUV без PMREM); low — нет', () => {
    const s = new ProductScene(showcase(), { quality: 'medium' });
    const knob = s.hardware.find((h) => h.item.kind === 'knob')!;
    const m = knob.mesh.material as MeshStandardMaterial;
    expect(m.envMap?.mapping).toBe(CubeUVReflectionMapping);
    expect(m.metalness).toBeCloseTo(0.9);
    const gloss = s.parts.find((h) => h.materialKey.includes(':gloss'))!;
    expect((gloss.mesh.material as MeshStandardMaterial).envMap).not.toBeNull();
    s.dispose();
    const low = new ProductScene(showcase(), { quality: 'low' });
    expect((low.hardware[0]!.mesh.material as { envMap?: unknown }).envMap ?? null).toBeNull();
    low.dispose();
  });
});

describe('LED-подсветка', () => {
  it('профили по lights[]; включение — свечение, пятна, PointLight, «вечер» для чужого света; выключение — как было', () => {
    const s = new ProductScene(wardrobe(), { units: 'mm' });
    expect(s.lights.length).toBe(wardrobe().lights!.length);
    const scene = new Scene();
    const amb = new AmbientLight('#ffffff', 1);
    scene.add(amb, s.root);
    const niche = s.lights.find((l) => l.light.zone === 'niche')!;
    expect(niche.glow!.visible).toBe(false);
    s.setLightsOn(true);
    expect(s.lightsOn).toBe(true);
    expect(niche.glow!.visible).toBe(true);
    expect(niche.point!.intensity).toBeGreaterThan(0);
    expect(amb.intensity).toBeCloseTo(0.4);
    // Пятно под профилем: на полке ниже профиля
    s.root.updateMatrixWorld(true);
    const ledY = worldBox(niche.mesh).min.y;
    expect(worldBox(niche.glow!).min.y).toBeLessThan(ledY - 100);
    s.setLightsOn(false);
    expect(amb.intensity).toBeCloseTo(1);
    expect(niche.point!.intensity).toBe(0);
    expect(niche.glow!.visible).toBe(false);
    s.dispose();
  });

  it('свет с nodeId едет с узлом; профили не выбираются лучом', () => {
    const m = wardrobe();
    const door = m.nodes.find((n) => n.kind === 'rotate')!;
    const lights = [{ id: 'x', from: [100, -30, 500], to: [400, -30, 500], temp: 6000, nodeId: door.id } as const];
    const s = new ProductScene({ ...m, lights: lights.map((l) => ({ ...l, from: [...l.from], to: [...l.to] })) as ViewerModel['lights'] }, { units: 'mm' });
    const l = s.lights[0]!;
    s.root.updateMatrixWorld(true);
    const c0 = worldBox(l.mesh).getCenter(new Vector3());
    s.setNodeOpen(door.id, 1);
    s.root.updateMatrixWorld(true);
    expect(worldBox(l.mesh).getCenter(new Vector3()).distanceTo(c0)).toBeGreaterThan(50);
    const hits: unknown[] = [];
    l.mesh.raycast(new Raycaster(c0.clone().add(new Vector3(0, 0, 100)), new Vector3(0, 0, -1)), hits as never);
    expect(hits.length).toBe(0);
    s.dispose();
  });
});

describe('комната (встроенная мебель)', () => {
  const withRoom = (): ViewerModel => fixture('decor_room.viewer.json');

  it('стены цветом комнаты, не в габарите, не выбираются; setRoomVisible', () => {
    const m = withRoom();
    const s = new ProductScene(m, { units: 'mm' });
    const bare = new ProductScene({ ...m, room: undefined }, { units: 'mm' });
    expect(s.room).not.toBeNull();
    expect(s.roomVisible).toBe(true);
    expect(s.closedBounds.equals(bare.closedBounds)).toBe(true);
    expect(s.currentBounds().equals(bare.currentBounds())).toBe(true);
    const col = s.room!.geometry.getAttribute('color');
    const floor = new Color('#9C7A5B');
    let hasFloor = false;
    for (let i = 0; i < col.count; i++) if (Math.abs(col.getX(i) - floor.r) < 1e-4) hasFloor = true;
    expect(hasFloor).toBe(true);
    const hits: unknown[] = [];
    s.room!.raycast(new Raycaster(new Vector3(900, 1000, 3000), new Vector3(0, 0, -1)), hits as never);
    expect(hits.length).toBe(0);
    s.setRoomVisible(false);
    expect(s.room!.visible).toBe(false);
    expect(new ProductScene(m, { room: false }).room).toBeNull();
    s.dispose();
    bare.dispose();
  });
});
