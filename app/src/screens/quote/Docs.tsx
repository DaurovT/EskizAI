/**
 * S12 Документы заказа — макет Docs. PDF скачиваются с токеном (GET /oyna/orders/{id}/documents/{kind}.pdf) в кэш
 * и открываются через «Поделиться». Доступ по ролям как на сервере: лист для цеха — владелец/менеджер/производство,
 * заявка поставщику — владелец/менеджер; КП с ценами — не монтажнику и не производству. Раскрой — в подписке (Pro, внутри листа для цеха).
 */
import { router, useLocalSearchParams } from 'expo-router';
import { ReactNode, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { api, errorText } from '@/api/http';
import type { OrderFull, Role } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { date } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { ErrorText, LoadError, Loading, Screen, TopBar, Txt } from '@/ui/kit';
import { C } from '@/theme';
import { CompanyOut, DocIcon, LockIcon, Pill, ShareIcon, Tag, sharePdf } from './parts';

type Kind = 'supplier' | 'shop' | 'install' | 'quote';
type DocRow = { kind: Kind; title: string; sub: string; roles?: Role[]; deny: string; file: string; query?: string; off?: string };

export default function Docs() {
  const p = useLocalSearchParams<{ id: string }>();
  const id = String(p.id);
  const { role } = useAuth();
  const load = useLoad(async () => {
    const [order, company] = await Promise.all([
      api.get<OrderFull>(`/oyna/orders/${id}`),
      api.get<CompanyOut>('/oyna/company').catch(() => null),
    ]);
    return { order, company };
  }, [id]);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const head = <TopBar title="Документы" onBack={() => router.back()} />;
  if (load.error && !load.data) return <Screen>{head}<LoadError message={load.error} onRetry={load.reload} /></Screen>;
  if (!load.data) return <Screen>{head}<Loading /></Screen>;

  const { order, company } = load.data;
  const pro = company?.company.plan === 'pro';
  const q = order.quotes[0];                               // последняя версия (сервер отдаёт по убыванию)
  const short = (iso?: string | null) => date(iso).slice(0, 5);
  const noPositions = !order.positions.filter((x) => !x.deleted).length;

  const rows: DocRow[] = [
    { kind: 'supplier', title: 'Заявка поставщику', sub: 'хлысты, фурнитура, стекло', roles: ['owner', 'manager'], deny: 'только владелец и менеджер', file: 'zayavka' },
    { kind: 'shop', title: 'Лист для цеха', sub: 'схемы, размеры, предупреждения', roles: ['owner', 'manager', 'production'], deny: 'владелец, менеджер, производство', file: 'list-ceha' },
    { kind: 'install', title: 'Монтажный лист', sub: 'адрес, демонтаж, фото', deny: '', file: 'montazh' },
    { kind: 'quote', title: 'КП (PDF)', sub: q ? `версия ${q.version} · ${short(q.sent_at)}` : 'КП ещё не отправлено', roles: ['owner', 'manager', 'measurer'],
      deny: 'цены — не для вашей роли', file: q ? `kp-${q.version}` : 'kp', query: q ? `?version=${q.version}` : '', off: q ? undefined : 'КП ещё не отправлено' },
  ];

  const open = async (r: DocRow) => {
    setBusy(r.kind); setErr(null);
    try {
      await sharePdf(`/oyna/orders/${id}/documents/${r.kind}.pdf${r.query ?? ''}`, `${r.file}-${id.slice(0, 8)}.pdf`, r.title);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const allowed = (r: DocRow) => !r.roles || (role !== null && r.roles.includes(role));
  const shopRow = rows[1];

  return (
    <Screen>
      {head}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24, gap: 10 }}>
        <View style={card}>
          {rows.map((r, i) => {
            const ok = allowed(r);
            const off = !ok ? r.deny : r.off ?? (noPositions && r.kind !== 'quote' ? 'в заказе нет позиций' : undefined);
            return (
              <DocLine key={r.kind} first={i === 0} title={r.title} sub={off ?? r.sub} disabled={!!off}
                onPress={off ? undefined : () => void open(r)}
                right={busy === r.kind ? <Pill kind="blue" title="Готовим PDF…" /> : off ? <LockIcon /> : <ShareBtn />} />
            );
          })}
        </View>

        <View style={card}>
          {pro ? (
            <DocLine first title="Раскрой хлыстов" sub={allowed(shopRow) ? 'в листе для цеха' : shopRow.deny} disabled={!allowed(shopRow) || noPositions}
              onPress={allowed(shopRow) && !noPositions ? () => void open(shopRow) : undefined}
              right={busy === 'shop' ? <Pill kind="blue" title="Готовим PDF…" /> : allowed(shopRow) ? <ShareBtn /> : <LockIcon />} />
          ) : (
            <DocLine first title="Раскрой хлыстов" sub="в подписке цеха" disabled right={<LockIcon />} />
          )}
        </View>

        <ErrorText>{err}</ErrorText>

        {order.demo || q?.demo ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 }}>
            <Tag kind="est" title="ДЕМО" />
            <Txt size={14} color={C.muted} style={{ flex: 1 }}>В PDF с ценами — водяной знак ДЕМО</Txt>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const card = { backgroundColor: C.card, borderRadius: 28, overflow: 'hidden' as const };

function ShareBtn() {
  return (
    <View accessibilityLabel="Поделиться" style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' }}>
      <ShareIcon />
    </View>
  );
}

function DocLine({ title, sub, right, onPress, disabled, first }: { title: string; sub: string; right: ReactNode; onPress?: () => void; disabled?: boolean; first?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} accessibilityLabel={`${title}, ${sub}`} disabled={!onPress} onPress={onPress}
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingHorizontal: 20, paddingVertical: 10 },
        !first && { borderTopWidth: 1, borderTopColor: C.line }, disabled && { opacity: 0.55 }, pressed && { backgroundColor: '#F7F6F3' }]}>
      <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' }}>
        <DocIcon />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt w={600} style={{ lineHeight: 21 }}>{title}</Txt>
        <Txt size={14} color={C.muted} style={{ lineHeight: 19 }}>{sub}</Txt>
      </View>
      {right}
    </Pressable>
  );
}
