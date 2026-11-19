/**
 * «+» — новый заказ (макет OrderNew): клиент, адрес, этаж и три способа добавить первое изделие.
 * Заказ создаётся на телефоне (offline.createOrder) — работает без сети; на сервер уходит через offline.sync().
 * «Сопутствующий товар» — строка с ценой на сервере, поэтому нужен интернет.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';

import type { Extra } from '@/api/types';
import { LocalOrder, offline } from '@/offline/store';
import { C } from '@/theme';
import { Body, ErrorText, Field, IconButton, Screen, Txt } from '@/ui/kit';
import { ExtraSheet, OptCard } from './parts';

type Way = 'measure' | 'template' | 'extra';

export default function OrderNew() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('+998 ');
  const [telegram, setTelegram] = useState('');
  const [address, setAddress] = useState('');
  const [floor, setFloor] = useState('');
  const [order, setOrder] = useState<LocalOrder | null>(null);
  const [busy, setBusy] = useState<Way | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [extraFor, setExtraFor] = useState<string | null>(null);

  const reset = useCallback(() => {
    setName(''); setPhone('+998 '); setTelegram(''); setAddress(''); setFloor('');
    setOrder(null); setBusy(null); setErr(null); setExtraFor(null);
  }, []);
  // вкладка «+» каждый раз начинается с чистого заказа
  useFocusEffect(useCallback(() => () => reset(), [reset]));

  const phoneDigits = phone.replace(/\D/g, '');
  const client = () => {
    const c = {
      name: name.trim() || undefined,
      phone: phoneDigits.length > 3 ? `+${phoneDigits}` : undefined,
      telegram: telegram.trim() ? (telegram.trim().startsWith('@') ? telegram.trim() : `@${telegram.trim()}`) : undefined,
    };
    return c.name || c.phone || c.telegram ? c : undefined;
  };

  /** Создать заказ один раз (повторное нажатие — тот же заказ). */
  const ensure = async (): Promise<LocalOrder> => {
    if (order) return order;
    const f = parseInt(floor, 10);
    const o = await offline.createOrder({ client: client(), address: address.trim() || undefined, floor: Number.isFinite(f) ? f : undefined });
    setOrder(o);
    return o;
  };

  const go = async (way: Way) => {
    setBusy(way); setErr(null);
    try {
      const o = await ensure();
      if (way === 'extra') {
        // строка товара живёт на сервере — сначала отправляем заказ
        const r = await offline.sync().catch(() => ({ offline: false, failed: true }));
        const snap = await offline.snapshot();
        if (!snap.orders[o.id]?.synced) {
          setErr(('offline' in r && r.offline) ? 'Сопутствующий товар добавим, когда появится интернет. Заказ сохранён на телефоне' : 'Не получилось отправить заказ. Попробуйте ещё раз');
          return;
        }
        setExtraFor(o.id);
        return;
      }
      // заказ НЕ отправляем сразу: уйдёт вместе с первым окном (замер/шаблон сами вызывают sync).
      // Иначе брошенный замер оставлял пустой «Без клиента» в списке.
      // под замером/шаблонами — экран заказа, а не эта форма: «Назад» из итога ведёт в заказ, а не в пустой «Новый заказ»
      router.replace(`/order/${o.id}`);
      router.push(way === 'measure' ? `/order/${o.id}/measure` : `/order/${o.id}/templates`);
    } finally {
      setBusy(null);
    }
  };

  const onExtraSaved = (_: Extra[]) => {
    const id = extraFor;
    setExtraFor(null);
    if (id) router.push(`/order/${id}`);
  };

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4, minHeight: 56 }}>
        <IconButton name="back" label="Назад" onPress={() => router.navigate('/orders')} />
        <View style={{ flex: 1 }} />
      </View>
      <Txt size={22} w={700} style={{ paddingHorizontal: 20, paddingBottom: 2, lineHeight: 28, letterSpacing: -0.4 }}>{name.trim() || 'Новый заказ'}</Txt>
      <Txt size={14} color={C.muted} style={{ paddingHorizontal: 20, paddingBottom: 6 }} lines={1}>
        {[address.trim(), floor.trim() ? `${floor.trim()} этаж` : '', telegram.trim() ? (telegram.trim().startsWith('@') ? telegram.trim() : `@${telegram.trim()}`) : '']
          .filter(Boolean).join(' · ') || 'Клиента можно добавить и потом'}
      </Txt>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Body style={{ paddingHorizontal: 12, paddingTop: 8, gap: 10, paddingBottom: 40 }}>
          <Field label="Клиент" value={name} onChangeText={setName} placeholder="Имя" autoCapitalize="words" />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field label="Телефон" value={phone} onChangeText={setPhone} keyboardType="phone-pad" style={{ flex: 1 }} />
            <Field label="Telegram" value={telegram} onChangeText={setTelegram} placeholder="@ник" autoCapitalize="none" autoCorrect={false} style={{ flex: 1 }} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field label="Адрес" value={address} onChangeText={setAddress} placeholder="Район, дом, кв." style={{ flex: 1 }} />
            <Field label="Этаж" value={floor} onChangeText={(t) => setFloor(t.replace(/\D/g, '').slice(0, 3))} keyboardType="number-pad" style={{ width: 92 }} />
          </View>

          <Txt size={14} color={C.muted} style={{ paddingHorizontal: 8, paddingTop: 8 }}>Добавьте первое изделие</Txt>
          <OptCard accent icon="ruler" title="Замерить" text="мастер: проём, размеры, деление" onPress={() => go('measure')} loading={busy === 'measure'} disabled={!!busy && busy !== 'measure'} />
          <OptCard icon="grid" title="Из шаблона" text="шаблон + габарит = изделие" onPress={() => go('template')} loading={busy === 'template'} disabled={!!busy && busy !== 'template'} />
          <OptCard icon="tag" title="Сопутствующий товар" text="сетка, жалюзи — строкой с ценой" onPress={() => go('extra')} loading={busy === 'extra'} disabled={!!busy && busy !== 'extra'} />
          <ErrorText>{err}</ErrorText>
        </Body>
      </KeyboardAvoidingView>
      {extraFor ? <ExtraSheet orderId={extraFor} visible onClose={() => setExtraFor(null)} onSaved={onExtraSaved} /> : null}
    </Screen>
  );
}
