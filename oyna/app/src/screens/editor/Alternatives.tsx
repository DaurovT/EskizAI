/**
 * Лист «варианты замены» — макет Alternatives (docs/design).
 * POST /oyna/positions/alternatives {doc, what, path} → совместимые варианты с разницей в цене и «Недоступно (N)»
 * с причиной (FR-F8, lock). Выбор → команда позиции (set_setup / set_option / set_fill) → назад.
 * Смена системы тянет другие детали — сначала лист «замена тянет другие» (/swap).
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { api, errorText } from '@/api/http';
import type { Command, Doc } from '@/api/types';
import { C } from '@/theme';
import { Icon } from '@/ui/Icon';
import { LoadError, Loading, Note, Txt } from '@/ui/kit';
import {
  AltOption, AltResult, cellAt, cellTitle, Ck, ConflictError, delta, RouteSheet, sendCommands, st, Tag, usePosition, WHAT_TITLE,
} from './parts';

const CURRENT: Record<string, string> = { 'option:handle': 'текущая', 'option:hinge': 'текущие', 'option:security': 'текущие', 'option:hinge_cap': 'текущие' };

/** Команда для выбранного варианта. */
export function altCommand(what: string, value: string, path?: string): Command {
  if (what === 'system') return { cmd: 'set_setup', system: value };
  if (what === 'fittings') return { cmd: 'set_setup', fittings: value };
  if (what === 'decor_out') return { cmd: 'set_setup', color_out: value };
  if (what === 'decor_in') return { cmd: 'set_setup', color_in: value };
  if (what === 'glass') return path !== undefined ? { cmd: 'set_fill', path, fill: { kind: 'glass', glass: value } } : { cmd: 'set_setup', glass: value };
  if (what.startsWith('option:')) return { cmd: 'set_option', group: what.slice(7), code: value, path: path ?? null };
  throw new Error(`неизвестно, что заменять: ${what}`);
}

/** «7.2 паз … не подходит» → «паз … не подходит (7.2)» */
const reason = (b: string) => { const m = /^(\d+\.\d+)\s+(.*)$/.exec(b); return m ? `${m[2]} (${m[1]})` : b; };

function isCurrent(o: AltOption, what: string, doc: Doc, path?: string): boolean {
  const cell = path !== undefined ? cellAt(doc, path) : null;
  if (what.startsWith('option:')) {
    const g = what.slice(7);
    const code = cell?.options?.[g] ?? doc.setup?.options?.[g];
    return code ? o.value === code : !!o.is_default;
  }
  if (what === 'glass' && cell?.fill?.kind === 'glass') return o.value === cell.fill.glass;
  return o.current;
}

export default function Alternatives() {
  const { id, pos, what: w, path: pth } = useLocalSearchParams<{ id: string; pos?: string; what?: string; path?: string }>();
  const what = typeof w === 'string' && w ? w : 'fittings';
  const path = typeof pth === 'string' ? pth : undefined;
  const P = usePosition(id, pos);
  const [res, setRes] = useState<AltResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openLocked, setOpenLocked] = useState(true);

  const doc = P.pos?.doc;
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    setErr(null);
    api.post<AltResult>('/oyna/positions/alternatives', { doc, what, path: path ?? null })
      .then((r) => { if (alive) setRes(r); })
      .catch((e) => { if (alive) setErr(errorText(e)); });
    return () => { alive = false; };
  }, [doc, what, path]);

  const title = `${WHAT_TITLE[what] ?? what}${doc && path !== undefined && cellAt(doc, path) ? ` · ${cellTitle(doc, path).toLowerCase()}` : ''}`;

  const choose = async (o: AltOption) => {
    if (!P.pos || busy) return;
    if (isCurrent(o, what, P.pos.doc, path)) { router.back(); return; }
    if (what === 'system') {                                   // тянет фурнитуру, стекло — сначала показать что изменится
      router.replace(`/order/${id}/swap?pos=${P.pos.id}&what=system&value=${encodeURIComponent(o.value)}`);
      return;
    }
    setBusy(o.value);
    try {
      const out = await sendCommands(id, P.pos, [altCommand(what, o.value, path)]);
      P.update(out);
      router.back();
    } catch (e) {
      if (!(e instanceof ConflictError)) setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  let body;
  if ((P.loading && !P.pos) || (!res && !err && !P.error)) body = <Loading />;
  else if (P.error || !P.pos) body = <LoadError message={P.error ?? 'Позиция не найдена'} onRetry={() => void P.reload(true)} />;
  else if (!res) body = <LoadError message={err ?? ''} />;
  else {
    const curWord = CURRENT[what] ?? 'текущий';
    const posDoc = P.pos.doc;
    body = (
      <>
        {err ? <Note style={{ paddingHorizontal: 8, color: C.danger }}>{err}</Note> : null}
        {res.options.length ? (
          <View style={st.sheetBox}>
            {res.options.map((o, i) => {
              const cur = isCurrent(o, what, posDoc, path);
              const sub = [
                o.thickness_mm ? `${o.thickness_mm} мм` : '', o.is_default ? 'по умолчанию' : '',
                o.complete === false ? 'не всё в прайсе' : '',
              ].filter(Boolean).join(' · ');
              return (
                <Pressable key={o.value} accessibilityRole="button" accessibilityState={{ selected: cur }} onPress={() => void choose(o)}
                  style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingHorizontal: 20, paddingVertical: 10 },
                    i > 0 && { borderTopWidth: 1, borderTopColor: C.line }, pressed && { backgroundColor: '#F7F7F5' }]}>
                  <Ck on={cur} />
                  {o.hex ? <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: o.hex, borderWidth: 1, borderColor: C.line }} /> : null}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Txt w={600} lines={2}>{o.label}</Txt>
                    {sub ? <Note>{sub}</Note> : null}
                  </View>
                  {o.demo ? <Tag kind="est" title="ДЕМО" /> : null}
                  {busy === o.value ? <ActivityIndicator color={C.accent} /> : (
                    <Txt size={15} w={600} color={cur ? C.ink : C.muted} style={{ fontVariant: ['tabular-nums'] }}>
                      {cur ? curWord : o.delta == null ? 'нет цены' : delta(o.delta)}
                    </Txt>
                  )}
                </Pressable>
              );
            })}
          </View>
        ) : <Note style={{ paddingHorizontal: 8 }}>Совместимых вариантов нет</Note>}
        {res.locked.length ? (
          <View style={st.sheetBox}>
            <Pressable onPress={() => setOpenLocked((x) => !x)} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 60, paddingHorizontal: 20 }}>
              <Txt w={500} color={C.muted} style={{ flex: 1 }}>Недоступно ({res.locked.length})</Txt>
              <View style={{ transform: [{ rotate: openLocked ? '90deg' : '0deg' }] }}><Icon name="chevron" size={20} color="#B4B1AB" /></View>
            </Pressable>
            {openLocked ? res.locked.map((o) => (
              <View key={o.value} style={{ minHeight: 52, paddingHorizontal: 20, paddingVertical: 8, justifyContent: 'center', borderTopWidth: 1, borderTopColor: C.line }}>
                <Txt size={14} color={C.muted}>
                  <Txt size={14} w={600} color="#55524D">{o.label}</Txt>
                  {o.blocking?.length ? ` — ${o.blocking.map(reason).join('; ')}` : ''}
                </Txt>
              </View>
            )) : null}
          </View>
        ) : null}
        <Txt size={14} color={C.muted} style={{ paddingHorizontal: 8 }}>Разница — на позицию, для клиента</Txt>
      </>
    );
  }

  return <RouteSheet title={title} full>{body}</RouteSheet>;
}
