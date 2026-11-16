/**
 * SCR-54 «Открыть в Eskiz DWG» (MOpenDwg.dc.html): шторка с превью и именем файла.
 * Eskiz DWG установлен (`Linking.canOpenURL("eskizdwg://")`, схема — в LSApplicationQueriesSchemes) — строка
 * «Открыть в Eskiz DWG» → `eskizdwg://open?src=<подписанная https-ссылка на .eskiz>&name=<имя файла>`.
 * Не установлен — «Установите Eskiz DWG» и значок магазина своей платформы (ссылка — заглушка до публикации DWG).
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useT } from '../i18n';
import { api } from '../api';
import type { SourceDrawingOut } from '../api/types';
import { DWG_SCHEME, DWG_STORE_URL, drawingKind, drawingTitle, dwgOpenUrl } from '../lib/inbox';
import { showError } from '../ui/dialogs';
import { DrawingThumb, DwgAppIcon } from '../ui/Drawing';
import { Group, ListItem, Press, Sheet, T, Loading } from '../ui/kit';
import { palette } from '../ui/theme';

export type DwgSource = { title: string; note: string; preview: string | null };

/** Установлен ли Eskiz DWG (null — ещё проверяем). `force` — состояние для снимков (dev). */
export function useDwgInstalled(active: boolean, force?: boolean): boolean | null {
  const [v, setV] = useState<boolean | null>(force ?? null);
  useEffect(() => {
    if (!active || force != null) return;
    Linking.canOpenURL(DWG_SCHEME).then(setV).catch(() => setV(false));
  }, [active, force]);
  return force ?? v;
}

export function OpenInDwgSheet({ visible, onClose, source, getLink, force }: {
  visible: boolean; onClose: () => void; source: DwgSource;
  /** Свежая подписанная ссылка на пакет и имя файла (ссылки живут 30 минут — берём в момент нажатия). */
  getLink: () => Promise<{ src: string; name: string }>;
  force?: boolean;
}) {
  const { t, lang } = useT();
  const installed = useDwgInstalled(visible, force);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const { src, name } = await getLink();
      await Linking.openURL(dwgOpenUrl(src, name));
      onClose();
    } catch (e) {
      showError(e instanceof Error && e.message ? e : new Error(t('odw_failed')), lang);
    } finally {
      setBusy(false);
    }
  };
  const ios = Platform.OS !== 'android';

  return (
    <Sheet visible={visible} onClose={onClose} variant="gray">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4, paddingBottom: 4 }}>
        <DrawingThumb uri={source.preview} width={52} height={38} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T style={{ fontSize: 20, lineHeight: 26, fontWeight: '700' }} numberOfLines={1}>{source.title}</T>
          <T v="cap">{source.note}</T>
        </View>
      </View>
      {installed == null ? <Loading /> : installed ? (
        <Group>
          <ListItem left={<DwgAppIcon size={40} radius={9} />} title={t('odw_title')} subtitle={t('odw_sub')} onPress={busy ? undefined : open}
            right={busy ? <Loading delay={0} /> : undefined} chevron={!busy} />
        </Group>
      ) : (
        <View style={{ gap: 10, paddingHorizontal: 4 }}>
          <DwgAppIcon size={56} radius={12} />
          <T style={{ fontSize: 20, lineHeight: 26, fontWeight: '700' }}>{t('odw_install_title')}</T>
          <T style={{ color: palette.muted, lineHeight: 21 }}>{t('odw_install_text')}</T>
          {/* значок только своего магазина (правила App Store не разрешают ссылаться на другие платформы) */}
          <Press accessibilityRole="link" accessibilityLabel={ios ? 'App Store' : 'Google Play'}
            onPress={() => Linking.openURL(ios ? DWG_STORE_URL.ios : DWG_STORE_URL.android).catch(() => undefined)} style={st.store}>
            <Ionicons name={ios ? 'logo-apple' : 'logo-google-playstore'} size={26} color={palette.white} />
            <View>
              <T style={{ fontSize: 11, lineHeight: 13, opacity: 0.8 }} color={palette.white}>{ios ? t('odw_store_ios_pre') : t('odw_store_android_pre')}</T>
              <T style={{ fontSize: 18, lineHeight: 21, fontWeight: '600', letterSpacing: -0.18 }} color={palette.white}>{ios ? 'App Store' : 'Google Play'}</T>
            </View>
          </Press>
        </View>
      )}
    </Sheet>
  );
}

const st = {
  store: { marginTop: 4, height: 54, borderRadius: 14, backgroundColor: '#000', flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 10 },
};

/** SCR-54 из проекта: исходный чертёж (`ProjectCardOut.source_drawing`), ссылка — GET /projects/{id}/source-drawing. */
export function ProjectDwgSheet({ projectId, drawing, preview, visible, onClose, force }: {
  projectId: string; drawing: SourceDrawingOut; preview?: string | null; visible: boolean; onClose: () => void; force?: boolean;
}) {
  const { t } = useT();
  const kind = drawingKind({ source_kind: drawing.source_kind, filename: drawing.filename }) ?? 'DWG';
  return (
    <OpenInDwgSheet visible={visible} onClose={onClose} force={force}
      source={{ title: drawingTitle(drawing), note: t('odw_source', { kind }), preview: preview ?? null }}
      getLink={async () => {
        const r = await api.getSourceDrawing(projectId);
        if (!r.download_url) throw new Error(t('odw_failed'));
        return { src: r.download_url, name: r.filename };
      }} />
  );
}
