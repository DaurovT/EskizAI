import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Mesh, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ProductScene, parseViewerModel, shapeGeometry, type ViewerModel } from '../src/index.js';

const fixture = (name: string): ViewerModel =>
  parseViewerModel(JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')));

const wardrobe = () => fixture('hardware_wardrobe.viewer.json');
const kitchen = () => fixture('hardware_kitchen_corner.viewer.json');
const worldBox = (m: Mesh) => m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);

describe('фурнитура', () => {
  it('формы: бокс и цилиндры в осях three (x = X, y = Z, z = −Y)', () => {
    const box = shapeGeometry({ type: 'box', min: [0, -30, 100], max: [10, -10, 300] });
    box.computeBoundingBox();
    expect(box.boundingBox!.min.toArray()).toEqual([0, 100, 10]);
    expect(box.boundingBox!.max.toArray()).toEqual([10, 300, 30]);
    const cylY = shapeGeometry({ type: 'cylinder', axis: 'Y', center: [0, -20, 0], radius: 5, length: 40 });
    cylY.computeBoundingBox();
    expect(cylY.boundingBox!.min.z).toBeCloseTo(0);
    expect(cylY.boundingBox!.max.z).toBeCloseTo(40);
    // Сектор 3/4: вырезана четверть x > 0, y < 0 ядра (= z > 0 в three)
    const sector = shapeGeometry({ type: 'cylinder', axis: 'Z', center: [0, 0, 0], radius: 100, length: 10, start: 0, sweep: 270 });
    sector.computeBoundingBox();
    expect(sector.boundingBox!.max.z).toBeCloseTo(100);
    const pos = sector.getAttribute('position');
    for (let i = 0; i < pos.count; i++) expect(pos.getX(i) > 1 && pos.getZ(i) > 1).toBe(false);
  });

  it('у каждой двери и фасада ящика — ручка; меши помечены userData.kind = hardware', () => {
    const s = new ProductScene(wardrobe(), { units: 'mm' });
    const fronts = s.parts.filter((h) => h.part.role === 'door' || h.part.role === 'drawer_front');
    const handles = s.hardware.filter((h) => h.item.kind === 'handle');
    expect(handles.length).toBe(fronts.length);
    for (const h of handles) {
      expect(h.mesh.userData.kind).toBe('hardware');
      expect(h.mesh.userData.hardwareName).toMatch(/Ручка-скоба 128/);
      expect(h.parent?.part.key).toBe(h.item.part);
      // Ручка перед фасадом (z сцены больше лицевой плоскости)
      expect(worldBox(h.mesh).max.z).toBeGreaterThan(worldBox(h.parent!.mesh).max.z + 20);
    }
    expect(s.parts.every((p) => p.mesh.userData.kind === 'part')).toBe(true);
    expect(s.hardware.some((h) => h.item.kind === 'hinge')).toBe(true);
    expect(s.hardware.some((h) => h.item.kind === 'rod_holder')).toBe(true);
  });

  it('ручка едет с дверью, планка петли остаётся на корпусе', () => {
    const s = new ProductScene(wardrobe(), { units: 'mm' });
    const door = 'sections[0].doors.door[1]';
    const handle = s.hardware.find((h) => h.item.id === `${door}.handle[1]`)!;
    const arm = s.hardware.find((h) => h.item.id === `${door}.hinge[1].arm`)!;
    s.root.updateMatrixWorld(true);
    const h0 = worldBox(handle.mesh).getCenter(new Vector3());
    const a0 = worldBox(arm.mesh).getCenter(new Vector3());
    s.setNodeOpen(door, 1);
    s.root.updateMatrixWorld(true);
    expect(worldBox(handle.mesh).getCenter(new Vector3()).distanceTo(h0)).toBeGreaterThan(300);
    expect(worldBox(arm.mesh).getCenter(new Vector3()).distanceTo(a0)).toBeLessThan(1e-6);
  });

  it('«взрыв»: фурнитура смещается так же, как её деталь', () => {
    const s = new ProductScene(wardrobe(), { units: 'mm' });
    const handle = s.hardware.find((h) => h.item.kind === 'handle')!;
    s.root.updateMatrixWorld(true);
    const before = worldBox(handle.mesh).getCenter(new Vector3());
    const pBefore = worldBox(handle.parent!.mesh).getCenter(new Vector3());
    s.setExplode(1);
    s.root.updateMatrixWorld(true);
    const moved = worldBox(handle.mesh).getCenter(new Vector3()).sub(before);
    const pMoved = worldBox(handle.parent!.mesh).getCenter(new Vector3()).sub(pBefore);
    expect(moved.distanceTo(pMoved)).toBeLessThan(1e-6);
    expect(moved.length()).toBeGreaterThan(10);
  });

  it('выбор лучом: попадание в ручку → деталь-«родитель» с kind = hardware', () => {
    const s = new ProductScene(wardrobe(), { units: 'mm' });
    const handle = s.hardware.find((h) => h.item.id === 'sections[0].doors.door[1].handle[1]')!;
    s.root.updateMatrixWorld(true);
    const c = worldBox(handle.mesh).getCenter(new Vector3());
    const ray = new Raycaster(new Vector3(c.x, c.y, c.z + 2000), new Vector3(0, 0, -1));
    const hit = s.pick(ray)!;
    expect(hit.kind).toBe('hardware');
    expect(hit.hardware?.kind).toBe('handle');
    expect(hit.hardware?.name).toMatch(/Ручка/);
    expect(hit.key).toBe('sections[0].doors.door[1]');
    expect(hit.node).toBe('sections[0].doors.door[1]');
    // Мимо ручки — обычная деталь
    const miss = s.pick(new Raycaster(new Vector3(c.x - 200, c.y, c.z + 2000), new Vector3(0, 0, -1)))!;
    expect(miss.kind).toBe('part');
    expect(miss.hardware).toBeUndefined();
  });

  it('low: без петель и направляющих, фурнитура слита по отделке; при «взрыве» — отдельные меши', () => {
    const s = new ProductScene(wardrobe(), { units: 'mm', quality: 'low' });
    expect(s.hardware.some((h) => h.item.kind === 'hinge' || h.item.kind === 'slide')).toBe(false);
    expect(s.hardware.length).toBeGreaterThan(0);
    expect(s.mergedHardware.length).toBeGreaterThan(0);
    expect(s.mergedHardware.every((m) => m.visible)).toBe(true);
    s.setExplode(1);
    expect(s.mergedHardware.every((m) => !m.visible)).toBe(true);
    expect(s.hardware.filter((h) => h.merged).every((h) => h.mesh.visible)).toBe(true);
    expect(new ProductScene(wardrobe(), { units: 'mm', hardware: false }).hardware.length).toBe(0);
  });

  it('подсветка двери подсвечивает и её ручку; «рентген» гасит чужую фурнитуру', () => {
    const s = new ProductScene(wardrobe(), { units: 'mm' });
    s.highlight('sections[0].doors.door[1]', { ghost: true });
    const own = s.hardware.find((h) => h.item.id === 'sections[0].doors.door[1].handle[1]')!;
    const other = s.hardware.find((h) => h.item.id === 'sections[2].doors.door[1].handle[1]')!;
    expect((own.mesh.material as { name: string }).name).toMatch(/highlight/);
    expect((other.mesh.material as { name: string }).name).toBe('ghost');
    s.clearHighlight();
    expect((own.mesh.material as { name: string }).name).toBe('hw:steel');
  });

  it('кухня: ножки под нижними модулями, карусель в углу; габарит по деталям не меняется', () => {
    const m = kitchen();
    const s = new ProductScene(m, { units: 'mm' });
    const legs = s.hardware.filter((h) => h.item.kind === 'leg');
    expect(legs.length).toBeGreaterThan(8);
    s.root.updateMatrixWorld(true);
    for (const l of legs) expect(worldBox(l.mesh).min.y).toBeCloseTo(0);
    expect(s.hardware.filter((h) => h.item.kind === 'carousel').length).toBe(2);
    const noHw = new ProductScene({ ...m, hardware: [] }, { units: 'mm' });
    expect(s.closedBounds.equals(noHw.closedBounds)).toBe(true);
    // Старые модели без поля hardware строятся как раньше
    const { hardware: _h, ...old } = m;
    expect(new ProductScene(old as ViewerModel, { units: 'mm' }).hardware.length).toBe(0);
  });
});
