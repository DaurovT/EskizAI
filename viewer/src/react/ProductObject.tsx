import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { PerspectiveCamera, Vector3 } from 'three';
import { ProductScene, type HighlightOptions, type HighlightTarget, type ProductSceneOptions } from '../product.js';
import type { PickResult, ViewerModel } from '../types.js';

/** Управление сценой снаружи (кнопки «Открыть всё», «Размеры», «Разобрать на детали» и т. п.). */
export interface ProductHandle {
  readonly scene: ProductScene | null;
  openAll(): void;
  closeAll(): void;
  openNode(id: string): void;
  closeNode(id: string): void;
  toggleNode(id: string): void;
  explode(on: boolean): void;
  /** Подсветить деталь / узел / секцию (номер, ключ, префикс ключа, id узла). null — снять. */
  highlight(target: HighlightTarget | null, options?: HighlightOptions): void;
  clearHighlight(): void;
  /** Плавно навести камеру на цель; без цели — на всё изделие. */
  focus(target?: HighlightTarget | null): void;
  showDimensions(on: boolean): void;
  toggleDimensions(): boolean;
  /** LED-подсветка вкл/выкл; при включении свет сцены приглушается («вечер»). */
  setLightsOn(on: boolean): void;
  /** Комната (стены, пол, потолок встроенной мебели) вкл/выкл. */
  setRoomVisible(on: boolean): void;
}

export interface ProductObjectProps {
  model: ViewerModel;
  options?: ProductSceneOptions;
  /** Тап по двери/ящику открывает и закрывает его. По умолчанию true. */
  toggleOnTap?: boolean;
  /** Тап по любой детали (после переключения узла). */
  onPartTap?: (pick: PickResult) => void;
  /** Сцена построена (и при каждой пересборке модели). */
  onReady?: (scene: ProductScene) => void;
  /** Подсветка (декларативно). Переживает пересборку сцены. */
  highlight?: HighlightTarget | null;
  /** «Рентген» вокруг подсвеченного: остальные детали полупрозрачные. */
  ghost?: boolean;
  /** Навести камеру на подсвеченное при смене highlight. */
  focusOnHighlight?: boolean;
  /** Показать размеры (декларативно). */
  dimensions?: boolean;
  /** LED-подсветка (декларативно): включена — светится, сцена приглушена. Переживает пересборку. */
  lightsOn?: boolean;
  /** Комната (если есть в модели): показать/скрыть. По умолчанию показана. */
  roomVisible?: boolean;
}

/** Порог сдвига пальца (px), после которого это вращение камеры, а не тап. */
const TAP_SLOP = 8;
const FOCUS_DURATION = 0.6;

interface ControlsLike {
  target: Vector3;
  update: () => void;
}

interface FocusTween {
  fromPos: Vector3;
  toPos: Vector3;
  fromTarget: Vector3;
  toTarget: Vector3;
  t: number;
}

/** Ключ опций для useMemo: текстуры заменяем на uuid (их нельзя сериализовать целиком). */
function optionsKeyOf(options: ProductSceneOptions | undefined): string {
  return JSON.stringify(options ?? {}, (_k, v: unknown) => {
    if (v && typeof v === 'object' && (v as { isTexture?: boolean }).isTexture) return `texture:${(v as { uuid: string }).uuid}`;
    if (typeof v === 'function') return 'fn';
    return v;
  });
}

/**
 * Изделие внутри любого <Canvas> react-three-fiber. Без DOM-кода:
 * подходит и для веба, и для @react-three/fiber/native.
 */
export const ProductObject = forwardRef<ProductHandle, ProductObjectProps>(function ProductObject(
  { model, options, toggleOnTap = true, onPartTap, onReady, highlight, ghost, focusOnHighlight, dimensions, lightsOn, roomVisible },
  ref,
) {
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  const threeScene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as ControlsLike | null;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const optionsKey = optionsKeyOf(options);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const product = useMemo(() => new ProductScene(model, options), [model, optionsKey]);
  const tween = useRef<FocusTween | null>(null);

  // Прежняя сцена освобождается только после первого кадра новой: её материалы держат программы GL, и новые
  // материалы с тем же ключом берут их из кэша three — без перекомпиляции шейдеров (на iPhone — рывок после правки)
  const retired = useRef<ProductScene[]>([]);
  /** Сцена, для которой уже собраны шейдеры подсветки и «рентгена». */
  const warmed = useRef<ProductScene | null>(null);
  useEffect(() => {
    onReady?.(product);
    invalidate();
    return () => {
      retired.current.push(product);
      invalidate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product]);
  useEffect(() => () => {
    for (const s of retired.current) s.dispose();
    retired.current = [];
  }, []);

  const focus = (target: HighlightTarget | null = null) => {
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 40;
    const aspect = height > 0 ? width / height : 1;
    const currentTarget = controls?.target.clone() ?? product.closedBounds.getCenter(new Vector3());
    // Сохраняем угол обзора, меняем только кадр.
    const dir = camera.position.clone().sub(currentTarget);
    if (dir.lengthSq() < 1e-12) dir.set(0.45, 0.28, 1);
    const fit = product.frameTarget(target, fov, aspect, dir);
    if (!fit) return;
    tween.current = {
      fromPos: camera.position.clone(),
      toPos: fit.position,
      fromTarget: currentTarget,
      toTarget: fit.target,
      t: 0,
    };
    invalidate();
  };

  const highlightKey = JSON.stringify(highlight ?? null);
  useEffect(() => {
    if (highlight === undefined) return;
    product.highlight(highlight, { ghost });
    if (focusOnHighlight) focus(highlight);
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product, highlightKey, ghost, focusOnHighlight]);

  useEffect(() => {
    if (dimensions === undefined) return;
    product.showDimensions(dimensions);
    invalidate();
  }, [product, dimensions, invalidate]);

  useEffect(() => {
    if (lightsOn === undefined) return;
    product.setLightsOn(lightsOn);
    invalidate();
  }, [product, lightsOn, invalidate]);

  useEffect(() => {
    if (roomVisible === undefined) return;
    product.setRoomVisible(roomVisible);
    invalidate();
  }, [product, roomVisible, invalidate]);

  useImperativeHandle(
    ref,
    () => {
      const run = (fn: () => void) => {
        fn();
        invalidate();
      };
      return {
        scene: product,
        openAll: () => run(() => product.openAll()),
        closeAll: () => run(() => product.closeAll()),
        openNode: (id) => run(() => product.openNode(id)),
        closeNode: (id) => run(() => product.closeNode(id)),
        toggleNode: (id) => run(() => product.toggleNode(id)),
        explode: (on) => run(() => product.explode(on)),
        highlight: (target, opts) => run(() => product.highlight(target, opts)),
        clearHighlight: () => run(() => product.clearHighlight()),
        focus: (target) => focus(target ?? null),
        showDimensions: (on) => run(() => product.showDimensions(on)),
        setLightsOn: (on) => run(() => product.setLightsOn(on)),
        setRoomVisible: (on) => run(() => product.setRoomVisible(on)),
        toggleDimensions: () => {
          const on = product.toggleDimensions();
          invalidate();
          return on;
        },
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [product, invalidate, camera, controls, width, height],
  );

  useFrame((_, delta) => {
    // кадр с новой сценой сейчас отрисуется; сразу после него — прогреть её шейдеры подсветки (пока старая сцена жива,
    // программы берутся из кэша) и освободить старую
    if (retired.current.length || warmed.current !== product) {
      const old = retired.current;
      retired.current = [];
      const fresh = warmed.current !== product ? product : null;
      warmed.current = product;
      setTimeout(() => {
        if (fresh) fresh.warmup(gl, camera, threeScene);
        for (const s of old) s.dispose();
      }, 0);
    }
    // В режиме frameloop="demand" delta копится между кадрами — ограничиваем.
    const dt = Math.min(delta, 1 / 30);
    let moving = product.update(dt);
    const tw = tween.current;
    if (tw) {
      tw.t = Math.min(1, tw.t + dt / FOCUS_DURATION);
      const k = tw.t * tw.t * (3 - 2 * tw.t);
      camera.position.lerpVectors(tw.fromPos, tw.toPos, k);
      const target = new Vector3().lerpVectors(tw.fromTarget, tw.toTarget, k);
      if (controls) {
        controls.target.copy(target);
        controls.update();
      } else {
        camera.lookAt(target);
      }
      if (tw.t >= 1) tween.current = null;
      moving = true;
    }
    if (moving) invalidate();
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > TAP_SLOP) return;
    // Деталь или фурнитура (тогда — с деталью-«родителем»: тап по ручке открывает дверь)
    const pick = product.pickFromObject(e.object, e.point, e.distance, e.faceIndex);
    if (!pick) return;
    e.stopPropagation();
    if (toggleOnTap && pick.node) {
      product.toggleNode(pick.node);
      invalidate();
    }
    onPartTap?.(pick);
  };

  return <primitive object={product.root} onClick={handleClick} />;
});
