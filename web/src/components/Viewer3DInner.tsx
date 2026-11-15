'use client';

import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { useThree } from '@react-three/fiber';
import { Box3, PerspectiveCamera, Vector3 } from 'three';
import type { ProductScene, ViewerModel } from '@mebel/viewer';
import { ProductViewer, type ProductHandle } from '@mebel/viewer/react';
import { t } from '@/lib/i18n';
import type { Lang } from '@/lib/share-types';
import { IconDoor, IconExpand, IconRotate, IconRuler } from './icons';

class GlErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn('3D viewer failed', error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Поля кадра, px: снизу — панель кнопок, по бокам — подписи размеров (если включены). */
interface Insets {
  top: number;
  side: number;
  bottom: number;
}

const DEFAULT_DIR = new Vector3(0.42, 0.22, 1).normalize();
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * Кадр «по коробке», а не по описанной сфере (как AutoFit вьювера): изделие заметно крупнее.
 * Для каждой вершины габарита — расстояние, при котором она влезает в доступную часть экрана;
 * затем сдвиг вниз, чтобы изделие стояло по центру над панелью кнопок.
 */
function frameBox(bounds: Box3, fovDeg: number, w: number, h: number, dir: Vector3, ins: Insets) {
  const center = bounds.getCenter(new Vector3());
  const z = dir.clone().normalize();
  const x = new Vector3().crossVectors(WORLD_UP, z).normalize();
  const y = new Vector3().crossVectors(z, x);
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * (w / h);
  const ax = Math.max(0.3, (w - 2 * ins.side) / w);
  const ay = Math.max(0.3, (h - ins.top - ins.bottom) / h);
  let dist = 0;
  const p = new Vector3();
  for (const cx of [bounds.min.x, bounds.max.x])
    for (const cy of [bounds.min.y, bounds.max.y])
      for (const cz of [bounds.min.z, bounds.max.z]) {
        p.set(cx, cy, cz).sub(center);
        const pz = p.dot(z);
        dist = Math.max(dist, pz + Math.abs(p.dot(x)) / (tanH * ax), pz + Math.abs(p.dot(y)) / (tanV * ay));
      }
  dist = Math.max(dist, 1e-3);
  const shift = ((ins.bottom - ins.top) / h) * dist * tanV;
  const target = center.clone().addScaledVector(y, -shift);
  return { target, position: target.clone().addScaledVector(z, dist), dist };
}

type Orbit = { target: Vector3; minDistance: number; maxDistance: number; update: () => void };

/** Перекадрирует после AutoFit вьювера и при смене размера (на весь экран и обратно), сохраняя угол. */
function HeroFit({ scene, insets }: { scene: ProductScene | null; insets: Insets }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as Orbit | null;
  const w = useThree((s) => s.size.width);
  const h = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);
  const placed = useRef(false);
  const { top, side, bottom } = insets;

  useEffect(() => {
    if (!scene || w <= 0 || h <= 0 || scene.closedBounds.isEmpty() || !(camera instanceof PerspectiveCamera)) return;
    const dir = placed.current && controls ? camera.position.clone().sub(controls.target).normalize() : DEFAULT_DIR;
    const f = frameBox(scene.closedBounds, camera.fov, w, h, dir, { top, side, bottom });
    camera.position.copy(f.position);
    camera.near = f.dist / 25;
    camera.far = f.dist * 20;
    camera.updateProjectionMatrix();
    camera.lookAt(f.target);
    if (controls) {
      controls.target.copy(f.target);
      controls.minDistance = f.dist * 0.45;
      controls.maxDistance = f.dist * 2.4;
      controls.update();
      placed.current = true;
    }
    invalidate();
  }, [scene, camera, controls, w, h, top, side, bottom, invalidate]);
  return null;
}

const HINT_KEY = 'eskiz:hint3d';

/** Подсказка «Крутите пальцем» — пока клиент ни разу не тронул модель (запоминаем в браузере). */
function useHint(ready: boolean) {
  const [state, setState] = useState<'hidden' | 'shown' | 'fading'>('hidden');
  useEffect(() => {
    if (!ready) return;
    let seen = false;
    try {
      seen = window.localStorage.getItem(HINT_KEY) === '1';
    } catch {
      /* приватный режим */
    }
    if (!seen) setState('shown');
  }, [ready]);
  const dismiss = () => {
    if (state !== 'shown') return;
    setState('fading');
    window.setTimeout(() => setState('hidden'), 450);
    try {
      window.localStorage.setItem(HINT_KEY, '1');
    } catch {
      /* ignore */
    }
  };
  return [state, dismiss] as const;
}

interface Props {
  model: ViewerModel;
  lang: Lang;
  fullscreen: boolean;
  onFullscreen: () => void;
}

/** 3D-просмотр героя: модель, одна панель кнопок снизу (двери, размеры, на весь экран), подсказка. */
export default function Viewer3DInner({ model, lang, fullscreen, onFullscreen }: Props) {
  const ref = useRef<ProductHandle>(null);
  const [gl] = useState(webglAvailable);
  const [open, setOpen] = useState(false);
  const [dims, setDims] = useState(false);
  const [scene, setScene] = useState<ProductScene | null>(null);
  const [coarse, setCoarse] = useState(true);
  const [hint, dismissHint] = useHint(scene !== null);
  const hasNodes = model.nodes.length > 0;
  const fallback = <div className="stage-status">{t(lang, 'no3d')}</div>;

  useEffect(() => {
    setCoarse(window.matchMedia?.('(pointer: coarse)').matches ?? true);
  }, []);

  if (!gl) return fallback;

  // Панель — 44 px + отступ 12 px снизу; подписи размеров по бокам и сверху требуют больше поля
  const insets: Insets = {
    top: dims ? 40 : 18,
    side: dims ? 64 : 14,
    bottom: (fullscreen ? 92 : 72) + (dims ? 24 : 0),
  };

  return (
    <GlErrorBoundary fallback={fallback}>
      <div className="stage-canvas" onPointerDown={dismissHint}>
        <ProductViewer ref={ref} model={model} fallback={fallback} dimensions={dims} onReady={setScene}>
          <HeroFit scene={scene} insets={insets} />
        </ProductViewer>
      </div>

      {hint !== 'hidden' && (
        <div className={hint === 'fading' ? 'hint3d out' : 'hint3d'} aria-hidden="true">
          <IconRotate size={20} />
          {t(lang, coarse ? 'hintTouch' : 'hintMouse')}
        </div>
      )}

      <div className="pillbar" role="toolbar" aria-label="3D" onPointerDownCapture={dismissHint}>
        {hasNodes && (
          <button
            type="button"
            className="pill"
            aria-pressed={open}
            aria-label={t(lang, open ? 'doorsCloseAria' : 'doorsOpenAria')}
            onClick={() => {
              const next = !open;
              setOpen(next);
              if (next) ref.current?.openAll();
              else ref.current?.closeAll();
            }}
          >
            <IconDoor size={18} />
            {t(lang, 'doors')}
          </button>
        )}
        <button type="button" className="pill" aria-pressed={dims} onClick={() => setDims((v) => !v)}>
          <IconRuler size={18} />
          {t(lang, 'dims')}
        </button>
        {!fullscreen && (
          <button type="button" className="pill ic" aria-label={t(lang, 'fullscreen')} title={t(lang, 'fullscreen')} onClick={onFullscreen}>
            <IconExpand size={19} />
          </button>
        )}
      </div>
    </GlErrorBoundary>
  );
}
