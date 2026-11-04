import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportGlbVariants } from '../src/export/index.js';
import { parseViewerModel } from '../src/index.js';

const load = (name: string) =>
  parseViewerModel(JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')));

interface GlbJson {
  nodes: { name?: string; translation?: number[]; rotation?: number[] }[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
  accessors: { min?: number[]; max?: number[] }[];
}

function readGlbJson(buf: ArrayBuffer): GlbJson {
  const dv = new DataView(buf);
  expect(dv.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
  const jsonLen = dv.getUint32(12, true);
  const json = new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen));
  return JSON.parse(json);
}

describe('GLB', () => {
  it('два варианта в метрах, узлы отдельными объектами', async () => {
    const m = load('cabinet_door_drawer.viewer.json');
    const { closed, open } = await exportGlbVariants(m);
    expect(closed.byteLength).toBeGreaterThan(1000);
    expect(closed.byteLength).toBeLessThan(5 * 1024 * 1024);
    const jc = readGlbJson(closed);
    const jo = readGlbJson(open);
    const names = jc.nodes.map((n) => n.name);
    expect(names).toContain('node:door[0]');
    expect(names).toContain('node:drawer[0]');
    // Реальный масштаб: максимальная координата — метры (0.9 м высота), не мм.
    const posIdx = jc.meshes.flatMap((mesh) => mesh.primitives.map((p) => p.attributes.POSITION!));
    const maxY = Math.max(...posIdx.map((i) => jc.accessors[i]!.max![1]!));
    expect(maxY).toBeLessThan(1);
    expect(maxY).toBeGreaterThan(0.85);
    // В «открыто» узел двери повернут, ящик выдвинут на 0.4 м.
    const doorOpen = jo.nodes.find((n) => n.name === 'node:door[0]')!;
    expect(doorOpen.rotation).toBeDefined();
    const drawerOpen = jo.nodes.find((n) => n.name === 'node:drawer[0]')!;
    expect(drawerOpen.translation?.[2]).toBeCloseTo(0.4, 5);
  });
});
