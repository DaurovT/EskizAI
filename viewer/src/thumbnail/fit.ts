import { Box3, Color, PerspectiveCamera, Vector3 } from 'three';

export const DEFAULT_THUMBNAIL_DIRECTION: [number, number, number] = [0.62, 0.38, 1];
const DEFAULT_DIR = DEFAULT_THUMBNAIL_DIRECTION;

export function bgColor(bg: string | undefined): Color | null {
  if (!bg || bg === 'transparent') return null;
  return new Color(bg === 'white' ? '#ffffff' : bg);
}

/**
 * Камера так, чтобы габарит заполнил кадр на долю `fill` (по проекции углов
 * габарита, а не по описанной сфере — превью получается плотнее).
 */
export function fitThumbnailCamera(
  bounds: Box3,
  aspect: number,
  fov = 30,
  direction: [number, number, number] = DEFAULT_DIR,
  fill = 0.9,
): PerspectiveCamera {
  const cam = new PerspectiveCamera(fov, aspect, 0.01, 1000);
  const center = bounds.getCenter(new Vector3());
  const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 1e-6);
  const dir = new Vector3(...direction).normalize();
  let dist = radius / Math.sin((fov * Math.PI) / 360);
  const corners: Vector3[] = [];
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) corners.push(new Vector3(x, y, z));
  for (let iter = 0; iter < 4; iter++) {
    cam.position.copy(center).addScaledVector(dir, dist);
    cam.near = dist / 100;
    cam.far = dist * 10;
    cam.lookAt(center);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    let ext = 0;
    for (const c of corners) {
      const p = c.clone().project(cam);
      ext = Math.max(ext, Math.abs(p.x), Math.abs(p.y));
    }
    if (ext <= 0) break;
    // Расстояние примерно обратно пропорционально размеру на экране.
    dist *= ext / fill;
  }
  cam.position.copy(center).addScaledVector(dir, dist);
  cam.lookAt(center);
  cam.updateMatrixWorld(true);
  return cam;
}

