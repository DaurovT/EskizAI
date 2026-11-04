import { initials } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { Lang, ShareMaster } from '@/lib/share-types';
import { IconPhone, IconTelegram } from './icons';

export function telegramUrl(username: string): string {
  return `https://t.me/${encodeURIComponent(username.replace(/^@/, ''))}`;
}

/** Название цеха для шапки: цех, иначе имя мастера. */
export function workshopName(m: ShareMaster): string {
  return m.workshop || m.name;
}

/** Круглый логотип цеха: картинка (Pro) или инициалы. */
export function WorkshopLogo({ master }: { master: ShareMaster }) {
  return (
    <span className="logo" aria-hidden="true">
      {master.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={master.logoUrl} alt="" />
      ) : (
        initials(workshopName(master))
      )}
    </span>
  );
}

/** «Позвонить» + «Telegram» — две кнопки в ряд (или одна, если Telegram нет). */
export function ContactButtons({ master, lang }: { master: ShareMaster; lang: Lang }) {
  return (
    <div className="fr">
      {master.phone && (
        <a className="soft" href={`tel:${master.phone}`}>
          <IconPhone />
          {t(lang, 'call')}
        </a>
      )}
      {master.telegram && (
        <a className="soft" href={telegramUrl(master.telegram)} target="_blank" rel="noopener noreferrer">
          <IconTelegram />
          {t(lang, 'telegram')}
        </a>
      )}
    </div>
  );
}
