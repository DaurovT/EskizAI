/**
 * SCR-45 (SystemStates.dc.html): «Обновите приложение», «Вышла новая версия», «Идут технические работы» — поверх всего приложения.
 * Знак Eskiz 96 с круглым значком (обновление — зелёный, техработы — янтарный), заголовок, текст, карточка с пунктами.
 */
import { Ionicons } from '@expo/vector-icons';
import { Linking, StyleSheet, View } from 'react-native';
import { SUPPORT_TG } from '../config';
import { useT } from '../i18n';
import { maintenanceEta, type SystemScreen as Screen } from '../lib/appStatus';
import { checkAppStatus, dismissOptional, useSystemChecking } from '../state/appStatus';
import { BrandLogo } from './Illus';
import { Button, Card, ListItem, Screen as Page, T, Tile } from './kit';
import { palette } from './theme';

export function SystemScreen({ screen }: { screen: Screen }) {
  const { t, lang } = useT();
  const checking = useSystemChecking();
  const update = () => { if (screen.kind !== 'maintenance') Linking.openURL(screen.storeUrl).catch(() => undefined); };
  const work = screen.kind === 'maintenance';

  let title = t('sys_req_title');
  let text = t('sys_req_text');
  if (screen.kind === 'optional') { title = t('sys_opt_title'); text = t('sys_opt_text'); }
  if (screen.kind === 'maintenance') { title = t('sys_work_title'); text = screen.message[lang] || t('sys_work_text'); }
  const eta = screen.kind === 'maintenance' ? maintenanceEta(screen.until) : null;
  const notes = screen.kind === 'optional' ? (screen.notes[lang].length ? screen.notes[lang] : screen.notes.ru) : [];

  const footer = work ? (
    <>
      <Button title={t('sys_check_again')} icon="refresh-outline" loading={checking} onPress={() => checkAppStatus()} />
      <Button v="ghost" icon="paper-plane-outline" title={t('sys_support_tg')} onPress={() => Linking.openURL(`https://t.me/${SUPPORT_TG}`)} />
    </>
  ) : (
    <>
      <Button title={t('sys_update')} onPress={update} />
      {screen.kind === 'optional' ? <Button v="ghost" color={palette.ink} title={t('sys_later')} onPress={() => dismissOptional()} /> : null}
    </>
  );

  return (
    <Page edges={['top', 'bottom']} footer={footer} contentStyle={s.body}>
      <View>
        <BrandLogo size={96} />
        <View style={[s.badge, { backgroundColor: work ? palette.amberSoft : palette.greenSoft }]}>
          <Ionicons name={work ? 'sunny-outline' : 'download-outline'} size={20} color={work ? palette.amberDeep : palette.greenDeep} />
        </View>
      </View>
      <T style={s.ttl} center>{title}</T>
      <T v="cap" center style={s.text}>{text}</T>
      {notes.length ? (
        <Card padded={false} style={s.card}>
          {notes.map((n, i) => <ListItem key={n} left={<Tile icon={i % 2 ? 'construct-outline' : 'sparkles-outline'} size="s" />} title={n} style={i ? s.sep : undefined} />)}
        </Card>
      ) : null}
      {work ? (
        <Card padded={false} style={s.card}>
          {eta ? <ListItem left={<Tile icon="time-outline" size="s" />} title={t('sys_work_until', { time: eta.time })} subtitle={t('sys_work_until_sub', { min: eta.minutes })} /> : null}
          <ListItem left={<Tile icon="checkmark" size="s" bg={palette.greenSoft} color={palette.greenDeep} />} title={t('sys_work_saved')} subtitle={t('sys_work_saved_sub')}
            style={eta ? s.sep : undefined} />
        </Card>
      ) : null}
    </Page>
  );
}

const s = StyleSheet.create({
  body: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingTop: 72 },
  badge: { position: 'absolute', right: -12, bottom: -12, width: 48, height: 48, borderRadius: 24, borderWidth: 4, borderColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  ttl: { marginTop: 6, fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.7 },
  text: { fontSize: 15, lineHeight: 21, maxWidth: 310 },
  card: { alignSelf: 'stretch', marginTop: 6 },
  sep: { borderTopWidth: 1, borderTopColor: palette.hair },
});
