import { NextResponse } from 'next/server';
import { FEEDBACK_MAX_CHARS, type ShareFeedbackBody, type ShareFeedbackResponse } from '@/lib/share-types';

/**
 * POST /api/share/{token}/feedback — клиент нажал «Хочу изменить…» и написал, что поменять.
 * Бэкенд: событие ссылки change_request + push мастеру «Клиент просит изменить: …» (лимит по ссылке и IP).
 * Мок (без SHARE_API_URL): только лог.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const params = await ctx.params;
  let body: ShareFeedbackBody;
  try {
    body = (await req.json()) as ShareFeedbackBody;
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > FEEDBACK_MAX_CHARS) {
    return NextResponse.json({ error: 'bad_text' }, { status: 422 });
  }
  const base = process.env.SHARE_API_URL;
  if (base) {
    // IP клиента — для лимита «с одного адреса» (api за uvicorn --proxy-headers); иначе все клиенты — один IP web
    const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || '';
    const res = await fetch(`${base}/share/${encodeURIComponent(params.token)}/feedback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': req.headers.get('user-agent') ?? '',
        ...(forwarded ? { 'x-forwarded-for': forwarded } : {}),
      },
      body: JSON.stringify({ text }),
      cache: 'no-store',
    });
    if (res.status === 404 || res.status === 410 || res.status === 429 || res.status === 422) {
      const err = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      return NextResponse.json({ error: err?.error?.code ?? 'upstream' }, { status: res.status });
    }
    if (!res.ok) return NextResponse.json({ error: 'upstream' }, { status: 502 });
    return NextResponse.json<ShareFeedbackResponse>((await res.json()) as ShareFeedbackResponse, { status: 201 });
  }
  console.log(`[share-feedback] token=${params.token} text=${JSON.stringify(text.slice(0, 200))}`);
  return NextResponse.json<ShareFeedbackResponse>({ sentAt: new Date().toISOString() }, { status: 201 });
}
