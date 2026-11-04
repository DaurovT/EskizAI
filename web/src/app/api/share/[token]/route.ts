import { NextResponse } from 'next/server';
import { getShare } from '@/lib/share-source';
import type { ShareError } from '@/lib/share-types';

export const dynamic = 'force-dynamic';

/** GET /api/share/{token} → SharePayload | ShareError (404, 410). */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const params = await ctx.params;
  const r = await getShare(params.token, new URL(req.url).searchParams.get('view'));
  if (!r.ok) {
    return NextResponse.json<ShareError>({ error: r.error }, { status: r.status });
  }
  return NextResponse.json(r.data, { headers: { 'cache-control': 'no-store' } });
}
