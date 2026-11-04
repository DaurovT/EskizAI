import { t } from '@/lib/i18n';
import type { Lang, ShareMaster } from '@/lib/share-types';
import { EskizMark, IconClock, IconLock, IconPhone, IconSearch, IconTelegram } from './icons';
import { telegramUrl, WorkshopLogo, workshopName } from './MasterCard';

type Kind = 'not_found' | 'expired' | 'revoked';

const COPY: Record<Kind, { title: 'expiredTitle' | 'revokedTitle' | 'notFoundTitle'; text: 'expiredText' | 'revokedText' | 'notFoundText' }> = {
  expired: { title: 'expiredTitle', text: 'expiredText' },
  revoked: { title: 'revokedTitle', text: 'revokedText' },
  not_found: { title: 'notFoundTitle', text: 'notFoundText' },
};

/**
 * WEB-3: ссылка недоступна — срок истёк / мастер закрыл / не найдена (макет ClientExpired).
 * Карточка цеха и кнопки — если контакты мастера известны (мок или error.details.master).
 */
export function StatusScreen({ kind, lang = 'ru', master }: { kind: Kind; lang?: Lang; master?: ShareMaster }) {
  const c = COPY[kind];
  const badgeColor = kind === 'revoked' ? '#C62A20' : kind === 'expired' ? '#8A4B00' : '#55524D';
  const sub = master ? [master.city, master.workshop && master.name !== master.workshop ? t(lang, 'masterIs', { name: master.name }) : null].filter(Boolean).join(' · ') : '';
  const askHref = master?.telegram ? telegramUrl(master.telegram) : master?.phone ? `sms:${master.phone}` : null;
  return (
    <main className="ek">
      {/* paddingTop 60 = отступ body 8 + место переключателя-демо макета (52) */}
      <div className="body" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 14, paddingTop: 60 }}>
        <div className="ill">
          <div className="carc" style={{ width: 58, height: 70, borderRadius: '0 22px 0 0', padding: 2, opacity: 0.35 }} aria-hidden="true">
            <i className="wood" />
            <i className="wood" />
            <i className="wood" style={{ borderRadius: '0 19px 0 0' }} />
          </div>
          <span className="badge" style={{ color: badgeColor }}>
            {kind === 'expired' ? <IconClock /> : kind === 'revoked' ? <IconLock /> : <IconSearch />}
          </span>
        </div>
        <h1 className="h-st" style={{ marginTop: 6 }}>{t(lang, c.title)}</h1>
        <p className="cap" style={{ fontSize: 15, lineHeight: '21px', maxWidth: 310 }}>{t(lang, c.text)}</p>
        {master && (
          <div className="sheet" style={{ width: '100%', marginTop: 8, textAlign: 'left' }}>
            <div className="row" style={{ minHeight: 64 }}>
              <WorkshopLogo master={master} />
              <div className="tx">
                <div className="rt" style={{ fontWeight: 600 }}>{workshopName(master)}</div>
                {sub && <div className="rs">{sub}</div>}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="foot">
        {askHref && (
          <a className="cta" href={askHref} target={master?.telegram ? '_blank' : undefined} rel="noopener noreferrer">
            <IconTelegram />
            {t(lang, 'askNewLink')}
          </a>
        )}
        {master?.phone && (
          <a className="soft" href={`tel:${master.phone}`}>
            <IconPhone />
            {t(lang, 'callMaster')}
          </a>
        )}
        <div className="cap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 4 }}>
          <EskizMark />
          {t(lang, 'madeIn')}
        </div>
      </div>
    </main>
  );
}
