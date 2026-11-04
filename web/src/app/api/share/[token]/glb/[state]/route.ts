import { exportGlb, type GlbState } from '@mebel/viewer/export';
import { getShare } from '@/lib/share-source';

export const runtime = 'nodejs';

/** Кэш на процесс: GLB строится один раз на (токен, версия модели, состояние). */
const cache = new Map<string, ArrayBuffer>();

/**
 * GET /api/share/{token}/glb/{closed|open} → model/gltf-binary (метры).
 * Временно: GLB строит этот же three.js-код. Потом GLB будет отдавать сервер
 * (S3), а в SharePayload.glb придут его URL.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string; state: string }> }) {
  const params = await ctx.params;
  const state = params.state.replace(/\.glb$/, '') as GlbState;
  if (state !== 'closed' && state !== 'open') return new Response('bad state', { status: 400 });
  const r = await getShare(params.token);
  if (!r.ok) return new Response(r.error, { status: r.status });
  const key = `${params.token}:${r.data.project.modelVersion}:${state}`;
  let glb = cache.get(key);
  if (!glb) {
    glb = await exportGlb(r.data.model, state);
    cache.set(key, glb);
  }
  return new Response(glb, {
    headers: {
      'content-type': 'model/gltf-binary',
      'content-length': String(glb.byteLength),
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
      'content-disposition': `inline; filename="${params.token}-${state}.glb"`,
    },
  });
}
