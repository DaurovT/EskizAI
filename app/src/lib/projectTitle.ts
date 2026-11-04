/** Название проекта: старые «Новый проект 03.11.2026» и заглушка «Эскиз» заменяем на тип изделия и габарит. */

const AUTO = /^(новый проект|yangi loyiha|эскиз|eskiz)(\s+\d{1,2}[./]\d{1,2}([./]\d{2,4})?)?$/i;

/** Название сгенерировано по дате/заглушке — смысла в нём нет. */
export const isAutoTitle = (title: string | null | undefined) => !title?.trim() || AUTO.test(title.trim());

/** «Пенал 820×450×1800» (Ш×Г×В); без размеров — только тип. */
export function sizeTitle(kindLabel: string, size?: (number | null | undefined)[] | null): string {
  const xs = (size ?? []).map((x) => (typeof x === 'number' && x > 0 ? Math.round(x) : null));
  return xs.length === 3 && xs.every((x) => x != null) ? `${kindLabel} ${xs.join('×')}` : kindLabel;
}

/** Показываемое название: своё — как есть, сгенерированное — тип изделия (и габарит); клиент — через «·», без повтора. */
export function displayTitle(title: string | null | undefined, fallback: string, client?: string | null): string {
  const base = isAutoTitle(title) ? fallback : title!.trim();
  return client && !base.toLowerCase().includes(client.toLowerCase()) ? `${base} · ${client}` : base;
}
