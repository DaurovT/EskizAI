import { Box3, Vector3 } from 'three';

export interface CameraFit {
  /** Куда смотреть (центр изделия). */
  target: Vector3;
  /** Где поставить камеру. */
  position: Vector3;
  /** Рекомендуемые near/far и пределы зума для OrbitControls. */
  near: number;
  far: number;
  minDistance: number;
  maxDistance: number;
}

/**
 * Камера так, чтобы изделие целиком влезло в кадр (вертикальный FOV в градусах).
 * Смотрим спереди, чуть справа и сверху — как стоит человек в комнате.
 */
export function fitCamera(
  bounds: Box3,
  fovDeg = 40,
  aspect = 1,
  direction: Vector3 = new Vector3(0.45, 0.28, 1),
  margin = 1.15,
): CameraFit {
  const target = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const radius = Math.max(size.length() / 2, 1e-6);
  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const fov = Math.min(vFov, hFov);
  const distance = (radius * margin) / Math.sin(fov / 2);
  const position = target.clone().addScaledVector(direction.clone().normalize(), distance);
  return {
    target,
    position,
    // В expo-gl буфер глубины 16 бит: слишком маленький near — z-fighting на всём, что ближе пары мм
    near: distance / 25,
    far: distance * 20,
    minDistance: radius * 0.6,
    maxDistance: distance * 3,
  };
}
