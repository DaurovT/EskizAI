'use client';

/**
 * Картинка из API. Файлы кабинета (вложения переписки, фото возвратов) отдаются только с токеном —
 * <img src> его не передаёт, поэтому такие грузим fetch → blob. Публичные (/media, полный URL) — напрямую.
 */
import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/staff/client';
import { useClient } from '@/lib/staff/hooks';

function isPublic(url: string): boolean {
  // /signed-files/{token} — подписанная ссылка, открывается без токена входа
  return (
    /^https?:\/\//.test(url) ||
    url.startsWith('/media/') ||
    url.startsWith('/signed-files/') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  );
}

export function AuthImg({ url, alt = '', style, className }: { url: string; alt?: string; style?: React.CSSProperties; className?: string }) {
  const client = useClient();
  const [src, setSrc] = useState<string | null>(isPublic(url) ? apiUrl(url) : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isPublic(url)) {
      setSrc(apiUrl(url));
      return;
    }
    let alive = true;
    let objectUrl: string | null = null;
    client
      .raw(url)
      .then((r) => r.blob())
      .then((b) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(b);
        setSrc(objectUrl);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, url]);

  if (failed) return <span className="muted">[фото недоступно]</span>;
  if (!src) return <span className="muted" style={style}>…</span>;
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        // blob: открываем вручную — иначе некоторые браузеры блокируют
        if (src.startsWith('blob:')) {
          e.preventDefault();
          window.open(src, '_blank');
        }
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} style={style} className={className} />
    </a>
  );
}
