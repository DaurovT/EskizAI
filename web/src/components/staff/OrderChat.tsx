'use client';

/**
 * Переписка по заказу (§5.2, §5.4 order_messages): мастер ↔ поставщик, сообщения платформы.
 * basePath — `/vendor/orders/{id}/messages` или `/admin/orders/{id}/messages`.
 * POST — multipart: text + files (несколько). markRead — POST {basePath}/read после загрузки.
 */
import { useEffect, useRef, useState } from 'react';
import { Empty, Loading, Msg } from '@/components/admin/ui';
import { dt } from '@/lib/admin/format';
import { itemsOf } from '@/lib/staff/client';
import { AuthImg } from './AuthImg';
import { useAction, useApi, useClient } from '@/lib/staff/hooks';

export interface Attachment {
  id?: string;
  name?: string;
  url?: string;
  content_type?: string | null;
  size?: number | null;
}

export interface OrderMessage {
  id: string;
  author_type: 'master' | 'vendor' | 'platform' | string;
  author_id?: string | null;
  author_name?: string | null;
  text?: string | null;
  attachments?: (Attachment | string)[];
  created_at: string;
  read_by_master_at?: string | null;
  read_by_vendor_at?: string | null;
}

const AUTHOR: Record<string, string> = { master: 'Мастер', vendor: 'Поставщик', platform: 'Платформа' };

function isImage(a: Attachment): boolean {
  return Boolean(a.content_type?.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic)$/i.test(a.name ?? a.url ?? ''));
}

export function OrderChat({
  basePath,
  self,
  canWrite = true,
  markRead = false,
  onRead,
  poll = 20000,
}: {
  basePath: string;
  /** Кто пишет из этого кабинета: сообщения справа. */
  self: 'vendor' | 'platform';
  canWrite?: boolean;
  markRead?: boolean;
  onRead?: () => void;
  poll?: number;
}) {
  const client = useClient();
  const { data, error, loading, reload } = useApi<OrderMessage[] | { items: OrderMessage[] }>(basePath);
  const act = useAction();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const rows = itemsOf(data);
  const last = rows[rows.length - 1]?.id;

  useEffect(() => {
    // Прокручиваем только ленту, не всю страницу
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    if (!markRead || !last) return;
    const unread = rows.some((m) => m.author_type === 'master' && !m.read_by_vendor_at);
    if (unread) void client.post(`${basePath}/read`).then(() => onRead?.(), () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last]);

  useEffect(() => {
    if (!poll) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, poll);
    return () => clearInterval(t);
  }, [poll, reload]);

  async function send() {
    const ok = await act.run(async () => {
      const form = new FormData();
      form.append('text', text.trim());
      files.forEach((f) => form.append('files', f));
      await client.api(basePath, { method: 'POST', body: form });
    });
    if (ok) {
      setText('');
      setFiles([]);
      if (fileRef.current) fileRef.current.value = '';
      reload();
    }
  }

  return (
    <>
      <Loading error={error} loading={loading && !data} />
      {data && rows.length === 0 && <Empty>Сообщений пока нет</Empty>}
      <div className="thread" ref={threadRef}>
        {rows.map((m) => {
          const atts = (m.attachments ?? []).map((a) => (typeof a === 'string' ? { url: a, name: a.split('/').pop() } : a));
          return (
            <div key={m.id} className={`m ${m.author_type === self ? 'vendor' : m.author_type === 'platform' ? 'platform' : ''}`}>
              <div className="meta">
                {m.author_name ? `${m.author_name} · ` : ''}
                {AUTHOR[m.author_type] ?? m.author_type} · {dt(m.created_at)}
                {m.author_type !== 'master' && m.read_by_master_at ? ' · прочитано' : ''}
              </div>
              {m.text && <div className="txt">{m.text}</div>}
              {atts.length > 0 && (
                <div className="photos" style={{ marginTop: 6 }}>
                  {atts.map((a, i) =>
                    a.url && isImage(a) ? (
                      <AuthImg key={a.id ?? i} url={a.url} alt={a.name ?? ''} style={{ height: 90 }} />
                    ) : (
                      <button
                        key={a.id ?? i}
                        type="button"
                        className="b"
                        disabled={!a.url}
                        onClick={() => a.url && void act.run(() => client.download(a.url!, a.name ?? 'file'))}
                      >
                        📎 {a.name ?? 'файл'}
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Msg message={act.message} />
      {canWrite && (
        <form
          className="toolbar"
          style={{ marginTop: 10, alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() || files.length) void send();
          }}
        >
          <textarea
            rows={2}
            style={{ flex: '1 1 260px' }}
            placeholder={self === 'platform' ? 'Сообщение от имени платформы — увидят мастер и поставщик' : 'Сообщение мастеру'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (text.trim() || files.length) void send();
              }
            }}
          />
          <input ref={fileRef} type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          <button className="b primary" type="submit" disabled={act.busy || (!text.trim() && !files.length)}>
            Отправить
          </button>
        </form>
      )}
    </>
  );
}
