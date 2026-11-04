import { forwardRef, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { ContactShadows, OrbitControls } from '@react-three/drei';
import { PMREMGenerator, PerspectiveCamera, Vector3 } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { fitCamera } from '../camera.js';
import type { HighlightTarget, ProductScene, ProductSceneOptions } from '../product.js';
import { detectQuality, qualitySettings, type QualityLevel, type QualitySettings } from '../quality.js';
import type { PickResult, ViewerModel } from '../types.js';
import { ProductObject, type ProductHandle } from './ProductObject.js';

export interface ProductViewerProps {
  model: ViewerModel;
  options?: ProductSceneOptions;
  className?: string;
  style?: CSSProperties;
  /** Цвет фона; по умолчанию прозрачный (видно фон страницы). */
  background?: string;
  /** Мягкая тень на полу. По умолчанию — по качеству (low — без тени). */
  shadows?: boolean;
  /**
   * Качество: 'low' для бюджетных Android, 'medium', 'high' (по умолчанию) или 'auto' —
   * догадка по устройству (detectQuality). Влияет на dpr, сглаживание, тень, отражения,
   * материалы и слияние мешей. Можно задать и через options.quality.
   */
  quality?: QualityLevel | 'auto';
  /** Показать размеры (кнопка «Размеры»). */
  dimensions?: boolean;
  /** LED-подсветка (кнопка «Подсветка»): светится, сцена приглушена. */
  lightsOn?: boolean;
  /** Комната встроенной мебели (если есть в модели). По умолчанию показана. */
  roomVisible?: boolean;
  /** Подсветить деталь / узел / секцию. */
  highlight?: HighlightTarget | null;
  /** «Рентген» вокруг подсвеченного. */
  ghost?: boolean;
  /** Навести камеру на подсвеченное. */
  focusOnHighlight?: boolean;
  toggleOnTap?: boolean;
  onPartTap?: (pick: PickResult) => void;
  onReady?: (scene: ProductScene) => void;
  /** Что показать, если WebGL недоступен. Ошибки рендера ловите ErrorBoundary снаружи. */
  fallback?: ReactNode;
  children?: ReactNode;
}

/** Узкий FOV: без «широкоугольного» искажения (низ шкафа не шире верха). */
const FOV = 28;

/** Камера по габариту изделия: при первой загрузке и смене модели. */
function AutoFit({ scene }: { scene: ProductScene | null }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as {
    target: Vector3;
    minDistance: number;
    maxDistance: number;
    update: () => void;
  } | null;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);
  const ready = width > 0 && height > 0;

  useEffect(() => {
    if (!scene || !ready || scene.closedBounds.isEmpty()) return;
    const fit = fitCamera(scene.closedBounds, FOV, width / height);
    camera.position.copy(fit.position);
    if (camera instanceof PerspectiveCamera) {
      camera.near = fit.near;
      camera.far = fit.far;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(fit.target);
    if (controls) {
      controls.target.copy(fit.target);
      controls.minDistance = fit.minDistance;
      controls.maxDistance = fit.maxDistance;
      controls.update();
    }
    invalidate();
    // Перекадрируем только при смене модели или появлении размеров, не при каждом ресайзе.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, ready, controls]);
  return null;
}

/**
 * Лёгкое окружение для металла и зеркала: процедурная «комната» (без HDRI-файла),
 * генерируется на GPU один раз.
 */
function MetalEnvironment({ scene }: { scene: ProductScene | null }) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!scene) return;
    if (!scene.needsEnvironment) return;
    const pmrem = new PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    scene.setEnvironment(env);
    invalidate();
    return () => {
      scene.setEnvironment(null);
      env.dispose();
      room.dispose();
      pmrem.dispose();
    };
  }, [scene, gl, invalidate]);
  return null;
}

function Floor({ scene, mode }: { scene: ProductScene | null; mode: QualitySettings['shadows'] }) {
  if (!scene || scene.closedBounds.isEmpty() || mode === 'none') return null;
  const b = scene.closedBounds;
  const size = b.getSize(new Vector3());
  const c = b.getCenter(new Vector3());
  const span = Math.max(size.x, size.z) * 2.2;
  return (
    <ContactShadows
      position={[c.x, b.min.y + span * 0.0005, c.z]}
      scale={span}
      far={size.y * 0.6}
      blur={2.4}
      opacity={0.45}
      resolution={mode === 'static' ? 256 : 512}
      // 'static' — тень считается один раз: при вращении камеры сцена не рисуется второй раз.
      frames={mode === 'static' ? 1 : Infinity}
      color="#000000"
    />
  );
}

/**
 * Готовый 3D-просмотр для веба: Canvas, OrbitControls, мягкий свет без HDRI,
 * камера по размеру изделия, тап по двери/ящику — открыть/закрыть.
 */
export const ProductViewer = forwardRef<ProductHandle, ProductViewerProps>(function ProductViewer(
  {
    model,
    options,
    className,
    style,
    background,
    shadows,
    quality,
    dimensions,
    lightsOn,
    roomVisible,
    highlight,
    ghost,
    focusOnHighlight,
    toggleOnTap,
    onPartTap,
    onReady,
    fallback,
    children,
  },
  ref,
) {
  const [scene, setScene] = useState<ProductScene | null>(null);
  const level: QualityLevel = useMemo(
    () => (quality === 'auto' ? detectQuality() : quality ?? options?.quality ?? 'high'),
    [quality, options?.quality],
  );
  const settings = qualitySettings(level);
  const sceneOptions = useMemo(() => ({ ...options, quality: level }), [options, level]);
  const shadowMode: QualitySettings['shadows'] = shadows === false ? 'none' : shadows === true && settings.shadows === 'none' ? 'static' : settings.shadows;
  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%', touchAction: 'none', ...style }}>
      <Canvas
        frameloop="demand"
        dpr={[1, settings.maxPixelRatio]}
        flat
        camera={{ fov: FOV, near: 0.01, far: 100, position: [1, 1, 3] }}
        gl={{ antialias: settings.antialias, alpha: !background, powerPreference: 'default' }}
        onCreated={(state) => {
          if (background) state.gl.setClearColor(background, 1);
        }}
        fallback={fallback}
      >
        <hemisphereLight args={['#ffffff', '#c9c1b4', 1.15]} />
        <ambientLight intensity={0.25} />
        <directionalLight position={[2.5, 4, 3]} intensity={1.35} />
        <directionalLight position={[-3, 2.5, 1.5]} intensity={0.45} />
        <ProductObject
          ref={ref}
          model={model}
          options={sceneOptions}
          highlight={highlight}
          ghost={ghost}
          focusOnHighlight={focusOnHighlight}
          dimensions={dimensions}
          lightsOn={lightsOn}
          roomVisible={roomVisible}
          toggleOnTap={toggleOnTap}
          onPartTap={onPartTap}
          onReady={(s) => {
            setScene(s);
            onReady?.(s);
          }}
        />
        <Floor key={scene?.root.uuid ?? 'none'} scene={scene} mode={shadowMode} />
        <MetalEnvironment scene={scene} />
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.12}
          enablePan={false}
          maxPolarAngle={Math.PI * 0.55}
        />
        <AutoFit scene={scene} />
        {children}
      </Canvas>
    </div>
  );
});
