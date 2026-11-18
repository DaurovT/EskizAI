/**
 * Продолжить незаконченный замер (MResume): лист поверх экрана — «Кухня, шаг 3 · Юнусабад 4».
 * Черновики — offline.drafts() (позиции со step); «Продолжить» → мастер на том же шаге, «Начать заново» — удалить и замерить снова.
 */
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { OrderFull } from '@/api/types';
import { useLoad } from '@/lib/useLoad';
import { LocalPosition, offline } from '@/offline/store';
import { Icon } from '@/ui/Icon';
import { Button, Loading, Txt } from '@/ui/kit';
import { C } from '@/theme';
import { MiniSchema, tryApi } from './parts';

type Draft = { p: LocalPosition; address: string };

async function load(): Promise<Draft[]> {
  const [drafts, snap] = await Promise.all([offline.drafts(), offline.snapshot()]);
  const addr: Record<string, string> = {};
  for (const d of drafts) {
    if (d.order_id in addr) continue;
    addr[d.order_id] = snap.orders[d.order_id]?.address ?? '';
    if (!addr[d.order_id]) {
      try {
        const o = await tryApi<OrderFull>(`/oyna/orders/${d.order_id}`);
        addr[d.order_id] = o?.order.address ?? o?.client?.name ?? '';
      } catch { /* без адреса */ }
    }
  }
  return drafts.map((p) => ({ p, address: addr[p.order_id] ?? '' }));
}

const label = (d: Draft) => [`${d.p.doc.room || 'Окно'}, шаг ${d.p.step}`, d.address].filter(Boolean).join(' · ');
const open = (p: LocalPosition) => router.replace(`/order/${p.order_id}/measure?pos=${p.id}&step=${p.step ?? 1}`);
const close = () => (router.canGoBack() ? router.back() : router.replace('/orders'));

export default function Resume() {
  const insets = useSafeAreaInsets();
  const { data, loading, reload } = useLoad(load, []);

  const restart = async (p: LocalPosition) => {
    await offline.deletePosition(p.id);
    router.replace(`/order/${p.order_id}/measure`);
  };
  const remove = async (p: LocalPosition) => { await offline.deletePosition(p.id); await reload(); };

  const [first, ...rest] = data ?? [];
  return (
    <View style={{ flex: 1, backgroundColor: C.scrim }}>
      <Pressable accessibilityLabel="Закрыть" style={{ flex: 1 }} onPress={close} />
      <View style={[s.bs, { paddingBottom: Math.max(insets.bottom, 16) + 14 }]}>
        <View style={s.hdl}><View style={s.hdlBar} /></View>
        {!data ? (loading ? <Loading /> : null) : !first ? (
          <>
            <View style={s.head}>
              <View style={{ flex: 1 }}>
                <Txt w={700} size={20} style={{ lineHeight: 26 }}>Незаконченных замеров нет</Txt>
                <Txt size={14} color={C.muted}>Все окна сохранены</Txt>
              </View>
            </View>
            <Button title="Закрыть" kind="secondary" onPress={close} style={{ backgroundColor: C.soft }} />
          </>
        ) : (
          <>
            <View style={s.head}>
              <MiniSchema doc={first.p.doc} width={60} height={56} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Txt w={700} size={20} style={{ lineHeight: 26 }}>Продолжить замер?</Txt>
                <Txt size={14} color={C.muted} lines={2}>{label(first)}</Txt>
              </View>
            </View>
            <Button title="Продолжить" onPress={() => open(first.p)} />
            <Button title="Начать заново" kind="secondary" style={{ backgroundColor: C.soft }} onPress={() => void restart(first.p)} />
            {rest.length ? (
              <View style={{ marginTop: 8 }}>
                <Txt size={15} w={600} color={C.muted} style={{ paddingHorizontal: 8, paddingBottom: 4 }}>Ещё не закончены</Txt>
                {rest.map((d) => (
                  <Pressable key={d.p.id} accessibilityRole="button" onPress={() => open(d.p)}
                    style={({ pressed }) => [s.row, pressed && { backgroundColor: '#F7F7F5' }]}>
                    <MiniSchema doc={d.p.doc} width={34} height={30} />
                    <Txt w={500} lines={1} style={{ flex: 1 }}>{label(d)}</Txt>
                    <Pressable accessibilityRole="button" accessibilityLabel="Удалить черновик" hitSlop={8} onPress={() => void remove(d.p)} style={s.del}>
                      <Icon name="close" size={18} color={C.muted} />
                    </Pressable>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bs: { backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 12, gap: 8, maxHeight: '86%',
    shadowColor: '#21201F', shadowOpacity: 0.1, shadowRadius: 24, shadowOffset: { width: 0, height: -4 } },
  hdl: { height: 22, alignItems: 'center', justifyContent: 'center' },
  hdlBar: { width: 40, height: 5, borderRadius: 3, backgroundColor: '#D6D4CF' },
  head: { flexDirection: 'row', gap: 14, alignItems: 'center', paddingHorizontal: 8, paddingTop: 4, paddingBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 8, borderRadius: 16 },
  del: { width: 36, height: 36, borderRadius: 12, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' },
});
