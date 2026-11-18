/**
 * Лист «две версии» — макет EditorConflict (docs/design).
 * Позицию изменили на другом устройстве: 409 от команд/сохранения (тело — server + client) или конфликт
 * синхронизации офлайн-замера (offline.conflicts). «Оставить мою» — PUT …/positions/{pos} {doc, force:true};
 * «Оставить их» — серверная версия. Редактор перечитает позицию при возврате.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';

import { api, errorText } from '@/api/http';
import type { Conflict as ConflictT, Doc, PositionOut } from '@/api/types';
import { offline } from '@/offline/store';
import { C } from '@/theme';
import { Button, Empty, Loading, Note, Txt } from '@/ui/kit';
import { Schema } from '@/ui/Schema';
import { Ban, docDiff, fetchPosition, OptCard, posStore, RouteSheet, Soft, stamp } from './parts';

type Data = { order: string; server: ConflictT['server']; mine: Doc; mineAt: string; fromSync: boolean };

export default function Conflict() {
  const { id, pos } = useLocalSearchParams<{ id: string; pos?: string }>();
  const posId = typeof pos === 'string' ? pos : '';
  const win = useWindowDimensions();
  const [data, setData] = useState<Data | null | undefined>(undefined);
  const [pick, setPick] = useState<'mine' | 'theirs'>('mine');
  const [busy, setBusy] = useState<'mine' | 'theirs' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const snap = await offline.snapshot();
      const oc = snap.conflicts[posId];
      if (oc) {
        setData({ order: oc.order_id, server: oc.server, mine: oc.mine, mineAt: snap.positions[posId]?.updated_at ?? '', fromSync: true });
        return;
      }
      const c = posStore.conflict(posId);
      setData(c ? { order: id, server: c.server, mine: c.mine, mineAt: c.at, fromSync: false } : null);
    })().catch(() => setData(null));
  }, [id, posId]);

  const done = () => {
    posStore.clearConflict(posId);
    posStore.markStale(id, posId);
    router.back();
  };

  const keepMine = async () => {
    if (!data) return;
    setBusy('mine'); setErr(null);
    try {
      if (data.fromSync) { await offline.resolve(posId, 'mine'); await fetchPosition(data.order, posId).catch(() => null); } else {
        const out = await api.put<PositionOut>(`/oyna/orders/${data.order}/positions/${posId}`, { doc: data.mine, force: true });
        posStore.set(data.order, out);
      }
      done();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const keepTheirs = async () => {
    if (!data) return;
    setBusy('theirs'); setErr(null);
    try {
      if (data.fromSync) await offline.resolve(posId, 'server');
      await fetchPosition(data.order, posId).catch(() => null);   // свежая серверная версия — в кэш для листов
      done();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (data === undefined) return <RouteSheet><Loading /></RouteSheet>;
  if (data === null) {
    return (
      <RouteSheet>
        <Empty title="Конфликта уже нет" text="Версии совпали или выбор уже сделан" action={<Button title="Назад" kind="secondary" onPress={() => router.back()} />} />
      </RouteSheet>
    );
  }

  const room = data.mine.room || data.server.doc.room || 'Позиция';
  const diff = docDiff(data.mine, data.server.doc);
  const cardW = (win.width - 24 - 8) / 2;
  const schemaW = cardW - 28;
  const who = data.server.updated_by?.name ? data.server.updated_by.name : 'Другое устройство';

  const card = (side: 'mine' | 'theirs') => {
    const d = side === 'mine' ? data.mine : data.server.doc;
    const lines = side === 'mine' ? diff.mine : diff.theirs;
    return (
      <OptCard on={pick === side} onPress={() => setPick(side)} style={{ flex: 1, alignItems: 'center', gap: 8 }}>
        {data.server.deleted && side === 'theirs'
          ? <View style={{ height: 90, justifyContent: 'center' }}><Txt size={14} color={C.danger} w={600}>удалена</Txt></View>
          : <Schema doc={d} width={schemaW} maxHeight={120} dims={false} />}
        <Txt w={600} center lines={2}>{side === 'mine' ? 'Моя версия' : who}</Txt>
        <Txt size={13} color={C.muted} style={{ fontVariant: ['tabular-nums'] }}>{stamp(side === 'mine' ? data.mineAt : data.server.updated_at)}</Txt>
        {lines.slice(0, 4).map((l, i) => (
          <Txt key={i} size={13} center color={side === 'theirs' ? '#8A4B00' : C.muted} w={side === 'theirs' ? 600 : 400}>{l}</Txt>
        ))}
      </OptCard>
    );
  };

  return (
    <RouteSheet title={`${room} · две версии`} footer={(
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Soft title="Оставить их" onPress={() => void keepTheirs()} disabled={!!busy} style={{ flex: 1 }} />
        <Button title="Оставить мою" onPress={() => void keepMine()} loading={busy === 'mine'} disabled={busy === 'theirs'} style={{ flex: 1 }} />
      </View>
    )}>
      <Ban kind="est" title="Позицию изменили на другом устройстве" text="Выберите, какую версию оставить. Различия подсвечены" />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {card('mine')}
        {card('theirs')}
      </View>
      {!diff.mine.length ? <Note style={{ paddingHorizontal: 8 }}>На схеме различий не видно — отличаются служебные поля</Note> : null}
      {err ? <Note style={{ paddingHorizontal: 8, color: C.danger }}>{err}</Note> : null}
    </RouteSheet>
  );
}
