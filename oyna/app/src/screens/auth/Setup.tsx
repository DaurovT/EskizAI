/**
 * S02 Создание цеха — макеты Setup1 (реквизиты), Setup2 (системы), Setup3 (сам варю / заказываю), Setup6 («Цех готов»).
 * Шаги 4 (наценка) и 5 (курс доллара) — без отдельного макета, собраны из тех же деталей.
 * Любой шаг можно пропустить: тогда цех получает значения сервера по умолчанию, а на «Цех готов» шаг попадает в «Не настроено».
 * Цех создаётся после шага 5 (useAuth().createCompany), шаг 6 — итог.
 */
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert, BackHandler, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';

import { api, errorText } from '@/api/http';
import { CompanyIn, useAuth } from '@/auth/AuthContext';
import { num, phone as fmtPhone } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { C } from '@/theme';
import { Body, Button, Card, Dock, ErrorText, Field, IconButton, Loading, LoadError, Note, Row, Screen, Seg, Txt } from '@/ui/kit';
import {
  Ban, digits, Fx, markupText, parseNum, plural, St, SystemPicker, SystemRow, Tile, WindowArt, XIcon,
} from '../profile/parts';
import { OptCard, Prog } from './parts';

const TOTAL = 6;
/** Системы демо-комплектаций «Эконом / Стандарт / Тёплый» (oyna_data/demo_company.json) — выбраны сразу, как в макете. */
const DEFAULT_SYSTEMS = ['akfa__6000_qvt', 'akfa__6000_trio', 'akfa__7000_akfa_eko'];
const SERVER_DEFAULT_SYSTEM = 'akfa__6000_qvt';
const STEP_NAME: Record<number, string> = { 1: 'название и телефон', 2: 'системы', 3: 'способ работы', 4: 'наценка', 5: 'курс доллара' };

export default function Setup() {
  const router = useRouter();
  const { user, createCompany } = useAuth();

  const [step, setStep] = useState(1);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  // шаг 1
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(user?.phone ? fmtPhone(user.phone) : '');
  // шаг 2
  const systems = useLoad(() => api.get<SystemRow[]>('/oyna/systems'));
  const [picked, setPicked] = useState<string[] | null>(null);
  // шаг 3
  const [mode, setMode] = useState<'manufacturer' | 'dealer'>('manufacturer');
  const [coef, setCoef] = useState('25');
  // шаг 4
  const [markupKind, setMarkupKind] = useState<'percent' | 'margin'>('percent');
  const [markup, setMarkup] = useState('30');
  // шаг 5
  const fx = useLoad(() => api.get<Fx>('/oyna/fx/usd'));
  const [ownRate, setOwnRate] = useState(false);
  const [rate, setRate] = useState('');
  const [lang, setLang] = useState<'ru' | 'uz'>('ru');
  // создание
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // по умолчанию — системы демо-комплектаций, какие есть в справочнике
  const selected = useMemo(() => {
    if (picked) return picked;
    const have = new Set((systems.data ?? []).map((s) => s.code));
    return DEFAULT_SYSTEMS.filter((c) => have.has(c));
  }, [picked, systems.data]);
  const toggle = (code: string) => setPicked(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code]);

  const back = () => { if (step > 1 && step < TOTAL && !busy) setStep(step - 1); };
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step > 1 && step < TOTAL) { back(); return true; }
      return step === TOTAL; // с «Цех готов» назад не уходим — цех уже создан
    });
    return () => sub.remove();
  });

  const coefNum = parseNum(coef);
  const markupNum = parseNum(markup);
  const rateNum = parseNum(rate);
  const stepError =
    step === 3 && mode === 'dealer' && (coefNum === null || coefNum < 0 || coefNum > 300) ? 'Коэффициент — от 0 до 300 %'
      : step === 4 && (markupNum === null || markupNum < 0 || (markupKind === 'margin' ? markupNum >= 95 : markupNum > 1000))
        ? (markupKind === 'margin' ? 'Доля маржи — от 0 до 94 %' : 'Наценка — от 0 до 1000 %')
        : step === 5 && ownRate && (rateNum === null || rateNum < 1000) ? 'Введите курс, например 12 010,45' : null;

  function payload(skip: Set<number>): CompanyIn {
    const body: CompanyIn = { name: (!skip.has(1) && name.trim()) || 'Мой цех', lang_default: lang };
    if (!skip.has(1) && digits(phone).length >= 9) body.phone = phone.trim();
    if (!skip.has(2) && selected.length) body.systems = selected;
    if (!skip.has(3)) {
      body.mode = mode;
      if (mode === 'dealer' && coefNum !== null) body.dealer_coef = Math.round(coefNum * 10) / 1000; // 25 % → 0.25
    }
    if (!skip.has(4) && markupNum !== null) { body.markup_kind = markupKind; body.markup_value = markupNum; }
    if (!skip.has(5) && ownRate && rateNum !== null) body.usd_rate = rateNum;
    return body;
  }

  async function finish(skip: Set<number>) {
    setBusy(true); setError(null);
    try {
      await createCompany(payload(skip));
      setStep(TOTAL);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function next(skip: boolean) {
    const s = new Set(skipped);
    if (skip) s.add(step); else s.delete(step);
    setSkipped(s);
    if (!skip && stepError) return;
    if (step === 5) void finish(s);
    else setStep(step + 1);
  }

  // ---------- шаг 6: «Цех готов» ----------
  if (step === TOTAL) {
    const sysCount = skipped.has(2) || !selected.length ? 1 : selected.length;
    const brands = [...new Set((systems.data ?? []).filter((s) => (skipped.has(2) || !selected.length ? s.code === SERVER_DEFAULT_SYSTEM : selected.includes(s.code))).map((s) => s.brand))];
    const mk = skipped.has(4) ? markupText('percent', 30) : markupText(markupKind, markupNum);
    const fxText = !skipped.has(5) && ownRate && rateNum ? `свой курс ${num(rateNum, 2)}` : fx.data?.rate ? `курс ЦБ ${num(fx.data.rate, 2)}` : 'курс ЦБ';
    const sub = [`${sysCount} ${plural(sysCount, 'система', 'системы', 'систем')}${brands.length ? ' ' + brands.join(', ') : ''}`, mk, fxText].join(' · ');
    const notSet = [...[...skipped].sort().map((n) => STEP_NAME[n]).filter(Boolean)];
    const n = notSet.length + 2; // + работы и стекло: их задают в профиле
    const text = notSet.length
      ? `Пропущено: ${notSet.join(', ')}. Работы и стекло пока с ДЕМО-цифрами. Донастроить — в Профиле`
      : 'Работы и стекло пока с ДЕМО-цифрами. Донастроить — в Профиле';
    return (
      <Screen>
        <View style={{ minHeight: 56 }} />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14, paddingHorizontal: 28 }}>
          <View style={{ width: 120, height: 120, borderRadius: 36, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}><WindowArt /></View>
          <Txt size={22} w={700} center style={{ lineHeight: 28, letterSpacing: -0.4 }}>Цех готов</Txt>
          <Txt size={16} color={C.muted} center style={{ lineHeight: 22 }}>{sub}</Txt>
          <Ban kind="est" style={{ alignSelf: 'stretch' }} title={`Не настроено: ${n} ${plural(n, 'шаг', 'шага', 'шагов')}`} text={text} />
        </View>
        <Dock>
          <Button title="Сделать первый замер" onPress={() => { router.replace('/orders'); router.push('/new'); }} />
          <Pressable accessibilityRole="button" onPress={() => router.replace('/orders')} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 }}>
            <Txt size={16} w={500} color={C.accentText}>Позже</Txt>
          </Pressable>
        </Dock>
      </Screen>
    );
  }

  const head: Record<number, [string, string]> = {
    1: ['Ваш цех', 'Название и телефон попадут в КП клиенту'],
    2: ['Ваши системы', 'Останутся только они. Поменять — в настройках'],
    3: ['Как работаете?', 'От этого зависит себестоимость'],
    4: ['Ваша наценка', 'Её видите только вы — клиенту идёт итоговая цена'],
    5: ['Курс доллара', 'Цены поставщиков в долларах пересчитаем в сумы'],
  };
  const anyDemoPassport = (systems.data ?? []).some((s) => selected.includes(s.code) && s.demo_passport);

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 4, minHeight: 56 }}>
        {step > 1 ? <IconButton name="back" label="Назад" onPress={back} /> : null}
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => next(true)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}>
          <Txt size={16} w={500} color="#55524D">Пропустить</Txt>
        </Pressable>
      </View>
      <View style={{ paddingHorizontal: 20 }}><Prog step={step} total={TOTAL} /></View>
      <Txt size={14} color={C.muted} style={{ paddingTop: 14, paddingHorizontal: 20, lineHeight: 19 }}>{`Шаг ${step} из ${TOTAL}`}</Txt>
      <Txt size={30} w={700} style={{ paddingTop: 2, paddingHorizontal: 20, lineHeight: 36, letterSpacing: -0.75 }}>{head[step][0]}</Txt>
      <Txt size={14} color={C.muted} style={{ paddingTop: 4, paddingBottom: 6, paddingHorizontal: 20, lineHeight: 19 }}>{head[step][1]}</Txt>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Body style={{ paddingTop: 8, gap: 10 }}>
        {step === 1 ? (
          <View style={{ paddingHorizontal: 12, gap: 10 }}>
            <Field label="Название цеха" value={name} onChangeText={setName} placeholder="Oyna Servis" autoFocus autoCapitalize="words" returnKeyType="next" />
            <Field label="Телефон для клиентов" value={phone} onChangeText={setPhone} placeholder="+998 90 123 45 67" keyboardType="phone-pad" inputStyle={{ fontVariant: ['tabular-nums'] }} />
            <Card style={{ marginHorizontal: 0 }}>
              <Row first chevron={false} left={<Tile><XIcon name="photo" /></Tile>} label="Логотип" sub="не обязательно"
                right={<St c="gray">добавить</St>}
                onPress={() => Alert.alert('Логотип', 'Логотип можно будет добавить в Профиле, когда появится загрузка файлов')} />
              <Row chevron={false} left={<Tile><XIcon name="lock" size={20} /></Tile>} label="КП с логотипом цеха" sub="в подписке цеха" />
            </Card>
          </View>
        ) : null}

        {step === 2 ? (
          systems.loading && !systems.data ? <Loading />
            : systems.error && !systems.data ? <LoadError message={systems.error} onRetry={systems.reload} />
              : (
                <>
                  <SystemPicker list={systems.data ?? []} selected={selected} onToggle={toggle} />
                  {anyDemoPassport ? <Note style={{ paddingHorizontal: 20 }}>Паспорта систем пока демо — сверьте пределы створок с поставщиком</Note> : null}
                  {!selected.length ? <Note style={{ paddingHorizontal: 20 }}>Ничего не выбрано — начнём с Akfa 6000 QVT</Note> : null}
                </>
              )
        ) : null}

        {step === 3 ? (
          <View style={{ paddingHorizontal: 12, gap: 10 }}>
            <OptCard on={mode === 'manufacturer'} onPress={() => setMode('manufacturer')}
              icon={<XIcon name="gear" color={mode === 'manufacturer' ? C.accentDeep : C.ink} />}
              title="Сам варю окна" text="Себестоимость = материалы + работы цеха" />
            <OptCard on={mode === 'dealer'} onPress={() => setMode('dealer')}
              icon={<XIcon name="house" color={mode === 'dealer' ? C.accentDeep : C.ink} />}
              title="Заказываю у производителя" text="Себестоимость = материалы × (1 + коэффициент)" />
            <View style={{ opacity: mode === 'dealer' ? 1 : 0.5 }} pointerEvents={mode === 'dealer' ? 'auto' : 'none'}>
              <Field label="Коэффициент производителя" value={coef} onChangeText={setCoef} keyboardType="decimal-pad" editable={mode === 'dealer'}
                error={!!stepError} inputStyle={{ fontVariant: ['tabular-nums'] }} right={<Txt size={17} w={500}>%</Txt>} />
            </View>
          </View>
        ) : null}

        {step === 4 ? (
          <View style={{ paddingHorizontal: 12, gap: 10 }}>
            <OptCard on={markupKind === 'percent'} onPress={() => setMarkupKind('percent')}
              icon={<XIcon name="tag" color={markupKind === 'percent' ? C.accentDeep : C.ink} />}
              title="Наценка на себестоимость" text="Цена = себестоимость × (1 + наценка)" />
            <OptCard on={markupKind === 'margin'} onPress={() => setMarkupKind('margin')}
              icon={<XIcon name="dollar" color={markupKind === 'margin' ? C.accentDeep : C.ink} />}
              title="Доля маржи в цене" text="Цена = себестоимость ÷ (1 − маржа)" />
            <Field label={markupKind === 'margin' ? 'Маржа в цене' : 'Наценка'} value={markup} onChangeText={setMarkup} keyboardType="decimal-pad"
              error={!!stepError} inputStyle={{ fontVariant: ['tabular-nums'] }} right={<Txt size={17} w={500}>%</Txt>} />
            {markupNum !== null && !stepError ? (
              <Note style={{ paddingHorizontal: 8 }}>
                {`Себестоимость 1 000 000 сум → цена ${num(Math.round(markupKind === 'margin' ? 1e6 / (1 - markupNum / 100) : 1e6 * (1 + markupNum / 100)))} сум`}
              </Note>
            ) : null}
          </View>
        ) : null}

        {step === 5 ? (
          <View style={{ gap: 10 }}>
            <Card>
              <Row first chevron={false} onPress={() => setOwnRate(false)} selected={!ownRate} label="Курс ЦБ"
                sub={fx.data?.rate ? `${num(fx.data.rate, 2)} сум · обновляется сам` : fx.loading ? 'загружаем…' : 'ЦБ сейчас недоступен'}
                right={!ownRate ? <XIcon name="tick" color={C.accent} /> : undefined} />
              <Row chevron={false} onPress={() => setOwnRate(true)} selected={ownRate} label="Свой курс" sub="если считаете по курсу поставщика"
                right={ownRate ? <XIcon name="tick" color={C.accent} /> : undefined} />
            </Card>
            {ownRate ? (
              <View style={{ paddingHorizontal: 12 }}>
                <Field label="Курс, сум за 1 $" value={rate} onChangeText={setRate} keyboardType="decimal-pad" autoFocus
                  placeholder={fx.data?.rate ? num(fx.data.rate, 2) : '12 010,45'} error={!!stepError} inputStyle={{ fontVariant: ['tabular-nums'] }} />
              </View>
            ) : null}
            <Txt size={15} w={600} color={C.muted} style={{ paddingHorizontal: 20, paddingTop: 8 }}>Язык КП для клиентов</Txt>
            <Seg items={[{ value: 'ru', title: 'Русский' }, { value: 'uz', title: 'O‘zbekcha' }]} value={lang} onChange={setLang} />
          </View>
        ) : null}

        {stepError ? <View style={{ paddingHorizontal: 20 }}><ErrorText>{stepError}</ErrorText></View> : null}
        {error ? <View style={{ paddingHorizontal: 12 }}><Ban kind="err" title="Цех не создан" text={error} /></View> : null}
      </Body>

      <Dock>
        <Button title={step === 5 ? 'Создать цех' : 'Далее'} onPress={() => next(false)} loading={busy} disabled={!!stepError} />
      </Dock>
      </KeyboardAvoidingView>
    </Screen>
  );
}
