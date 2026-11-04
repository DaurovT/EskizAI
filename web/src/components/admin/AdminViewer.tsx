'use client';

import dynamic from 'next/dynamic';
import type { ViewerModel } from '@mebel/viewer';

const Inner = dynamic(() => import('./AdminViewerInner'), {
  ssr: false,
  loading: () => <div className="muted" style={{ padding: 16 }}>Загрузка 3D…</div>,
});

export function AdminViewer({ model }: { model: ViewerModel }) {
  return (
    <div className="viewer3d">
      <Inner model={model} />
    </div>
  );
}
