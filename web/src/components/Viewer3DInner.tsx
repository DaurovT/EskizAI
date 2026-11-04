'use client';

import { Component, useRef, useState, type ReactNode } from 'react';
import type { ViewerModel } from '@mebel/viewer';
import { ProductViewer, type ProductHandle } from '@mebel/viewer/react';
import { t } from '@/lib/i18n';
import type { Lang } from '@/lib/share-types';

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

/** 3D-просмотр с кнопками макета. Грузится только на клиенте (next/dynamic, ssr: false). */
export default function Viewer3DInner({ model, lang }: { model: ViewerModel; lang: Lang }) {
  const ref = useRef<ProductHandle>(null);
  const [gl] = useState(webglAvailable);
  const [open, setOpen] = useState(false);
  const [dims, setDims] = useState(false);
  const hasNodes = model.nodes.length > 0;
  const fallback = <div className="stage-status">{t(lang, 'no3d')}</div>;

  const tools = (
    <div className="stage-tools">
      {hasNodes && (
        <button
          type="button"
          className="vw"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) ref.current?.openAll();
            else ref.current?.closeAll();
          }}
        >
          {t(lang, open ? 'closeDoors' : 'openDoors')}
        </button>
      )}
      <button type="button" className="vw" aria-pressed={dims} onClick={() => setDims((v) => !v)}>
        {t(lang, 'dims')}
      </button>
    </div>
  );

  if (!gl) return fallback;

  return (
    <GlErrorBoundary fallback={fallback}>
      <ProductViewer ref={ref} model={model} fallback={fallback} dimensions={dims} />
      {tools}
    </GlErrorBoundary>
  );
}
