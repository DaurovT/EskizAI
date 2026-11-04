import { Line, Mesh, Points, type BufferGeometry, type Object3D } from 'three';

export interface SceneStats {
  /** Вызовов отрисовки за один проход (как renderer.info.render.calls без отсечения по камере). */
  drawCalls: number;
  triangles: number;
  /** Видимых мешей и линий. */
  meshes: number;
  lines: number;
}

function primitiveCount(g: BufferGeometry, per: number): number {
  const n = g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0);
  return Math.floor(n / per);
}

/**
 * Считает, сколько вызовов отрисовки даст объект: по одному на видимый меш/линию
 * (или по одному на группу геометрии, если материалов несколько). Скрытые
 * объекты и их потомки не считаются — как в WebGLRenderer.
 */
export function sceneStats(root: Object3D): SceneStats {
  const s: SceneStats = { drawCalls: 0, triangles: 0, meshes: 0, lines: 0 };
  const visit = (o: Object3D) => {
    if (!o.visible) return;
    if (o instanceof Mesh) {
      const calls = Array.isArray(o.material) ? Math.max(1, o.geometry.groups.length) : 1;
      s.drawCalls += calls;
      s.triangles += primitiveCount(o.geometry, 3);
      s.meshes += 1;
    } else if (o instanceof Line || o instanceof Points) {
      s.drawCalls += 1;
      s.lines += 1;
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  return s;
}
