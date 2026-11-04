/**
 * Инструмент «Декор» редактора: шторка с разделами — стиль фасада, материалы и цвет, подсветка, встройка
 * (у кухни ещё фурнитура: в её редакторе нет панели инструментов). Подписи — текущее состояние модели.
 */
import { router } from 'expo-router';
import type { LightingItem, ProductTree } from '../api/types';
import { useT } from '../i18n';
import { inlayOn, millingOn, overlayOn } from '../lib/decorStyle';
import { Button, Group, ListItem, Sheet } from '../ui/kit';

export function DecorMenu({ id, tree, visible, onClose, withHardware }: {
  id: string; tree: ProductTree; visible: boolean; onClose: () => void; withHardware?: boolean;
}) {
  const { t } = useT();
  const go = (path: string) => { onClose(); setTimeout(() => router.push(path as never), 260); };
  const st = tree.fronts?.style ?? {};
  const styleSub = [millingOn(st) ? t('dc_tab_milling') : null, overlayOn(st) ? t('dc_tab_overlay') : null, inlayOn(st) ? t('dc_tab_inlay') : null,
    st.paint ? st.paint.code : null].filter(Boolean).join(' · ') || t('ed2_m_style_sub');
  const lights = (tree.lighting as LightingItem[] | undefined) ?? [];
  const temps = [...new Set(lights.map((l) => l.temp ?? 4000))].join('/');
  const niche = tree.installation === 'niche' || !!tree.builtin;
  return (
    <Sheet variant="gray" visible={visible} onClose={onClose} title={t('ed_tool_decor')}>
      <Group>
        <ListItem icon="brush-outline" title={t('dc_title')} subtitle={styleSub} onPress={() => go(`/project/${id}/front-style`)} />
        <ListItem icon="color-palette-outline" title={t('ed2_m_mat')} subtitle={t('ed2_m_mat_sub')} onPress={() => go(`/project/${id}/materials`)} />
        <ListItem icon={lights.length ? 'bulb' : 'bulb-outline'} title={t('lt_title')} subtitle={lights.length ? t('ed2_m_light_sub', { n: lights.length, k: temps }) : t('lt_off')}
          onPress={() => go(`/project/${id}/lighting`)} />
        {tree.type === 'kitchen' || tree.type === 'wardrobe' || !tree.type ? (
          <ListItem icon="scan-outline" title={t('ed2_m_builtin')} subtitle={tree.type === 'kitchen' ? t('bi_k_panels') : niche ? t('bi_niche') : t('bi_free')}
            onPress={() => go(`/project/${id}/builtin`)} />
        ) : null}
        {withHardware ? <ListItem icon="hardware-chip-outline" title={t('ed2_m_hw')} subtitle={t('ed2_m_hw_sub')} onPress={() => go(`/project/${id}/hardware`)} /> : null}
      </Group>
      <Button v="secondary" title={t('close')} onPress={onClose} />
    </Sheet>
  );
}
