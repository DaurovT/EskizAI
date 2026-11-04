import { formatAmount, formatDay } from '@/lib/format';
import { coreName, t } from '@/lib/i18n';
import type { ClientEstimate, Lang, SumRange } from '@/lib/share-types';

function Line({ name, value, exact, lang }: { name: string; value: SumRange; exact: boolean; lang: Lang }) {
  return (
    <div className="pl">
      <span>{name}</span>
      <span className="mono">{formatAmount(value, lang, exact)}</span>
    </div>
  );
}

/** Сумма итога: крупно + «сум» серым (как в макете). */
export function TotalAmount({ value, exact, lang }: { value: SumRange; exact: boolean; lang: Lang }) {
  return (
    <span className="mono">
      {formatAmount(value, lang, exact)} <span className="unit">{t(lang, 'sum')}</span>
    </span>
  );
}

/**
 * Смета для клиента в виде, который выбрал мастер (итог / кратко / подробно).
 * Показываем только то, что пришло с сервера: наценки, поставщика и комиссии в данных нет.
 */
export function PriceBlock({ estimate, priceDate, lang }: { estimate: ClientEstimate | null; priceDate: string | null; lang: Lang }) {
  if (!estimate) {
    return (
      <section className="sheet est">
        <p className="cap" style={{ padding: '5px 0' }}>{t(lang, 'priceHidden')}</p>
      </section>
    );
  }
  const { exact } = estimate;
  const requests = estimate.view === 'detailed' ? estimate.requests ?? [] : [];
  const onlyTotal = estimate.view === 'total';

  return (
    <section className="sheet est" aria-label={t(lang, 'total')}>
      {estimate.view === 'short' && estimate.materials && estimate.work && (
        <>
          <Line name={t(lang, 'materials')} value={estimate.materials} exact={exact} lang={lang} />
          <Line name={t(lang, 'labor')} value={estimate.work} exact={exact} lang={lang} />
        </>
      )}

      {estimate.view === 'detailed' && (
        <>
          {(estimate.groups ?? []).map((g) => (
            <Line key={g.name} name={coreName(lang, g.name)} value={g} exact={exact} lang={lang} />
          ))}
          {estimate.work && <Line name={t(lang, 'labor')} value={estimate.work} exact={exact} lang={lang} />}
          {requests.length > 0 && (
            <>
              <div className="pl-sub">{t(lang, 'requestsTitle')}</div>
              {requests.map((r, i) => (
                <div className="pl" key={i} style={{ alignItems: 'center' }}>
                  <span>{coreName(lang, r.name)}</span>
                  <span className="tag">{coreName(lang, r.note) || t(lang, 'pending')}</span>
                </div>
              ))}
            </>
          )}
        </>
      )}

      <div className={onlyTotal ? 'pl tot only' : 'pl tot'}>
        <span>{t(lang, 'total')}</span>
        <TotalAmount value={estimate.total} exact={exact} lang={lang} />
      </div>
      {!exact && <div className="cap" style={{ marginTop: 2 }}>{t(lang, 'exactAfterMeasure')}</div>}
      {exact && priceDate && (
        <div className="cap" style={{ marginTop: 2 }}>{t(lang, 'priceOn', { date: formatDay(priceDate, lang) })}</div>
      )}
      {requests.length > 0 && <div className="cap" style={{ marginTop: 2 }}>{t(lang, 'pendingNote')}</div>}
    </section>
  );
}
