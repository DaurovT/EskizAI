// Смоук-тест React-слоя: ProductObject под React 19 + @react-three/fiber 9 (тот же код, что в web и в приложении).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRef } from 'react';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { describe, expect, it } from 'vitest';
import { parseViewerModel, type ProductScene, type ViewerModel } from '../src/index.js';
import { ProductObject, type ProductHandle } from '../src/react/index.js';

// React 19: act() вне jest нужно включить явно, иначе предупреждения в каждом тесте.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = (name: string): ViewerModel =>
  parseViewerModel(JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')));

describe('ProductObject (R3F 9)', () => {
  it('строит сцену, вызывает onReady и отдаёт управление через ref', async () => {
    const model = fixture('cabinet_door_drawer.viewer.json');
    const ref = createRef<ProductHandle>();
    let ready: ProductScene | null = null;
    const r = await ReactThreeTestRenderer.create(
      <ProductObject ref={ref} model={model} options={{ quality: 'low' }} onReady={(s) => { ready = s; }} dimensions />,
    );
    expect(ready).not.toBeNull();
    expect(ref.current?.scene).toBe(ready);
    const sc = ready as unknown as ProductScene;
    expect(sc.parts.length).toBe(model.parts.length);
    expect(sc.stats().drawCalls).toBeGreaterThan(0);
    expect(sc.dimensionsVisible).toBe(true);
    // корень сцены смонтирован в граф R3F
    expect(r.scene.children.length).toBeGreaterThan(0);
    ref.current?.openAll();
    await ReactThreeTestRenderer.act(async () => { await r.advanceFrames(40, 1 / 30); });
    // r.unmount() не зовём: заглушка WebGL из test-renderer не умеет cancelAnimationFrame (шум в логе R3F 9.8).
  });
});
