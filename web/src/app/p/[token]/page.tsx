import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ShareView } from '@/components/ShareView';
import { StatusScreen } from '@/components/StatusScreen';
import { devForce, type DevParams } from '@/lib/dev-force';
import { formatPrice } from '@/lib/format';
import { isLang, tl } from '@/lib/i18n';
import { getShare } from '@/lib/share-source';
import type { Lang } from '@/lib/share-types';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ lang?: string; view?: string } & DevParams>;
};

/** Превью ссылки в Telegram: название изделия, мастер, итог (если мастер показывает цену). */
export async function generateMetadata(props: Props): Promise<Metadata> {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const r = await getShare(params.token);
  if (!r.ok) return { title: 'Проект мебели' };
  const lang: Lang = isLang(searchParams.lang) ? searchParams.lang : r.data.lang;
  const title = `${tl(lang, r.data.project.title)} — ${r.data.master.workshop ?? r.data.master.name}`;
  const description = r.data.estimate ? formatPrice(r.data.estimate.total, lang, r.data.estimate.exact) : undefined;
  return { title, description, openGraph: { title, description, type: 'website' } };
}

export default async function SharePage(props: Props) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const dev = devForce(searchParams);
  const r = await getShare(params.token, searchParams.view);
  const qLang = isLang(searchParams.lang) ? searchParams.lang : undefined;
  if (dev.status) {
    return <StatusScreen kind={dev.status} lang={qLang ?? (r.ok ? r.data.lang : 'ru')} master={r.ok ? r.data.master : r.master} />;
  }
  if (!r.ok && r.error === 'not_found') notFound();
  if (!r.ok) return <StatusScreen kind={r.error} lang={qLang} master={r.master} />;
  const data = dev.agreed && !r.data.agreedAt ? { ...r.data, agreedAt: new Date().toISOString() } : r.data;
  return <ShareView data={data} initialLang={qLang ?? r.data.lang} dev={dev.ar} />;
}
