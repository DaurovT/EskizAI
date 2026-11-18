/**
 * S07 «Шаблоны» → габарит → позиция в заказ — макеты Templates, TemplateSize, TemplateSizeErr.
 * GET /oyna/templates; миниатюры и проверка габарита — POST /oyna/positions/from-template (doc + result.violations).
 * Схема при вводе размера рисуется на телефоне (Schema); «не помещается» (1.4) — и с сервера, и локально (layout().error).
 * «Добавить в заказ» → PUT /oyna/orders/{id}/positions/{uuid}; без сети или заказ ещё на телефоне — offline.savePosition.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';

import { api, ApiError, errorText } from '@/api/http';
import type { Doc, OrderFull, Setup, Template, Validation, Violation } from '@/api/types';
import { num } from '@/lib/format';
import { layout } from '@/lib/tree';
import { useLoad } from '@/lib/useLoad';
import { offline, uuid } from '@/offline/store';
import { C } from '@/theme';
import { Body, Button, Empty, ErrorText, Field, IconButton, LoadError, Loading, Screen, Seg, Txt } from '@/ui/kit';
import { Schema } from '@/ui/Schema';
import { Ban, CompanyOut, KbSheet, Tag, WindowThumb } from './parts';

type Tab = 'all' | 'window' | 'balcony' | 'door' | 'mine';
const TABS: { value: Tab; title: string }[] = [
  { value: 'all', title: 'Все' }, { value: 'window', title: 'Окна' }, { value: 'balcony', title: 'Балконные' },
  { value: 'door', title: 'Двери' }, { value: 'mine', title: 'Мои' },
];
const inTab = (t: Template, tab: Tab) =>
  tab === 'all' || (tab === 'window' ? ['window', 'sliding', 'assembly'].includes(t.category) : t.category === tab);

const MIN = 200, MAX = 9000; // мм — отсечь опечатки; настоящие пределы проверяет сервер
type FromTpl = { doc: Doc; result: Validation };
/** За запуск: список шаблонов и их изделия по умолчанию (для миниатюр и расчёта без сети). */
let listCache: Template[] | null = null;
const docCache: Record<string, Doc> = {};

export default function Templates() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState<Tab>('all');
  const [docs, setDocs] = useState<Record<string, Doc>>({ ...docCache });
  const [picked, setPicked] = useState<Template | null>(null);
  const [ctx, setCtx] = useState<{ setup?: Setup; kit?: string | null }>({});

  const { data, error, loading, reload } = useLoad<Template[]>(async () => {
    try {
      const list = await api.get<Template[]>('/oyna/templates');
      listCache = list;
      return list;
    } catch (e) {
      if (e instanceof ApiError && e.isNetwork && listCache) return listCache;
      throw e;
    }
  }, []);

  // комплектация заказа: настройка первой позиции → комплектация заказа → по умолчанию
  useEffect(() => {
    let alive = true;
    (async () => {
      const snap = await offline.snapshot();
      const localSetup = Object.values(snap.positions).find((p) => p.order_id === id && !p.deleted && p.doc.setup)?.doc.setup;
      const [o, co] = await Promise.allSettled([api.get<OrderFull>(`/oyna/orders/${id}`), api.get<CompanyOut>('/oyna/company')]);
      const full = o.status === 'fulfilled' ? o.value : null;
      const kits = co.status === 'fulfilled' ? co.value.kits : [];
      const posSetup = full?.positions.find((p) => !p.deleted && p.doc.setup)?.doc.setup;
      const kit = full?.kit_name ? kits.find((k) => k.name === full.kit_name) : undefined;
      if (alive) setCtx({ setup: posSetup ?? kit?.setup ?? localSetup, kit: full?.kit_name ?? null });
    })().catch(() => { /* без сети — настройка по умолчанию */ });
    return () => { alive = false; };
  }, [id]);

  // миниатюры: изделие каждого готового шаблона в размере по умолчанию
  useEffect(() => {
    if (!data) return;
    let alive = true;
    const local: Record<string, Doc> = {};
    for (const t of data as (Template & { root?: Doc['frame']['root'] })[]) {   // сервер отдаёт дерево — без запросов
      if (t.root && !docCache[t.id]) {
        docCache[t.id] = { kind: t.kind, qty: 1, frame: { w: t.default_w, h: t.default_h, shape: 'rect', root: t.root } };
        local[t.id] = docCache[t.id];
      }
    }
    if (Object.keys(local).length) setDocs((d) => ({ ...d, ...local }));
    for (const t of data) {
      if (!t.ready || docCache[t.id]) continue;
      api.post<FromTpl>('/oyna/positions/from-template', { template: t.id }).then((r) => {
        docCache[t.id] = r.doc;
        if (alive) setDocs((d) => ({ ...d, [t.id]: r.doc }));
      }).catch(() => { /* без миниатюры */ });
    }
    return () => { alive = false; };
  }, [data]);

  const back = () => (router.canGoBack() ? router.back() : router.replace(`/order/${id}`));
  const list = (data ?? []).filter((t) => inTab(t, tab));
  const cardW = Math.floor((width - 24 - 16) / 3);

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 4, minHeight: 56 }}>
        <IconButton name="back" label="Назад" onPress={back} />
        <View style={{ flex: 1 }} />
      </View>
      <Txt size={30} w={700} style={{ lineHeight: 36, letterSpacing: -0.75, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 4 }}>Шаблоны</Txt>
      {!data && loading ? <Loading /> : !data ? <LoadError message={error ?? ''} onRetry={reload} /> : (
        <Body style={{ paddingTop: 6, gap: 10, paddingBottom: 32 }}>
          <Seg chips items={TABS} value={tab} onChange={setTab} />
          {tab === 'mine' ? (
            <Empty title="Свои шаблоны — скоро" text="Частые изделия цеха можно будет сохранить как шаблон и собирать в одно нажатие" />
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12 }}>
              {list.map((t) => (
                <Pressable key={t.id} accessibilityRole="button" accessibilityLabel={t.name} accessibilityState={{ disabled: !t.ready }}
                  disabled={!t.ready} onPress={() => setPicked(t)}
                  style={({ pressed }) => [{ width: cardW, borderRadius: 22, backgroundColor: C.card, padding: 10, gap: 6, alignItems: 'center' },
                    { transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
                  <View style={{ height: 74, justifyContent: 'center', opacity: t.ready ? 1 : 0.45 }}>
                    {docs[t.id] ? <Schema doc={docs[t.id]} width={cardW - 24} maxHeight={72} dims={false} /> : <WindowThumb width={56} height={50} />}
                  </View>
                  <View style={{ minHeight: 36, justifyContent: 'center' }}>
                    <Txt size={14} w={600} center style={{ lineHeight: 18 }} color={t.ready ? C.ink : C.muted}>{t.name}</Txt>
                  </View>
                  <Txt size={11} color={C.muted}>{t.id}</Txt>
                  {!t.ready ? <View style={{ position: 'absolute', top: 8, right: 8 }}><Tag kind="n" title="скоро" /></View> : null}
                </Pressable>
              ))}
            </View>
          )}
        </Body>
      )}
      {picked ? (
        <SizeSheet t={picked} base={docs[picked.id] ?? null} setup={ctx.setup} kit={ctx.kit ?? null} orderId={id}
          onClose={() => setPicked(null)}
          onAdded={() => { setPicked(null); router.dismissTo(`/order/${id}`); }} />
      ) : null}
    </Screen>
  );
}

// ---------- габарит (TemplateSize / TemplateSizeErr) ----------
function SizeSheet({ t, base, setup, kit, orderId, onClose, onAdded }: {
  t: Template; base: Doc | null; setup?: Setup; kit: string | null; orderId: string; onClose: () => void; onAdded: () => void;
}) {
  const [w, setW] = useState(String(t.default_w));
  const [h, setH] = useState(String(t.default_h));
  const [server, setServer] = useState<{ key: string; doc: Doc; violations: Violation[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [offlineCheck, setOfflineCheck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wn = parseInt(w, 10) || 0, hn = parseInt(h, 10) || 0;
  const key = `${wn}x${hn}`;
  const valid = wn >= MIN && wn <= MAX && hn >= MIN && hn <= MAX;

  // проверка на сервере — с задержкой после ввода
  const seq = useRef(0);
  useEffect(() => {
    if (!valid) return;
    const n = ++seq.current;
    setChecking(true);
    const timer = setTimeout(() => {
      api.post<FromTpl>('/oyna/positions/from-template', { template: t.id, w: wn, h: hn, setup: setup ?? null })
        .then((r) => { if (n === seq.current) { setServer({ key, doc: r.doc, violations: r.result.violations }); setOfflineCheck(false); } })
        .catch((e) => { if (n === seq.current && e instanceof ApiError && e.isNetwork) setOfflineCheck(true); })
        .finally(() => { if (n === seq.current) setChecking(false); });
    }, 350);
    return () => clearTimeout(timer);
  }, [key, valid, t.id, setup]); // eslint-disable-line react-hooks/exhaustive-deps

  // изделие для схемы: ответ сервера на этот размер, иначе шаблон с новым габаритом (то же делает сервер)
  const doc: Doc | null = useMemo(() => {
    if (server?.key === key) return server.doc;
    const src = server?.doc ?? base;
    if (!src || !valid) return src;
    return { ...src, ...(setup ? { setup } : {}), frame: { ...src.frame, w: wn, h: hn } };
  }, [server, base, key, valid, wn, hn, setup]);

  const fresh = server?.key === key;
  const vs = fresh ? server.violations : [];
  const geo = useMemo(() => (doc && valid ? layout(doc) : null), [doc, valid]);
  // сервер ответил на этот размер — верим ему; пока нет (или нет сети) — проверка на телефоне
  const fitErr = fresh ? vs.find((v) => v.code === '1.4')
    : geo?.error ? ({ code: '1.4', severity: 'block', title: geo.error, accepted: false } as Violation) : undefined;
  const blocks = vs.filter((v) => (v.severity === 'block' || v.severity === 'lock') && !v.accepted && v.code !== '1.4');
  const warns = vs.filter((v) => v.severity === 'warn' && !v.accepted);

  const vertical = doc?.frame.root.split !== 'h';
  const fixedSum = t.fixed_parts.filter((p) => !p.path.includes('.')).reduce((s, p) => s + p.size, 0);
  const sizes = geo?.sizes[''] ?? [];
  const partsLine = sizes.length > 1
    ? sizes.map((s, i) => (t.fixed_parts.some((p) => p.path === String(i)) ? num(s) : fitErr ? '—' : num(Math.round(s)))).join(' · ')
    : '';
  const dimWord = vertical ? 'ширину' : 'высоту';
  const dimVal = vertical ? wn : hn;

  const add = async () => {
    if (!doc) return;
    setBusy(true); setErr(null);
    const pid = uuid();
    const out: Doc = { ...doc, id: pid };
    try {
      const snap = await offline.snapshot();
      const onPhoneOnly = !!snap.orders[orderId] && !snap.orders[orderId].synced;
      if (!onPhoneOnly) {
        try {
          await api.put(`/oyna/orders/${orderId}/positions/${pid}`, { doc: out, base_rev: null });
          onAdded();
          return;
        } catch (e) {
          if (!(e instanceof ApiError && e.isNetwork)) { setErr(errorText(e)); return; }
        }
      }
      await offline.savePosition(orderId, out, { id: pid, base_rev: null });
      void offline.sync().catch(() => { /* уйдёт, когда появится сеть */ });
      onAdded();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const can = !!doc && valid && !fitErr && !blocks.length && !busy && (fresh || offlineCheck || !checking);
  return (
    <KbSheet visible onClose={onClose}>
      <View style={{ paddingHorizontal: 12, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 6, paddingBottom: 4 }}>
          <View style={{ width: 72, height: 72, borderRadius: 16, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
            {doc ? <Schema doc={doc} width={64} maxHeight={64} dims={false} violations={vs} /> : <WindowThumb width={56} height={50} />}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt size={20} w={700} lines={2} style={{ lineHeight: 26, letterSpacing: -0.3 }}>{t.name}</Txt>
            <Txt size={14} color={C.muted}>{[t.id, kit].filter(Boolean).join(' · ')}</Txt>
            {partsLine ? <Txt size={14} color={C.muted} style={{ marginTop: 4, fontVariant: ['tabular-nums'] }}>{partsLine}</Txt> : null}
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="Ширина, мм" value={w} onChangeText={(x) => setW(x.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" autoFocus
            error={(!!fitErr && vertical) || (w !== '' && !(wn >= MIN && wn <= MAX))} style={{ flex: 1 }} inputStyle={{ fontVariant: ['tabular-nums'] }} />
          <Field label="Высота, мм" value={h} onChangeText={(x) => setH(x.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad"
            error={(!!fitErr && !vertical) || (h !== '' && !(hn >= MIN && hn <= MAX))} style={{ flex: 1 }} inputStyle={{ fontVariant: ['tabular-nums'] }} />
        </View>

        {fitErr ? (
          <Ban kind="err" icon="warn" title={fixedSum ? `${num(fixedSum)} мм не помещается в ${num(dimVal)}` : 'Части не помещаются в размер'}
            text={`Зафиксированная часть ${vertical ? 'шире' : 'выше'} изделия (1.4). Увеличьте ${dimWord}`} />
        ) : blocks.length ? (
          <Ban kind="err" icon="warn" title={blocks[0].title} text={blocks[0].fix ? `${blocks[0].msg ?? ''} ${blocks[0].fix}`.trim() : blocks[0].msg} />
        ) : (
          <>
            {!valid ? <Txt size={14} color={C.muted} style={{ paddingHorizontal: 6 }}>Ширина 300–6000 мм, высота 300–3500 мм</Txt>
              : fixedSum ? <Txt size={14} color={C.muted} style={{ paddingHorizontal: 6 }}>{`Часть ${num(fixedSum)} мм зафиксирована, остальное делится поровну`}</Txt> : null}
            {warns.length ? <Ban kind="est" icon="warn" title={warns[0].title} text={warns.length > 1 ? `и ещё ${warns.length - 1} — проверьте в редакторе` : warns[0].msg} /> : null}
            {offlineCheck ? <Txt size={14} color={C.muted} style={{ paddingHorizontal: 6 }}>Нет интернета — проверим и посчитаем, когда появится сеть</Txt> : null}
          </>
        )}
        {!base && !server ? <Txt size={14} color={C.muted} style={{ paddingHorizontal: 6 }}>{checking ? 'Загружаем шаблон…' : 'Шаблон загрузится, когда появится интернет'}</Txt> : null}
        <ErrorText>{err}</ErrorText>
        <View style={{ paddingTop: 4, paddingBottom: 4 }}>
          <Button title="Добавить в заказ" onPress={add} disabled={!can} loading={busy} />
        </View>
      </View>
    </KbSheet>
  );
}
