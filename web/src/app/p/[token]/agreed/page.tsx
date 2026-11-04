import { AgreedView } from '@/components/AgreedView';
import { StatusScreen } from '@/components/StatusScreen';
import { isLang } from '@/lib/i18n';
import { getShare } from '@/lib/share-source';
import type { Lang } from '@/lib/share-types';

export const dynamic = 'force-dynamic';

/** WEB-2 «Клиент согласовал». */
export default async function AgreedPage(props: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ lang?: string; at?: string }>;
}) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const r = await getShare(params.token);
  const qLang = isLang(searchParams.lang) ? searchParams.lang : undefined;
  if (!r.ok) return <StatusScreen kind={r.error} lang={qLang} master={r.master} />;
  const lang: Lang = qLang ?? r.data.lang;
  // ?at= — только для сверки с макетом (dev): время согласования
  const at = process.env.NODE_ENV !== 'production' && searchParams.at ? searchParams.at : null;
  return <AgreedView data={at ? { ...r.data, agreedAt: at } : r.data} initialLang={lang} />;
}
