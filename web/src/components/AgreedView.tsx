'use client';

import Link from 'next/link';
import { formatDay, formatSize } from '@/lib/format';
import { t, tl } from '@/lib/i18n';
import type { Lang, SharePayload } from '@/lib/share-types';
import { IconCheck } from './icons';
import { ContactButtons } from './MasterCard';
import { TotalAmount } from './PriceBlock';
import { useLang } from './useLang';

const FACADE_ROLES = new Set(['door', 'drawer_front', 'facade', 'sliding_fill', 'front']);

/** Материал фасада из viewer model: самый частый у дверей и фасадов, без «ЛДСП 18». */
function facadeName(data: SharePayload): string | null {
  const count = new Map<string, number>();
  for (const p of data.model.parts) {
    if (FACADE_ROLES.has(p.role)) count.set(p.material, (count.get(p.material) ?? 0) + 1);
  }
  let best: string | null = null;
  let max = 0;
  for (const [k, n] of count) if (n > max) [best, max] = [k, n];
  const raw = best ? data.model.materials[best]?.name : undefined;
  if (!raw) return null;
  const name = raw.replace(/^(ЛДСП|ЛМДФ|МДФ|ХДФ|ДСП|ДВП)\s*\d*(?:[.,]\d+)?\s*/i, '').trim() || raw;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** WEB-2: клиент согласовал — «Мастер получил ваш ответ» (макет ClientAgreed). */
export function AgreedView({ data, initialLang }: { data: SharePayload; initialLang: Lang }) {
  const [lang] = useLang(data.token, initialLang);
  const m = data.master;
  const who = m.workshop && m.name !== m.workshop ? t(lang, 'whoFrom', { name: m.name, workshop: m.workshop }) : m.name;
  const facade = facadeName(data);
  const est = data.estimate;
  const [l1, l2] = t(lang, 'agreedTitle').split('\n');
  const when = data.agreedAt ? formatDay(data.agreedAt, lang, true) : null;
  const note = [when, est && !est.exact ? t(lang, 'afterMeasure') : null].filter(Boolean).join(' · ');

  return (
    <main className="ek">
      <div className="body" style={{ padding: '36px 12px 12px', gap: 12 }}>
        <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="ok-big" aria-hidden="true">
            <IconCheck size={38} sw={2.8} />
          </div>
          <h1 className="h-big">
            {l1}
            {l2 && <br />}
            {l2}
          </h1>
          <p className="sub" style={{ color: 'var(--muted-2)' }}>{t(lang, 'agreedText', { who })}</p>
        </div>
        <section className="sheet" style={{ padding: '18px 20px 16px' }}>
          <h2 style={{ fontSize: 18, lineHeight: '24px', fontWeight: 700, marginBottom: 6 }}>{t(lang, 'youAgreed')}</h2>
          <div className="pl ag">
            <span>{tl(lang, data.project.title)}</span>
            <span className="mono" style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{formatSize(data.project.sizeMm)}</span>
          </div>
          {facade && (
            <div className="pl ag">
              <span>{t(lang, 'facade')}</span>
              <span style={{ fontWeight: 500 }}>{facade}</span>
            </div>
          )}
          {est && (
            <div className="pl ag" style={{ alignItems: 'center' }}>
              <span>{t(lang, est.exact ? 'price' : 'priceBefore')}</span>
              <span className="ag-total">
                <TotalAmount value={est.total} exact={est.exact} lang={lang} />
              </span>
            </div>
          )}
          {note && <div className="cap" style={{ marginTop: 8 }}>{note}</div>}
        </section>
      </div>
      {/* Снизу место строки-пояснения макета (push мастеру) — кнопки стоят как в макете */}
      <div className="foot" style={{ gap: 4, paddingBottom: 'max(74px, calc(env(safe-area-inset-bottom) + 56px))' }}>
        <div style={{ marginBottom: 4 }}>
          <ContactButtons master={m} lang={lang} />
        </div>
        <Link className="txt" href={`/p/${encodeURIComponent(data.token)}?lang=${lang}`}>
          {t(lang, 'view3dAgain')}
        </Link>
      </div>
    </main>
  );
}
