import { NextResponse } from 'next/server';
import type { ShareEvent, ShareEventBody } from '@/lib/share-types';

const EVENTS: ShareEvent[] = ['opened', 'ar_started', 'ar_failed', 'agreed'];

/**
 * POST /api/share/{token}/events — заглушка аналитики (FR-21).
 * Пока только пишем в лог сервера; бэкенд будет сохранять и слать push мастеру.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const params = await ctx.params;
  let body: ShareEventBody;
  try {
    body = (await req.json()) as ShareEventBody;
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }
  if (!EVENTS.includes(body.event)) {
    return NextResponse.json({ error: 'bad_event' }, { status: 400 });
  }
  const base = process.env.SHARE_API_URL;
  if (base) {
    // Бэкенд: POST {SHARE_API_URL}/share/{token}/events {event, at, meta?} → 204
    const res = await fetch(`${base}/share/${encodeURIComponent(params.token)}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': req.headers.get('user-agent') ?? '' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    return new NextResponse(null, { status: res.ok ? 204 : res.status });
  }
  console.log(`[share-event] token=${params.token} event=${body.event} at=${body.at} meta=${JSON.stringify(body.meta ?? {})}`);
  return new NextResponse(null, { status: 204 });
}
