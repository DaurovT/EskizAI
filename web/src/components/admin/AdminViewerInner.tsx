'use client';

import { Component, useRef, useState, type ReactNode } from 'react';
import type { ViewerModel } from '@mebel/viewer';
import { ProductViewer, type ProductHandle } from '@mebel/viewer/react';

class GlErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
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

/** 3D-модель версии в админке (тот же viewer, что у ссылки клиента). */
export default function AdminViewerInner({ model }: { model: ViewerModel }) {
  const ref = useRef<ProductHandle>(null);
  const [gl] = useState(webglAvailable);
  const [exploded, setExploded] = useState(false);
  const fallback = <div className="muted" style={{ padding: 16 }}>3D недоступно в этом браузере</div>;
  if (!gl) return fallback;
  return (
    <GlErrorBoundary fallback={fallback}>
      <ProductViewer ref={ref} model={model} fallback={fallback} />
      <div className="ctl">
        {model.nodes.length > 0 && (
          <>
            <button type="button" className="b" onClick={() => ref.current?.openAll()}>
              Открыть всё
            </button>
            <button type="button" className="b" onClick={() => ref.current?.closeAll()}>
              Закрыть
            </button>
          </>
        )}
        <button
          type="button"
          className="b"
          onClick={() => {
            setExploded(!exploded);
            ref.current?.explode(!exploded);
          }}
        >
          {exploded ? 'Собрать' : 'Разобрать'}
        </button>
      </div>
    </GlErrorBoundary>
  );
}
