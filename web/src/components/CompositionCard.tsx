import type { ViewerModel } from '@mebel/viewer';
import { composition, type Composition, type DecorInfo, type Swatch } from '@/lib/composition';
import { counted, t, type DictKey } from '@/lib/i18n';
import type { Lang } from '@/lib/share-types';

function Dot({ swatch }: { swatch: Swatch }) {
  return (
    <span
      className="sw"
      aria-hidden="true"
      style={{
        backgroundColor: swatch.color,
        backgroundImage: swatch.texture ? `url("${swatch.texture}")` : undefined,
      }}
    />
  );
}

function decorLabel(d: DecorInfo, lang: Lang): string {
  if (d.painted) return d.name ? `${t(lang, 'painted')} · ${d.name}` : t(lang, 'painted');
  return d.name ?? '—';
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cp-row">
      <div className="cp-l">{label}</div>
      <div className="cp-v">{children}</div>
    </div>
  );
}

function frontsLine(c: Composition, lang: Lang): string | null {
  const f = c.fronts;
  if (!f) return null;
  const kind = f.kind === 'other' ? null : t(lang, `kind_${f.kind}` as DictKey);
  const head = kind ? (f.thicknessMm ? `${kind} ${f.thicknessMm} ${t(lang, 'mm')}` : kind) : null;
  return [
    head,
    f.painted ? t(lang, 'painted') : null,
    f.paintCode,
    f.finish ? t(lang, `finish_${f.finish}` as DictKey) : null,
    f.milling ? t(lang, 'withMilling') : null,
  ]
    .filter(Boolean)
    .join(' · ') || null;
}

function handlesLine(c: Composition, lang: Lang): string | null {
  const h = c.handles;
  if (!h) return null;
  const kind = t(lang, `handle_${h.kind}` as DictKey);
  const head = h.sizeMm ? `${kind} ${h.sizeMm} ${t(lang, 'mm')}` : kind;
  const finish = h.finish && `hw_${h.finish}` in HW ? t(lang, `hw_${h.finish}` as DictKey) : null;
  return [head, finish, h.count > 0 ? `${h.count} ${t(lang, 'pcs')}` : null].filter(Boolean).join(' · ');
}

const HW: Record<string, true> = Object.fromEntries(
  ['steel', 'chrome', 'nickel', 'zinc', 'alu', 'plastic_black', 'plastic_light', 'brass', 'gold', 'black'].map((k) => [`hw_${k}`, true]),
);

function insideChips(c: Composition, lang: Lang): string[] {
  const i = c.inside;
  const out: string[] = [];
  if (i.slidingDoors) out.push(counted(lang, 'slidingDoor', i.slidingDoors));
  if (i.doors) out.push(counted(lang, 'door', i.doors));
  if (i.drawers) out.push(counted(lang, 'drawer', i.drawers));
  if (i.shelves) out.push(counted(lang, 'shelf', i.shelves));
  if (i.rods) out.push(counted(lang, 'rod', i.rods));
  if (i.lights) out.push(t(lang, 'lights'));
  return out;
}

/**
 * «Что в изделии»: цвет и декор, фасады, ручки, наполнение — из viewer model ссылки.
 * Без цен деталей, поставщика и артикулов (NFR-10): только то, что видно на изделии.
 */
export function CompositionCard({ model, lang }: { model: ViewerModel; lang: Lang }) {
  const c = composition(model);
  const fronts = frontsLine(c, lang);
  const handles = handlesLine(c, lang);
  const chips = insideChips(c, lang);
  if (!c.decor && !fronts && !handles && chips.length === 0) return null;

  return (
    <section className="sheet cp" aria-labelledby="cp-title">
      <h2 id="cp-title" className="sec-t">
        {t(lang, 'compTitle')}
      </h2>
      {c.decor && (
        <Row label={t(lang, 'compDecor')}>
          <span className="dc">
            <span className="dc-i">
              <Dot swatch={c.decor.swatch} />
              <span className="dc-n">{decorLabel(c.decor, lang)}</span>
              {c.body && c.fronts && <span className="dc-r">{t(lang, 'compFrontsOf')}</span>}
            </span>
            {c.body && (
              <span className="dc-i">
                <Dot swatch={c.body.swatch} />
                <span className="dc-n">{decorLabel(c.body, lang)}</span>
                <span className="dc-r">{t(lang, 'compBody')}</span>
              </span>
            )}
          </span>
        </Row>
      )}
      {fronts && <Row label={t(lang, 'compFronts')}>{fronts}</Row>}
      {handles && (
        <Row label={t(lang, 'compHandles')}>
          {c.handles?.color && <span className="hw-dot" style={{ backgroundColor: c.handles.color }} aria-hidden="true" />}
          {handles}
        </Row>
      )}
      {chips.length > 0 && (
        <Row label={t(lang, 'compInside')}>
          <span className="chips">
            {chips.map((x) => (
              <span className="chip" key={x}>
                {x}
              </span>
            ))}
          </span>
        </Row>
      )}
    </section>
  );
}
