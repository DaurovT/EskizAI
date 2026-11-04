import { NextResponse } from 'next/server';
import { mockAgree } from '@/lib/mock-share';
import type { AgreeResponse } from '@/lib/share-types';

/**
 * POST /api/share/{token}/agree — клиент нажал «Согласен» (FR-55).
 * Мок: запоминаем в памяти процесса. Бэкенд: отметка в проекте + push мастеру.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const params = await ctx.params;
  const base = process.env.SHARE_API_URL;
  if (base) {
    // Бэкенд: POST {SHARE_API_URL}/share/{token}/agree → { agreedAt }
    const res = await fetch(`${base}/share/${encodeURIComponent(params.token)}/agree`, { method: 'POST', cache: 'no-store' });
    if (res.status === 404 || res.status === 410) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      const error = res.status === 404 ? 'not_found' : body?.error?.code === 'share_revoked' ? 'revoked' : 'expired';
      return NextResponse.json({ error }, { status: res.status });
    }
    if (!res.ok) return NextResponse.json({ error: 'upstream' }, { status: 502 });
    return NextResponse.json<AgreeResponse>((await res.json()) as AgreeResponse);
  }
  const at = mockAgree(params.token);
  if (!at) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  console.log(`[share-agree] token=${params.token} at=${at}`);
  return NextResponse.json<AgreeResponse>({ agreedAt: at });
}
