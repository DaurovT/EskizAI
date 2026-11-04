/**
 * SCR-35 Версии модели (Versions.dc.html): список версий с выбором, сравнение выбранной с текущей
 * (размеры, секции, детали — из summary), метки «заморожена» / «отправлена клиенту», откат к выбранной.
 */
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../../src/api';
import type { VersionBrief } from '../../../src/api/types';
import { useResource } from '../../../src/hooks/useResource';
import { useT } from '../../../src/i18n';
import { formatDate, groupDigits } from '../../../src/lib/format';
import { useOffline } from '../../../src/state/net';
import { confirm, showError } from '../../../src/ui/dialogs';
import { ErrorState } from '../../../src/ui/ErrorState';
import { Badge, Banner, Button, Card, Hairline, Loading, Press, Screen, T } from '../../../src/ui/kit';
import { bannerTones, palette } from '../../../src/ui/theme';

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

export default function Versions() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, td, lang } = useT();
  const offline = useOffline();
  const { data, error, loading, reload } = useResource(() => api.listVersions(id), [id]);
  const links = useResource(() => api.listShareLinks(id).catch(() => []), [id]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<string | null>(null);

  const list = [...(data ?? [])].sort((a, b) => b.number - a.number);
  const current = list.find((v) => v.is_current) ?? list[0];
  // по умолчанию — предыдущая версия: сразу видно, что изменилось
  useEffect(() => {
    if (sel || !list.length) return;
    setSel((list.find((v) => !v.is_current) ?? list[0]).id);
  }, [list, sel]);

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;

  const picked = list.find((v) => v.id === sel) ?? current;
  const frozen = list.find((v) => v.frozen);
  const sent = new Set((links.data ?? []).filter((l) => !l.revoked_at).map((l) => l.version_id));
  const today = new Date().toDateString();
  const when = (v: VersionBrief) => {
    const d = new Date(v.created_at).toDateString() === today ? t('ver_today', { time: hhmm(v.created_at) }) : `${formatDate(v.created_at, lang)} ${hhmm(v.created_at)}`;
    return `${d} · ${td(`ver_src_${v.source}`, v.source)}`;
  };

  // сравнение выбранной версии с текущей по summary и цене клиенту (price — с сервера)
  const diff: { a: string; b: string }[] = [];
  if (picked && current && picked.id !== current.id) {
    const a = picked.summary ?? {}, b = current.summary ?? {};
    const dims: [string, number][] = [[t('ver_width'), 0], [t('ver_height'), 1], [t('ver_depth'), 2]];
    for (const [label, i] of dims) {
      const x = a.size_mm?.[i], y = b.size_mm?.[i];
      if (x != null && y != null && Math.round(x) !== Math.round(y)) diff.push({ a: label, b: `${groupDigits(x)} → ${groupDigits(y)}` });
    }
    if (a.sections != null && b.sections != null && a.sections !== b.sections) diff.push({ a: t('ver_sections'), b: `${a.sections} → ${b.sections}` });
    if (a.parts_count != null && b.parts_count != null && a.parts_count !== b.parts_count) diff.push({ a: t('ver_parts'), b: `${a.parts_count} → ${b.parts_count}` });
    // «Итог клиенту + 340 000»: разница середин вилки цены
    const pa = picked.price, pb = current.price;
    if (pa && pb) {
      const d = Math.round((pb.from + pb.to) / 2 - (pa.from + pa.to) / 2);
      if (d !== 0) diff.push({ a: t('ver_client_total'), b: `${d > 0 ? '+' : '−'} ${groupDigits(Math.abs(d))}` });
    }
  }
  const isCur = picked?.id === current?.id;

  const restore = async (v: VersionBrief) => {
    if (!(await confirm(t('ver_restore'), t('ver_restore_confirm', { n: v.number }), t('confirm'), t('cancel')))) return;
    setBusy(true);
    try {
      await api.restoreVersion(id, v.id);
      router.replace(`/project/${id}/editor`);
    } catch (e) { showError(e, lang); } finally { setBusy(false); }
  };

  const canRollback = !!picked && !isCur && !frozen && !picked.frozen;
  return (
    <Screen
      contentStyle={{ paddingTop: 4, gap: 8 }}
      footer={canRollback && picked ? <Button v="secondary" icon="arrow-undo-outline" title={t('ver_rollback', { n: picked.number })} onPress={() => restore(picked)} loading={busy} disabled={offline} /> : undefined}
    >
      <Stack.Screen options={{ title: '' }} />
      <T v="big" style={{ paddingHorizontal: 8 }}>{t('ver_title')}</T>
      <T v="cap" style={{ paddingHorizontal: 8, paddingBottom: 4 }}>{t('ver_pick')}</T>
      <Card padded={false}>
        {list.map((v, i) => {
          const on = v.id === picked?.id;
          const tag = v.frozen ? { l: t('ver_frozen_tag'), tone: 'blue' as const } : sent.has(v.id) ? { l: t('ver_sent_tag'), tone: 'green' as const } : null;
          return (
            <View key={v.id}>
              {i ? <Hairline /> : null}
              <Press feedback="row" onPress={() => setSel(v.id)} style={s.vr} accessibilityRole="radio" accessibilityState={{ selected: on }}>
                <View style={[s.vn, on && { backgroundColor: palette.ink }]}><T num style={s.vnText} color={on ? palette.white : palette.ink}>v{v.number}</T></View>
                <View style={{ flex: 1 }}>
                  <T v="rt">{v.label || td(`ver_src_${v.source}`, v.source)}</T>
                  <T v="rs">{when(v)}</T>
                  {tag ? <Badge label={tag.l} tone={tag.tone} style={{ marginTop: 6, alignSelf: 'flex-start' }} /> : null}
                  {!v.ok ? <Badge label={t('ver_errors')} tone="red" style={{ marginTop: 6, alignSelf: 'flex-start' }} /> : null}
                </View>
                <View style={[s.rad, on && s.radOn]}>{on ? <Ionicons name="checkmark" size={14} color={palette.white} /> : null}</View>
              </Press>
            </View>
          );
        })}
      </Card>
      <Card style={{ paddingTop: 16, paddingHorizontal: 20, paddingBottom: 8 }}>
        <T style={s.cmpTitle}>{isCur ? t('ver_cmp_current') : t('ver_cmp', { a: picked?.number ?? '', b: current?.number ?? '' })}</T>
        {(isCur ? [{ a: t('ver_is_current'), b: '' }] : diff.length ? diff : [{ a: t('ver_no_diff'), b: '' }]).map((d, i) => (
          <View key={d.a}>
            {i ? <Hairline /> : null}
            <View style={s.df}><T v="rs" style={{ fontSize: 16 }}>{d.a}</T><T v="rv">{d.b}</T></View>
          </View>
        ))}
      </Card>
      {frozen ? (
        <Banner tone="info" icon="lock-closed-outline" style={{ alignItems: 'flex-start' }}>
          <T style={{ fontSize: 15, lineHeight: 20 }} color={bannerTones.info.fg}>{t('ver_frozen_note', { n: frozen.number })}</T>
        </Banner>
      ) : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  vr: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 14, paddingHorizontal: 20 },
  vn: { width: 40, height: 40, borderRadius: 14, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  vnText: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  rad: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: palette.handle, marginTop: 8, alignItems: 'center', justifyContent: 'center' },
  radOn: { backgroundColor: palette.ink, borderWidth: 0 },
  cmpTitle: { fontSize: 18, lineHeight: 24, fontWeight: '700', marginBottom: 4 },
  df: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
});
