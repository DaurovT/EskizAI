import type { AppStatusOut } from '../../api/types';
import { compareVersions, decideScreen, maintenanceEta, parseVersion } from '../appStatus';
import { maskPhone } from '../format';

const base: AppStatusOut = {
  platform: 'ios', version: '1.0.0', min_version: '0.0.0', latest_version: '1.0.0', update: 'none',
  store_url: 'https://apps.apple.com/app/id1', store_urls: { ios: 'https://apps.apple.com/app/id1', android: 'https://play' },
  release_notes: { ru: ['Угловые кухни'], uz: ['Burchakli oshxonalar'] },
  maintenance: { on: false, until: null, message: { ru: '', uz: '' } },
};

describe('SCR-45: обновление и техработы', () => {
  it('сравнивает версии по числам', () => {
    expect(parseVersion('1.2')).toEqual([1, 2, 0]);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1')).toBe(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBeLessThan(0);
  });

  it('обязательное обновление — важнее техработ, без «Позже»', () => {
    const s = decideScreen({ ...base, min_version: '2.0.0', maintenance: { ...base.maintenance, on: true } }, '1.0.0', null);
    expect(s).toEqual({ kind: 'required', storeUrl: base.store_url });
    // и по полю update от сервера
    expect(decideScreen({ ...base, update: 'required' }, '1.0.0', null)?.kind).toBe('required');
  });

  it('новая версия — один раз на версию', () => {
    const st = { ...base, latest_version: '1.1.0', update: 'optional' as const };
    const s = decideScreen(st, '1.0.0', null);
    expect(s?.kind).toBe('optional');
    expect(s && s.kind === 'optional' && s.notes.ru).toEqual(['Угловые кухни']);
    expect(decideScreen(st, '1.0.0', '1.1.0')).toBeNull(); // нажали «Позже» на этой версии
    expect(decideScreen({ ...st, latest_version: '1.2.0' }, '1.0.0', '1.1.0')?.kind).toBe('optional'); // вышла ещё новее
    expect(decideScreen(base, '1.0.0', null)).toBeNull();
  });

  it('техработы блокируют, пока не выключат', () => {
    const s = decideScreen({ ...base, maintenance: { on: true, until: '2026-11-03T09:00:00Z', message: { ru: 'x', uz: 'y' } } }, '1.0.0', null);
    expect(s).toEqual({ kind: 'maintenance', until: '2026-11-03T09:00:00Z', message: { ru: 'x', uz: 'y' } });
  });

  it('время окончания — по Ташкенту, минуты до конца', () => {
    const now = Date.parse('2026-11-03T08:20:00Z');
    expect(maintenanceEta('2026-11-03T09:00:00Z', now)).toEqual({ time: '14:00', minutes: 40 });
    expect(maintenanceEta('2026-11-03T14:00:00+05:00', now)).toEqual({ time: '14:00', minutes: 40 });
    expect(maintenanceEta(null, now)).toBeNull();
    expect(maintenanceEta('завтра', now)).toBeNull();
  });

  it('номер в подтверждении удаления скрыт', () => {
    expect(maskPhone('+998909531234')).toBe('+998 90 953 •• ••');
  });
});
