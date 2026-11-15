import { formatDay } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { Lang } from '@/lib/share-types';
import { IconCheck } from './icons';

/** «Что дальше»: Согласовать → Замер → Изготовление. После согласия первый шаг отмечен. */
export function NextSteps({ lang, agreedAt }: { lang: Lang; agreedAt: string | null }) {
  const steps = [
    { title: t(lang, 'next1T'), text: agreedAt ? t(lang, 'next1Done', { date: formatDay(agreedAt, lang) }) : t(lang, 'next1D') },
    { title: t(lang, 'next2T'), text: t(lang, 'next2D') },
    { title: t(lang, 'next3T'), text: t(lang, 'next3D') },
  ];
  const current = agreedAt ? 1 : 0;
  return (
    <section className="sheet nx" aria-labelledby="nx-title">
      <h2 id="nx-title" className="sec-t">
        {t(lang, 'nextTitle')}
      </h2>
      <ol className="nx-list">
        {steps.map((s, i) => {
          const state = i < current ? 'done' : i === current ? 'now' : 'later';
          return (
            <li key={i} className={`nx-step ${state}`} aria-current={state === 'now' ? 'step' : undefined}>
              <span className="nx-n" aria-hidden="true">
                {state === 'done' ? <IconCheck size={16} sw={3} /> : i + 1}
              </span>
              <div className="nx-tx">
                <div className="nx-t">{s.title}</div>
                <div className="nx-d">{s.text}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
