/**
 * SCR-02 Профиль цеха при первом входе (ShopProfile.dc.html): обязательны только название и город.
 * Логотип, условия оплаты и гарантия для КП — по желанию; наценка на работу — степпер (только владелец).
 */
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../src/api';
import type { UploadFile } from '../src/api/client';
import { useT } from '../src/i18n';
import { useSession } from '../src/state/session';
import { showError } from '../src/ui/dialogs';
import { Button, Card, Field, Footer, IconButton, Press, T } from '../src/ui/kit';
import { palette } from '../src/ui/theme';

const STEP = 5;

export default function WorkshopSetup() {
  const { t, lang } = useT();
  const { workshop, setWorkshop, isOwner } = useSession();
  const [name, setName] = useState(workshop?.name ?? '');
  const [city, setCity] = useState(workshop?.city || 'Ташкент');
  const [terms, setTerms] = useState(workshop?.kp_payment ?? '');
  const [warranty, setWarranty] = useState(workshop?.kp_warranty ?? '');
  const [logo, setLogo] = useState<string | null>(workshop?.logo_url ?? null);
  const [logoFile, setLogoFile] = useState<UploadFile | null>(null); // выбран новый — загрузим при сохранении
  const [labor, setLabor] = useState(workshop?.pricing?.labor_percent ?? 50);
  // из профиля («Данные цеха») — правка: «назад» вместо «Шаг 1 из 1 / Пропустить», после сохранения — обратно
  const [editing] = useState(() => !!workshop?.name && router.canGoBack());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pickLogo = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
    const a = !r.canceled ? r.assets[0] : undefined;
    if (!a) return;
    setLogo(a.uri);
    const type = a.mimeType ?? (/\.png$/i.test(a.uri) ? 'image/png' : /\.webp$/i.test(a.uri) ? 'image/webp' : 'image/jpeg');
    setLogoFile({ uri: a.uri, name: a.fileName ?? `logo.${type.split('/')[1]}`, type });
  };

  const save = async () => {
    if (!name.trim() || !city.trim()) return setErr(t('ws_required'));
    setBusy(true);
    try {
      let w = await api.updateWorkshop({
        name: name.trim(), city: city.trim(),
        kp_payment: terms.trim() || null, kp_warranty: warranty.trim() || null,
      });
      // логотип — файлом на сервер (POST /workshops/me/logo), как фото проекта
      if (logoFile) { w = await api.uploadLogo(logoFile); setLogoFile(null); }
      setWorkshop(w);
      if (isOwner && labor !== (workshop?.pricing?.labor_percent ?? 50)) {
        await api.updatePricing({ labor_mode: 'percent', labor_percent: labor }).catch(() => undefined);
      }
      if (editing) router.back(); else router.replace('/');
    } catch (e) {
      showError(e, lang);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.hdr}>
        {editing ? <IconButton icon="chevron-back" label={t('back')} onPress={() => router.back()} /> : (
          <>
            <View style={s.step}><T style={s.stepText} color={palette.muted2}>{t('ws_step')}</T></View>
            <View style={{ flex: 1 }} />
            <Button v="secondary" small title={t('skip')} onPress={() => router.replace('/')} style={{ borderRadius: 22 }} />
          </>
        )}
      </View>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <View style={{ paddingHorizontal: 8, paddingBottom: 6 }}>
          <T v="big">{t('ws_h')}</T>
          <T v="sub" style={{ marginTop: 8 }}>{t('ws_sub')}</T>
        </View>
        <Card padded={false} onPress={pickLogo} accessibilityLabel={t('ws_logo')}>
          <View style={s.logoRow}>
            <View style={s.logo}>
              {logo ? <Image source={{ uri: logo }} style={StyleSheet.absoluteFill} /> : <Ionicons name="camera-outline" size={26} color={palette.ink} />}
            </View>
            <View style={{ flex: 1 }}>
              <T v="rt">{logo ? t('ws_logo_change') : t('ws_logo')}</T>
              <T v="rs">{t('ws_logo_opt')}</T>
            </View>
            <Ionicons name="add" size={22} color={palette.chev} />
          </View>
        </Card>
        <Field label={t('ws_name_req')} placeholder={t('ws_name_ph')} value={name} onChangeText={(v) => { setName(v); setErr(null); }} error={err && !name.trim() ? err : null} />
        <Field label={t('ws_city_req')} value={city} onChangeText={(v) => { setCity(v); setErr(null); }} error={err && !city.trim() ? err : null} />
        <Field label={t('ws_terms')} placeholder={t('ws_terms_ph')} value={terms} onChangeText={setTerms} />
        <Field label={t('ws_warranty')} placeholder={t('ws_warranty_ph')} value={warranty} onChangeText={setWarranty} />
        {isOwner ? (
          <Card style={{ paddingVertical: 16, paddingHorizontal: 20, gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <T v="rt">{t('ws_markup')}</T>
                <T v="rs">{t('ws_markup_sub')}</T>
              </View>
              <View style={s.stepper}>
                <Press style={s.pm} accessibilityLabel={t('ws_less')} accessibilityRole="button" onPress={() => setLabor((v) => Math.max(0, v - STEP))}>
                  <T style={s.pmText}>−</T>
                </Press>
                <T num style={s.val}>{labor}<T style={s.unit}> %</T></T>
                <Press style={s.pm} accessibilityLabel={t('ws_more')} accessibilityRole="button" onPress={() => setLabor((v) => Math.min(300, v + STEP))}>
                  <T style={s.pmText}>+</T>
                </Press>
              </View>
            </View>
            <T v="cap">{t('ws_markup_hint')}</T>
          </Card>
        ) : null}
      </ScrollView>
      <Footer>
        <Button title={editing ? t('save') : t('ws_continue')} onPress={save} loading={busy} />
      </Footer>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.ground },
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 14, paddingHorizontal: 12, paddingBottom: 4, minHeight: 74 },
  step: { height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: palette.white, justifyContent: 'center' },
  stepText: { fontSize: 14, lineHeight: 18, fontWeight: '600' },
  body: { padding: 12, gap: 10 },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 16, paddingHorizontal: 20 },
  logo: { width: 72, height: 72, borderRadius: 22, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pm: { width: 40, height: 40, borderRadius: 12, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  pmText: { fontSize: 20, lineHeight: 24, fontWeight: '500' },
  val: { minWidth: 64, textAlign: 'center', fontSize: 24, lineHeight: 30, fontWeight: '700' },
  unit: { fontSize: 16, fontWeight: '500', color: palette.muted },
});
