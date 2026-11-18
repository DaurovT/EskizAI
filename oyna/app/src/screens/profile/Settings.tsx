/**
 * S13 Профиль — макет Settings: цех, системы, комплектации, наценка и работы, стеклопакеты, курс, сотрудники, язык, выход.
 * Каждая строка открывает нижний лист. Менять может только владелец (остальным — просмотр); наценку сервер
 * не отдаёт никому, кроме владельца. «ДЕМО» — где цех ещё не задал свои цены.
 */
import { useRouter } from 'expo-router';
import { ReactNode, useMemo, useState } from 'react';
import { Alert, Image, Pressable, RefreshControl, View } from 'react-native';

import { api, errorText } from '@/api/http';
import type { Kit } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { initials, num, phone as fmtPhone, sum } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { C } from '@/theme';
import { Body, Button, Card, Chip, ErrorText, Field, IconButton, Loading, LoadError, Note, Row, Screen, Seg, Sheet, Switch, Txt } from '@/ui/kit';
import { TAB_BAR_SPACE } from '@/ui/TabBar';
import {
  Ban, Dot, Fx, Label, parseNum, ROLE_NAME, SheetBody, SystemPicker, SystemRow, Tag, Tile, unitTitle, XIcon,
} from './parts';

// ---------- ответы /oyna/company ----------
type CompanyRow = {
  id: string; name: string; phone: string | null; inn: string | null; address: string | null; logo_url: string | null;
  mode: 'manufacturer' | 'dealer'; dealer_coef?: number | null; markup_kind?: 'percent' | 'margin' | 'per_m2'; markup_value?: number;
  usd_rate: number | null; lang_default: 'ru' | 'uz'; demo_prices: boolean; plan?: string;
};
type Work = { name: string; unit: string; ref_price_sum: number | null; set: boolean; price_sum: number | null };
type CompanyOut = {
  company: CompanyRow; works: Record<string, Work>; kits: (Kit & { id: string })[]; systems: string[];
  glass_prices: Record<string, number>; own_prices: number; onboarding: { works_missing: string[]; glass_missing: boolean };
};
type GlassPreset = { code: string; formula: string; thickness_mm: number; price_sum_m2: number | null; price_status: string; fits_system: boolean };
type Member = { user_id: string; phone: string; name: string | null; role: string; discount_limit_pct: number };
type Data = { co: CompanyOut; systems: SystemRow[]; fx: Fx | null };
type Section = 'company' | 'systems' | 'kits' | 'markup' | 'glass' | 'fx' | 'team' | 'lang';

/** «Akfa 6000 QVT, 6000 Trio, 7000 Engelberg» — бренд один раз */
function systemsLine(codes: string[], all: SystemRow[]): string {
  let prev = '';
  return codes.map((c) => {
    const s = all.find((x) => x.code === c);
    if (!s) return c;
    const out = s.brand === prev ? s.series : `${s.brand} ${s.series}`;
    prev = s.brand;
    return out;
  }).join(', ');
}
const glassTitle = (code?: string) => (code ? code.replace(/^g/, '').replace(/_/g, '-') : '');
const cap = (s?: string) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const isDemoStatus = (st?: string) => !!st && st !== 'найдено';

export default function Settings() {
  const router = useRouter();
  const auth = useAuth();
  const { user, isOwner, role, language, logout } = auth;
  const [open, setOpen] = useState<Section | null>(null);

  const load = useLoad<Data>(async () => {
    const [co, systems, fx] = await Promise.all([
      api.get<CompanyOut>('/oyna/company'),
      api.get<SystemRow[]>('/oyna/systems').catch(() => [] as SystemRow[]),
      api.get<Fx>('/oyna/fx/usd').catch(() => null),
    ]);
    return { co, systems, fx };
  });
  const d = load.data;
  const setCo = (co: CompanyOut) => load.setData((p) => (p ? { ...p, co } : p));
  const patch = async (body: Partial<CompanyRow>) => { const co = await api.patch<CompanyOut>('/oyna/company', body); setCo(co); return co; };

  function askLogout() {
    Alert.alert('Выйти из аккаунта?', 'Замеры, которые ещё не ушли на сервер, останутся на телефоне', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Выйти', style: 'destructive', onPress: () => { void logout().then(() => router.replace('/login')); } },
    ]);
  }

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 14, paddingHorizontal: 12, paddingBottom: 4, minHeight: 56 }}>
        <View style={{ flex: 1 }} />
        <IconButton name="bell" label="Уведомления" onPress={() => Alert.alert('Уведомления', 'Уведомления появятся в следующих версиях')} />
      </View>
      <Txt size={30} w={700} style={{ lineHeight: 36, letterSpacing: -0.75, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 4 }}>Профиль</Txt>

      {!d && load.loading ? <Loading /> : !d && load.error ? <LoadError message={load.error} onRetry={load.reload} /> : d ? (
        <Body style={{ paddingTop: 8, gap: 10, paddingBottom: TAB_BAR_SPACE }} refresh={<RefreshControl refreshing={load.loading} onRefresh={load.reload} />}>
          {load.error ? <View style={{ paddingHorizontal: 12 }}><Ban kind="err" title="Не обновилось" text={load.error} /></View> : null}

          <Card>
            <Row first onPress={() => setOpen('company')}
              left={d.co.company.logo_url
                ? <Image source={{ uri: d.co.company.logo_url }} style={{ width: 44, height: 44, borderRadius: 12 }} />
                : <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: C.dark, alignItems: 'center', justifyContent: 'center' }}><Txt size={15} w={700} color="#fff">{initials(d.co.company.name)}</Txt></View>}
              label={<Txt w={600} lines={1}>{d.co.company.name}</Txt>}
              sub={[role ? ROLE_NAME[role] : '', fmtPhone(user?.phone)].filter(Boolean).join(' · ')} />
          </Card>

          <Card>
            <Row first onPress={() => setOpen('systems')} left={<Tile><XIcon name="frame" size={20} /></Tile>}
              label="Системы" sub={<Txt size={14} color={C.muted} lines={1}>{systemsLine(d.co.systems, d.systems) || 'не выбраны'}</Txt>} />
            <Row onPress={() => setOpen('kits')} left={<Tile><XIcon name="grid" size={20} /></Tile>}
              label="Комплектации" sub={<Txt size={14} color={C.muted} lines={1}>{d.co.kits.map((k) => k.name).join(' · ') || 'нет'}</Txt>} />
            <Row onPress={() => setOpen('markup')} left={<Tile><XIcon name="tag" size={20} /></Tile>}
              label={isOwner ? 'Наценка и работы' : 'Работы цеха'}
              sub={<Txt size={14} color={C.muted} lines={1}>{[
                isOwner && d.co.company.markup_kind ? markupLine(d.co.company.markup_kind, d.co.company.markup_value) : '',
                d.co.onboarding.works_missing.length ? 'работы ДЕМО' : 'работы заданы',
              ].filter(Boolean).join(' · ')}</Txt>}
              right={d.co.onboarding.works_missing.length ? <Dot /> : undefined} />
            <Row onPress={() => setOpen('glass')} left={<Tile><XIcon name="cube" size={20} /></Tile>}
              label="Стеклопакеты" sub={d.co.onboarding.glass_missing ? 'прайс стекольщика' : `прайс стекольщика · ${Object.keys(d.co.glass_prices).length}`}
              right={d.co.onboarding.glass_missing ? <Dot /> : undefined} />
            <Row onPress={() => setOpen('fx')} left={<Tile><XIcon name="gear" size={20} /></Tile>}
              label="Курс и валюта" sub={d.co.company.usd_rate ? `свой ${num(Number(d.co.company.usd_rate), 2)}` : d.fx?.rate ? `ЦБ ${num(d.fx.rate, 2)}` : 'курс ЦБ'} />
          </Card>

          <Card>
            <Row first onPress={() => setOpen('team')} left={<Tile><XIcon name="team" size={20} /></Tile>} label="Сотрудники" sub="в подписке «Команда»" />
            <Row onPress={() => setOpen('lang')} left={<Tile><XIcon name="chat" size={20} /></Tile>} label="Язык" sub={language === 'uz' ? 'O‘zbekcha' : 'Русский'} />
          </Card>

          <Card>
            <Row first chevron={false} onPress={askLogout} left={<Tile><XIcon name="logout" size={20} color={C.danger} /></Tile>} label="Выйти" danger />
          </Card>
        </Body>
      ) : null}

      {d ? (
        <>
          <Sheet visible={open === 'company'} onClose={() => setOpen(null)} title="Цех">
            <CompanySheet co={d.co.company} owner={isOwner} onSave={async (b) => { await patch(b); await auth.reload(); setOpen(null); }} />
          </Sheet>
          <Sheet visible={open === 'systems'} onClose={() => setOpen(null)} title="Системы">
            <SystemsSheet all={d.systems} current={d.co.systems} owner={isOwner}
              onSave={async (list) => { await api.put('/oyna/company/systems', list); setCo({ ...d.co, systems: list }); setOpen(null); }} />
          </Sheet>
          <Sheet visible={open === 'kits'} onClose={() => setOpen(null)} title="Комплектации">
            <KitsSheet kits={d.co.kits} systems={d.systems} owner={isOwner}
              onSave={async (kits) => { const out = await api.put<CompanyOut['kits']>('/oyna/company/kits', kits); setCo({ ...d.co, kits: out }); setOpen(null); }} />
          </Sheet>
          <Sheet visible={open === 'markup'} onClose={() => setOpen(null)} title={isOwner ? 'Наценка и работы' : 'Работы цеха'}>
            <MarkupSheet co={d.co} owner={isOwner}
              onSave={async (b, works) => {
                let co = d.co;
                if (Object.keys(b).length) co = await api.patch<CompanyOut>('/oyna/company', b);
                if (Object.keys(works).length) co = { ...co, works: await api.put<CompanyOut['works']>('/oyna/company/works', works) };
                setCo(co);
                setOpen(null);
                load.reload(); // onboarding.works_missing пересчитает сервер
              }} />
          </Sheet>
          <Sheet visible={open === 'glass'} onClose={() => setOpen(null)} title="Стеклопакеты">
            <GlassSheet own={d.co.glass_prices} owner={isOwner}
              onSave={async (body) => {
                const gp = await api.put<Record<string, number>>('/oyna/company/glass-prices', body);
                setCo({ ...d.co, glass_prices: gp, onboarding: { ...d.co.onboarding, glass_missing: !Object.keys(gp).length } });
                setOpen(null);
              }} />
          </Sheet>
          <Sheet visible={open === 'fx'} onClose={() => setOpen(null)} title="Курс и валюта">
            <FxSheet rate={d.co.company.usd_rate === null ? null : Number(d.co.company.usd_rate)} fx={d.fx} owner={isOwner}
              onSave={async (rate) => { await patch({ usd_rate: rate }); setOpen(null); }} />
          </Sheet>
          <Sheet visible={open === 'team'} onClose={() => setOpen(null)} title="Сотрудники">
            <TeamSheet owner={isOwner} me={user?.id} />
          </Sheet>
          <Sheet visible={open === 'lang'} onClose={() => setOpen(null)} title="Язык">
            <LangSheet co={d.co.company} owner={isOwner} onQuoteLang={async (l) => { await patch({ lang_default: l }); }} />
          </Sheet>
        </>
      ) : null}
    </Screen>
  );
}

function markupLine(kind?: string, value?: number) {
  const v = Number(value ?? 0);
  if (kind === 'margin') return `маржа ${v}% в цене`;
  if (kind === 'per_m2') return `+${num(v)} сум за м²`;
  return `+${v}% на себестоимость`;
}

/** Кнопка «Сохранить» с ошибкой под ней (общая для листов) */
function SaveBar({ title = 'Сохранить', onPress, disabled, error, busy }: { title?: string; onPress: () => void; disabled?: boolean; error?: string | null; busy?: boolean }) {
  return (
    <>
      {error ? <View style={{ paddingHorizontal: 8 }}><ErrorText>{error}</ErrorText></View> : null}
      <Button title={title} onPress={onPress} disabled={disabled} loading={busy} />
    </>
  );
}
function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}
const ReadOnly = () => <Note style={{ paddingHorizontal: 20 }}>Менять настройки цеха может только владелец</Note>;

// ---------- цех ----------
function CompanySheet({ co, owner, onSave }: { co: CompanyRow; owner: boolean; onSave: (b: Partial<CompanyRow>) => Promise<void> }) {
  const auth = useAuth();
  const [name, setName] = useState(co.name);
  const [phone, setPhone] = useState(co.phone ?? '');
  const [inn, setInn] = useState(co.inn ?? '');
  const [address, setAddress] = useState(co.address ?? '');
  const sv = useSave();
  const body: Partial<CompanyRow> = {};
  if (name.trim() && name.trim() !== co.name) body.name = name.trim();
  if (phone.trim() !== (co.phone ?? '')) body.phone = phone.trim();
  if (inn.trim() !== (co.inn ?? '')) body.inn = inn.trim();
  if (address.trim() !== (co.address ?? '')) body.address = address.trim();
  const others = auth.companies.filter((c) => c.id !== auth.company?.id);
  return (
    <SheetBody footer={owner ? <SaveBar onPress={() => void sv.run(() => onSave(body))} disabled={!Object.keys(body).length} busy={sv.busy} error={sv.error} /> : null}>
      <View style={{ paddingHorizontal: 12, gap: 10 }}>
        <Field label="Название цеха" value={name} onChangeText={setName} editable={owner} />
        <Field label="Телефон для клиентов" value={phone} onChangeText={setPhone} editable={owner} keyboardType="phone-pad" />
        <Field label="ИНН" value={inn} onChangeText={setInn} editable={owner} keyboardType="number-pad" />
        <Field label="Адрес" value={address} onChangeText={setAddress} editable={owner} />
      </View>
      {!owner ? <ReadOnly /> : null}
      {others.length ? (
        <>
          <Label>Другие цеха</Label>
          <Card>
            {others.map((c, i) => (
              <Row key={c.id} first={i === 0} label={c.name} sub={ROLE_NAME[c.role]}
                onPress={() => void sv.run(async () => { await auth.switchCompany(c.id); })} />
            ))}
          </Card>
        </>
      ) : null}
    </SheetBody>
  );
}

// ---------- системы ----------
function SystemsSheet({ all, current, owner, onSave }: { all: SystemRow[]; current: string[]; owner: boolean; onSave: (l: string[]) => Promise<void> }) {
  const [sel, setSel] = useState(current);
  const sv = useSave();
  const changed = sel.length !== current.length || sel.some((c) => !current.includes(c));
  return (
    <SheetBody footer={owner ? <SaveBar onPress={() => void sv.run(() => onSave(sel))} disabled={!changed || !sel.length} busy={sv.busy}
      error={sv.error ?? (!sel.length ? 'Выберите хотя бы одну систему' : null)} /> : null}>
      {!all.length ? <Note style={{ paddingHorizontal: 20 }}>Справочник систем не загрузился</Note> : null}
      <SystemPicker list={all} selected={sel} disabled={!owner}
        onToggle={(c) => setSel(sel.includes(c) ? sel.filter((x) => x !== c) : [...sel, c])} />
      {all.some((s) => sel.includes(s.code) && s.demo_passport) ? <Note style={{ paddingHorizontal: 20 }}>Паспорта систем пока демо — сверьте пределы створок с поставщиком</Note> : null}
      {!owner ? <ReadOnly /> : null}
    </SheetBody>
  );
}

// ---------- комплектации ----------
function KitsSheet({ kits, systems, owner, onSave }: { kits: CompanyOut['kits']; systems: SystemRow[]; owner: boolean; onSave: (k: Kit[]) => Promise<void> }) {
  const [list, setList] = useState<Kit[]>(kits.map((k) => ({ name: k.name, setup: k.setup })));
  const sv = useSave();
  const changed = JSON.stringify(list) !== JSON.stringify(kits.map((k) => ({ name: k.name, setup: k.setup })));
  const bad = list.some((k) => !k.name.trim()) || new Set(list.map((k) => k.name.trim())).size !== list.length;
  return (
    <SheetBody footer={owner ? <SaveBar onPress={() => void sv.run(() => onSave(list.map((k) => ({ ...k, name: k.name.trim() }))))}
      disabled={!changed || bad} busy={sv.busy} error={sv.error ?? (bad ? 'Названия — разные и не пустые' : null)} /> : null}>
      <Note style={{ paddingHorizontal: 20 }}>Варианты для КП: клиент выбирает между ними</Note>
      {list.map((k, i) => {
        const s = systems.find((x) => x.code === k.setup.system);
        const sub = [s ? `${s.brand} ${s.series}` : k.setup.system, glassTitle(k.setup.glass), cap(k.setup.fittings)].filter(Boolean).join(' · ');
        return (
          <View key={i} style={{ paddingHorizontal: 12, gap: 6 }}>
            {owner ? (
              <Field label={`Комплектация ${i + 1}`} value={k.name} onChangeText={(v) => setList(list.map((x, j) => (j === i ? { ...x, name: v } : x)))}
                right={list.length > 1 ? (
                  <Pressable accessibilityRole="button" accessibilityLabel="Убрать" hitSlop={8} onPress={() => setList(list.filter((_, j) => j !== i))}>
                    <Txt size={15} w={600} color={C.danger}>Убрать</Txt>
                  </Pressable>
                ) : undefined} />
            ) : <Txt w={600} style={{ paddingHorizontal: 8 }}>{k.name}</Txt>}
            <Note style={{ paddingHorizontal: 8 }}>{sub}</Note>
          </View>
        );
      })}
      {!owner ? <ReadOnly /> : null}
    </SheetBody>
  );
}

// ---------- наценка и работы ----------
function MarkupSheet({ co, owner, onSave }: { co: CompanyOut; owner: boolean; onSave: (b: Partial<CompanyRow>, works: Record<string, number | null>) => Promise<void> }) {
  const c = co.company;
  const [mode, setMode] = useState(c.mode);
  const [coef, setCoef] = useState(c.dealer_coef != null ? String(Math.round(Number(c.dealer_coef) * 1000) / 10).replace('.', ',') : '25');
  const [kind, setKind] = useState(c.markup_kind ?? 'percent');
  const [value, setValue] = useState(String(Number(c.markup_value ?? 30)).replace('.', ','));
  const [demo, setDemo] = useState(!!c.demo_prices);
  const [works, setWorks] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(co.works).map(([k, w]) => [k, w.set && w.price_sum != null ? String(w.price_sum) : ''])));
  const sv = useSave();

  const coefN = parseNum(coef), valueN = parseNum(value);
  const body: Partial<CompanyRow> = {};
  if (mode !== c.mode) body.mode = mode;
  if (mode === 'dealer' && coefN !== null && Math.abs(coefN / 100 - Number(c.dealer_coef ?? -1)) > 1e-9) body.dealer_coef = Math.round(coefN * 10) / 1000;
  if (kind !== c.markup_kind) body.markup_kind = kind;
  if (valueN !== null && valueN !== Number(c.markup_value)) body.markup_value = valueN;
  if (demo !== !!c.demo_prices) body.demo_prices = demo;
  const wBody: Record<string, number | null> = {};
  for (const [k, w] of Object.entries(co.works)) {
    const v = parseNum(works[k] ?? '');
    const was = w.set ? w.price_sum : null;
    if (v !== was) wBody[k] = v;
  }
  const err = valueN === null ? 'Укажите наценку' : kind === 'margin' && valueN >= 95 ? 'Доля маржи — меньше 95 %'
    : mode === 'dealer' && coefN === null ? 'Укажите коэффициент производителя' : null;
  const changed = Object.keys(body).length + Object.keys(wBody).length > 0;
  const kinds = [{ value: 'percent' as const, title: 'На себестоимость' }, { value: 'margin' as const, title: 'Доля маржи в цене' }];
  if (c.markup_kind === 'per_m2') kinds.push({ value: 'per_m2' as never, title: 'За м²' });

  return (
    <SheetBody footer={owner ? <SaveBar onPress={() => void sv.run(() => onSave(body, wBody))} disabled={!changed || (owner && !!err)} busy={sv.busy} error={sv.error ?? (owner ? err : null)} /> : null}>
      {owner ? (
        <>
          <Label>Себестоимость</Label>
          <Seg items={[{ value: 'manufacturer', title: 'Сам варю' }, { value: 'dealer', title: 'У производителя' }]} value={mode} onChange={setMode} />
          <Note style={{ paddingHorizontal: 20 }}>{mode === 'dealer' ? 'Материалы × (1 + коэффициент)' : 'Материалы + работы цеха'}</Note>
          {mode === 'dealer' ? (
            <View style={{ paddingHorizontal: 12 }}>
              <Field label="Коэффициент производителя" value={coef} onChangeText={setCoef} keyboardType="decimal-pad" right={<Txt size={17} w={500}>%</Txt>} />
            </View>
          ) : null}
          <Label>Наценка</Label>
          <Seg items={kinds} value={kind} onChange={setKind} />
          <View style={{ paddingHorizontal: 12 }}>
            <Field label={kind === 'margin' ? 'Доля маржи в цене' : kind === 'per_m2' ? 'Сумма за м²' : 'Наценка на себестоимость'} value={value} onChangeText={setValue}
              keyboardType="decimal-pad" right={<Txt size={17} w={500}>{kind === 'per_m2' ? 'сум' : '%'}</Txt>} />
          </View>
          {valueN !== null && kind !== 'per_m2' && !(kind === 'margin' && valueN >= 95) ? (
            <Note style={{ paddingHorizontal: 20 }}>{`Себестоимость 1 000 000 → цена ${sum(Math.round(kind === 'margin' ? 1e6 / (1 - valueN / 100) : 1e6 * (1 + valueN / 100)))}`}</Note>
          ) : null}
          <Card>
            <Row first chevron={false} label="ДЕМО-цены, где нет своих" sub="на КП будет метка «ДЕМО»" right={<Switch value={demo} onChange={setDemo} />} />
          </Card>
        </>
      ) : null}
      <Label>Работы цеха</Label>
      <View style={{ paddingHorizontal: 12, gap: 8 }}>
        {Object.entries(co.works).map(([k, w]) => (
          owner ? (
            <Field key={k} label={`${w.name}, сум за ${unitTitle(w.unit)}`} value={works[k] ?? ''} onChangeText={(v) => setWorks({ ...works, [k]: v })}
              keyboardType="number-pad" placeholder={w.ref_price_sum ? `обычно ${num(w.ref_price_sum)}` : 'ДЕМО'}
              right={!w.set && !(works[k] ?? '') ? <Tag kind="est">ДЕМО</Tag> : undefined} />
          ) : (
            <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderRadius: 16, minHeight: 56, paddingHorizontal: 16 }}>
              <View style={{ flex: 1 }}><Txt w={500}>{w.name}</Txt><Note>{`за ${unitTitle(w.unit)}`}</Note></View>
              {w.set && w.price_sum != null ? <Txt w={600}>{sum(w.price_sum)}</Txt> : <Tag kind="est">ДЕМО</Tag>}
            </View>
          )
        ))}
      </View>
      {owner ? <Note style={{ paddingHorizontal: 20 }}>Пустое поле — работа считается по ДЕМО-цифрам</Note> : <ReadOnly />}
    </SheetBody>
  );
}

// ---------- стеклопакеты ----------
function GlassSheet({ own, owner, onSave }: { own: Record<string, number>; owner: boolean; onSave: (b: Record<string, number | null>) => Promise<void> }) {
  const presets = useLoad(() => api.get<GlassPreset[]>('/oyna/glass'));
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(own).map(([k, v]) => [k, String(v)])));
  const sv = useSave();
  const body = useMemo(() => {
    const b: Record<string, number | null> = {};
    for (const p of presets.data ?? []) {
      const v = parseNum(vals[p.code] ?? '');
      const was = own[p.code] ?? null;
      if (v !== was) b[p.code] = v;
    }
    return b;
  }, [presets.data, vals, own]);
  return (
    <SheetBody footer={owner ? <SaveBar onPress={() => void sv.run(() => onSave(body))} disabled={!Object.keys(body).length} busy={sv.busy} error={sv.error} /> : null}>
      <Note style={{ paddingHorizontal: 20 }}>Цены вашего стекольщика за м². Где пусто — базовая цена или ДЕМО</Note>
      {presets.loading && !presets.data ? <Loading /> : presets.error && !presets.data ? <LoadError message={presets.error} onRetry={presets.reload} /> : null}
      <View style={{ paddingHorizontal: 12, gap: 8 }}>
        {(presets.data ?? []).map((p) => {
          const mine = own[p.code] != null;
          const base = p.price_sum_m2 != null ? `${num(p.price_sum_m2)} сум` : 'нет цены';
          const tag = mine ? <Tag kind="ok">свой</Tag> : isDemoStatus(p.price_status) || p.price_sum_m2 == null ? <Tag kind="est">ДЕМО</Tag> : undefined;
          return owner ? (
            <Field key={p.code} label={`${p.formula} · ${num(p.thickness_mm)} мм`} value={vals[p.code] ?? ''} onChangeText={(v) => setVals({ ...vals, [p.code]: v })}
              keyboardType="number-pad" placeholder={`база ${base}`} right={tag} />
          ) : (
            <View key={p.code} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderRadius: 16, minHeight: 56, paddingHorizontal: 16 }}>
              <View style={{ flex: 1 }}><Txt w={500}>{p.formula}</Txt><Note>{`${num(p.thickness_mm)} мм`}</Note></View>
              <Txt w={600}>{mine ? sum(own[p.code]) : base}</Txt>{tag}
            </View>
          );
        })}
      </View>
      {!owner ? <ReadOnly /> : null}
    </SheetBody>
  );
}

// ---------- курс ----------
function FxSheet({ rate, fx, owner, onSave }: { rate: number | null; fx: Fx | null; owner: boolean; onSave: (r: number) => Promise<void> }) {
  const [own, setOwn] = useState(rate !== null);
  const [val, setVal] = useState(rate !== null ? num(rate, 2) : '');
  const sv = useSave();
  const v = parseNum(val);
  function pickCbu() {
    if (rate !== null) {
      Alert.alert('Курс ЦБ', 'Вернуться к курсу ЦБ пока нельзя: свой курс можно только изменить. Это появится в обновлении');
      return;
    }
    setOwn(false);
  }
  return (
    <SheetBody footer={owner && own ? <SaveBar onPress={() => v !== null && void sv.run(() => onSave(v))} disabled={v === null || v < 1000 || v === rate} busy={sv.busy} error={sv.error} /> : null}>
      <Card>
        <Row first chevron={false} onPress={owner ? pickCbu : undefined} selected={!own} label="Курс ЦБ"
          sub={fx?.rate ? `${num(fx.rate, 2)} сум${fx.date ? ` · ${fx.date.split('-').reverse().join('.')}` : ''}` : 'ЦБ сейчас недоступен'}
          right={!own ? <XIcon name="tick" color={C.accent} /> : undefined} />
        <Row chevron={false} onPress={owner ? () => setOwn(true) : undefined} selected={own} label="Свой курс" sub="по курсу поставщика"
          right={own ? <XIcon name="tick" color={C.accent} /> : undefined} />
      </Card>
      {own && owner ? (
        <View style={{ paddingHorizontal: 12 }}>
          <Field label="Курс, сум за 1 $" value={val} onChangeText={setVal} keyboardType="decimal-pad" placeholder={fx?.rate ? num(fx.rate, 2) : '12 010,45'} />
        </View>
      ) : null}
      <Note style={{ paddingHorizontal: 20 }}>Цены в долларах пересчитываем в сумы по этому курсу; в КП — суммы в сумах</Note>
      {!owner ? <ReadOnly /> : null}
    </SheetBody>
  );
}

// ---------- сотрудники ----------
const ROLES = ['manager', 'measurer', 'installer', 'production', 'owner'] as const;
function TeamSheet({ owner, me }: { owner: boolean; me?: string }) {
  const list = useLoad(() => api.get<Member[]>('/oyna/company/members'));
  const [phone, setPhone] = useState('+998 ');
  const [role, setRole] = useState<(typeof ROLES)[number]>('measurer');
  const sv = useSave();
  const add = () => void sv.run(async () => {
    const out = await api.post<Member[]>('/oyna/company/members', { phone, role });
    list.setData(out); setPhone('+998 ');
  });
  const remove = (m: Member) => Alert.alert('Убрать сотрудника?', m.name || fmtPhone(m.phone), [
    { text: 'Отмена', style: 'cancel' },
    { text: 'Убрать', style: 'destructive', onPress: () => void sv.run(async () => { list.setData(await api.del<Member[]>(`/oyna/company/members/${m.user_id}`)); }) },
  ]);
  return (
    <SheetBody>
      {list.loading && !list.data ? <Loading /> : list.error && !list.data ? <LoadError message={list.error} onRetry={list.reload} /> : (
        <Card>
          {(list.data ?? []).map((m, i) => (
            <Row key={m.user_id} first={i === 0} chevron={false}
              left={<View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' }}><Txt size={14} w={700}>{initials(m.name || m.phone.slice(-2))}</Txt></View>}
              label={m.name || fmtPhone(m.phone)}
              sub={[ROLE_NAME[m.role] ?? m.role, m.name ? fmtPhone(m.phone) : '', m.discount_limit_pct ? `скидка до ${m.discount_limit_pct}%` : ''].filter(Boolean).join(' · ')}
              right={owner && m.user_id !== me ? (
                <Pressable accessibilityRole="button" onPress={() => remove(m)} hitSlop={8}><Txt size={15} w={600} color={C.danger}>Убрать</Txt></Pressable>
              ) : m.user_id === me ? <Tag kind="n">вы</Tag> : undefined} />
          ))}
        </Card>
      )}
      {owner ? (
        <>
          <Label>Добавить по номеру</Label>
          <View style={{ paddingHorizontal: 12, gap: 10 }}>
            <Field label="Телефон" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          </View>
          <ChipsRow>
            {ROLES.map((r) => <Chip key={r} title={ROLE_NAME[r]} on={role === r} onPress={() => setRole(r)} />)}
          </ChipsRow>
          <View style={{ paddingHorizontal: 12, gap: 8 }}>
            <SaveBar title="Добавить" onPress={add} disabled={phone.replace(/\D/g, '').length < 12} busy={sv.busy} error={sv.error} />
          </View>
          <Note style={{ paddingHorizontal: 20 }}>Сотрудник войдёт по этому номеру через SMS и сразу попадёт в ваш цех</Note>
        </>
      ) : sv.error ? <View style={{ paddingHorizontal: 20 }}><ErrorText>{sv.error}</ErrorText></View> : null}
    </SheetBody>
  );
}
function ChipsRow({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12 }}>{children}</View>;
}

// ---------- язык ----------
function LangSheet({ co, owner, onQuoteLang }: { co: CompanyRow; owner: boolean; onQuoteLang: (l: 'ru' | 'uz') => Promise<void> }) {
  const { language, setLanguage } = useAuth();
  const [ql, setQl] = useState(co.lang_default);
  const sv = useSave();
  const items = [{ value: 'ru' as const, title: 'Русский' }, { value: 'uz' as const, title: 'O‘zbekcha' }];
  return (
    <SheetBody>
      <Label>Язык приложения</Label>
      <Seg items={items} value={language} onChange={setLanguage} />
      <Label>Язык КП по умолчанию</Label>
      <Seg items={items} value={ql} onChange={(l) => { if (!owner) return; setQl(l); void sv.run(() => onQuoteLang(l)); }} />
      {sv.error ? <View style={{ paddingHorizontal: 20 }}><ErrorText>{sv.error}</ErrorText></View> : null}
      <Note style={{ paddingHorizontal: 20 }}>{owner ? 'Язык КП можно поменять у каждого заказа при отправке' : 'Язык КП выбирает владелец цеха'}</Note>
    </SheetBody>
  );
}
