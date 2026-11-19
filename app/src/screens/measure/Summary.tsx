/**
 * Итог замера (MSummary, FR-M11): позиции заказа со схемами, цена в 1–3 комплектациях цеха, «Отправить КП».
 * Онлайн — GET /oyna/orders/{id} + /variants, поверх — неотправленные правки с телефона; без сети — offline.snapshot().
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { api, ApiError } from '@/api/http';
import type { Doc, OrderFull, Variant } from '@/api/types';
import { money, num } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { offline } from '@/offline/store';
import { Icon } from '@/ui/Icon';
import { Body, Button, Dock, Empty, IconButton, LoadError, Loading, Row, Screen, Sheet, Txt } from '@/ui/kit';
import { C } from '@/theme';
import { Ban, MiniSchema, st, Tag, useToast } from './parts';

type Pos = { id: string; doc: Doc; total: number | null; draftStep?: number; unsent: boolean };

async function load(id: string) {
  let snap = await offline.snapshot();
  const pending = () => Object.values(snap.positions).filter((p) => p.order_id === id && p.dirty && p.step === undefined).length
    + (snap.orders[id] && !snap.orders[id].synced ? 1 : 0);
  if (pending() > 0) {                                      // сначала отправить замер — иначе цена без него
    // ждём отправку не дольше 4 с: в очереди могут висеть и другие заказы — мастер стоит перед клиентом
    try { await Promise.race([offline.sync(), new Promise((r) => setTimeout(r, 4000))]); } catch { /* покажем как есть */ }
    snap = await offline.snapshot();
  }
  let full: OrderFull | null = null, net = true;
  // заказ и цены по комплектациям — одновременно, а не по очереди
  const [fr, vr] = await Promise.allSettled([
    api.get<OrderFull>(`/oyna/orders/${id}`),
    api.get<Variant[]>(`/oyna/orders/${id}/variants`),
  ]);
  if (fr.status === 'fulfilled') full = fr.value;
  else {
    const e = fr.reason;
    if (e instanceof ApiError && e.isNetwork) net = false;
    else if (!(e instanceof ApiError && e.status === 404 && snap.orders[id])) throw e;
  }
  const variants: Variant[] = full && vr.status === 'fulfilled' ? vr.value : [];

  const rows = new Map<string, Pos>();
  for (const p of full?.positions ?? []) if (!p.deleted) rows.set(p.id, { id: p.id, doc: p.doc, total: p.total, unsent: false });
  for (const p of Object.values(snap.positions)) {
    if (p.order_id !== id) continue;
    if (p.deleted) { rows.delete(p.id); continue; }
    if (p.dirty || !rows.has(p.id)) rows.set(p.id, { id: p.id, doc: p.doc, total: p.dirty ? null : rows.get(p.id)?.total ?? null, draftStep: p.step, unsent: p.dirty });
  }
  const conflicts = Object.values(snap.conflicts).filter((c) => c.order_id === id);
  return { full, variants: variants.slice(0, 3), net, rows: [...rows.values()], pending: pending(), conflicts };
}

export default function Summary() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, loading, reload } = useLoad(() => load(String(id)), [id]);
  const [more, setMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [toast, showToast] = useToast();

  const sync = async () => {
    setMore(false);
    setSyncing(true);
    try {
      const r = await offline.sync();
      if (r.offline) showToast('Нет интернета — отправим, когда появится');
      else if (r.conflicts) showToast(`Конфликт версий: ${r.conflicts}`);
      else if (r.sent) showToast('Отправлено');
      await reload();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не получилось отправить');
    } finally {
      setSyncing(false);
    }
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace(`/order/${id}`));
  const header = (
    <View style={st.hdr}>
      <IconButton name="back" label="Назад" onPress={back} />
      <Txt w={600} size={18} lines={1} style={{ flex: 1 }}>Итог замера</Txt>
      <IconButton name="more" label="Ещё" onPress={() => setMore(true)} />
    </View>
  );

  if (!data) {
    return <Screen>{header}{loading ? <Loading /> : <LoadError message={error ?? ''} onRetry={reload} />}</Screen>;
  }

  const { full, variants, net, rows, pending, conflicts } = data;
  const done = rows.filter((r) => r.draftStep === undefined);
  const drafts = rows.length - done.length;
  const demo = variants.some((v) => v.demo) || !!full?.demo;
  const fresh = net && pending === 0;
  const anyCurrent = variants.some((v) => v.current);

  return (
    <Screen>
      {header}
      <Body style={{ paddingHorizontal: 12, paddingTop: 8, gap: 10 }} refresh={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}>
        {conflicts.map((c) => (
          <Ban key={c.position_id} kind="err" icon="warn" title="Позицию изменили в офисе" body="Выберите, какую версию оставить"
            action="Решить" onAction={() => router.push(`/order/${id}/conflict?pos=${c.position_id}`)} />
        ))}
        {!rows.length ? (
          <Empty title="Замеров пока нет" text="Измерьте первое окно — итог появится здесь"
            action={<Button title="Начать замер" icon="ruler" onPress={() => router.push(`/order/${id}/measure`)} />} />
        ) : (
          <View style={st.sheet}>
            {rows.map((r, i) => {
              const sub = [`${num(r.doc.frame.w)} × ${num(r.doc.frame.h)}`, (r.doc.qty ?? 1) > 1 ? `× ${r.doc.qty}` : '',
                r.draftStep !== undefined ? `не закончен, шаг ${r.draftStep}` : r.unsent ? 'не отправлено' : ''].filter(Boolean).join(' · ');
              return (
                <Pressable key={r.id} accessibilityRole="button"
                  onPress={() => router.push(r.draftStep !== undefined ? `/order/${id}/measure?pos=${r.id}&step=${r.draftStep}` : `/order/${id}/editor?pos=${r.id}`)}
                  style={({ pressed }) => [s.row, pressed && { backgroundColor: '#F7F7F5' }]}>
                  {i > 0 ? <View style={s.sep} /> : null}
                  <View style={s.tile}><MiniSchema doc={r.doc} width={44} height={42} /></View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                      <Txt w={600} lines={1} style={{ flexShrink: 1 }}>{r.doc.room || 'Окно'}</Txt>
                      {r.total ? <Txt w={600} style={{ fontVariant: ['tabular-nums'] }}>{money(r.total)}</Txt> : null}
                    </View>
                    <Txt size={14} color={r.draftStep !== undefined ? C.estFg : C.muted} lines={1} style={{ fontVariant: ['tabular-nums'] }}>{sub}</Txt>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}

        {rows.length ? (
          <View style={[st.sheet, { padding: 16 }]}>
            <Txt size={15} w={600} color={C.muted} style={{ paddingHorizontal: 4, paddingBottom: 10 }}>Цена по комплектациям</Txt>
            {!net ? (
              <View style={s.wait}>
                <Icon name="cloud_off" size={20} color={C.muted} />
                <Txt size={15} color={C.muted} style={{ flex: 1 }}>посчитаем, когда появится интернет</Txt>
              </View>
            ) : pending > 0 ? (
              <View style={s.wait}>
                <Icon name="sync" size={20} color={C.muted} />
                <Txt size={15} color={C.muted} style={{ flex: 1 }}>посчитаем, когда замер уйдёт на сервер</Txt>
              </View>
            ) : variants.length ? (
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {variants.map((v) => {
                  const on = v.current || (!anyCurrent && variants.length === 1);
                  return (
                    <Pressable key={v.kit} accessibilityRole="button" onPress={() => router.push(`/order/${id}/calc?kit=${encodeURIComponent(v.kit)}`)}
                      style={({ pressed }) => [s.kit, on && s.kitOn, pressed && { opacity: 0.85 }]}>
                      <Txt size={13} color={C.muted} lines={1}>{v.kit}</Txt>
                      {/* не считается (ошибка размеров/конструкции) — не «0», а прямо говорим, что не так */}
                      {v.total > 0 ? <Txt size={19} w={700} style={{ marginTop: 2, fontVariant: ['tabular-nums'] }} lines={1}>{money(v.total)}</Txt>
                        : <Txt size={14} w={600} color={C.danger} style={{ marginTop: 4 }} lines={2}>не считается — проверьте окно</Txt>}
                      {v.per_m2 ? <Txt size={12} color={C.muted} lines={1} style={{ fontVariant: ['tabular-nums'] }}>{money(v.per_m2)} /м²</Txt> : null}
                    </Pressable>
                  );
                })}
              </View>
            ) : full ? (
              <View style={[s.kit, s.kitOn, { flex: 0 }]}>
                <Txt size={13} color={C.muted}>Итого</Txt>
                <Txt size={19} w={700} style={{ marginTop: 2 }}>{money(full.total)}</Txt>
                {full.per_m2 ? <Txt size={12} color={C.muted}>{money(full.per_m2)} /м²</Txt> : null}
              </View>
            ) : null}
          </View>
        ) : null}

        {fresh && demo ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 }}>
            <Tag kind="est" title="ДЕМО" />
            <Txt style={st.cap}>Работы и стекло — демо-цены цеха</Txt>
          </View>
        ) : null}

        {!net || pending > 0 ? (
          <Ban kind="n" icon={net ? 'sync' : 'cloud_off'} title={net ? `Не отправлено: ${pending}` : 'Нет интернета'}
            body={net ? 'Замер сохранён на телефоне' : 'Замер сохранён на телефоне, отправим сами'}
            action={syncing ? 'Отправляем…' : 'Синхронизировать'} onAction={syncing ? undefined : () => void sync()} />
        ) : null}
        {drafts ? <Txt style={[st.cap, { paddingHorizontal: 8 }]}>Не закончено окон: {drafts} — в КП попадут после замера</Txt> : null}
      </Body>
      <Dock>
        <Button title="Отправить КП" icon="send" disabled={!fresh || !done.length || !full} onPress={() => router.push(`/order/${id}/quote`)} />
      </Dock>
      <Sheet visible={more} onClose={() => setMore(false)}>
        <View style={[st.sheet, { marginHorizontal: 12, marginBottom: 8 }]}>
          <Row first label="Добавить окно" left={<Icon name="plus" />} onPress={() => { setMore(false); router.push(`/order/${id}/measure`); }} />
          <Row label="Синхронизировать" left={<Icon name="sync" />} onPress={() => void sync()} />
          <Row label="Открыть заказ" left={<Icon name="folder" />} onPress={() => { setMore(false); router.replace(`/order/${id}`); }} />
        </View>
      </Sheet>
      {toast}
    </Screen>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 76, paddingHorizontal: 20, paddingVertical: 10 },
  sep: { position: 'absolute', left: 0, right: 0, top: 0, height: 1, backgroundColor: C.line },
  tile: { width: 56, height: 56, borderRadius: 16, backgroundColor: '#EEF3F8', alignItems: 'center', justifyContent: 'center' },
  kit: { flex: 1, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 10, backgroundColor: C.soft, borderWidth: 2, borderColor: 'transparent' },
  kitOn: { backgroundColor: C.accentSoft, borderColor: C.accent },
  wait: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 18, backgroundColor: C.soft, padding: 14 },
});
