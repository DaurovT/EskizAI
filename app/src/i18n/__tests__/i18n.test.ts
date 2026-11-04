import { ru } from '../ru';
import { uz } from '../uz';
import { translate } from '../index';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n: ru и uz полные и согласованные', () => {
  const ruKeys = Object.keys(ru).sort();
  const uzKeys = Object.keys(uz).sort();

  it('в uz есть каждый ключ ru и нет лишних', () => {
    expect(uzKeys.filter((k) => !(k in ru))).toEqual([]);
    expect(ruKeys.filter((k) => !(k in uz))).toEqual([]);
  });

  it('ни одной пустой строки', () => {
    for (const k of ruKeys) {
      expect([k, (ru as Record<string, string>)[k].trim().length > 0]).toEqual([k, true]);
      expect([k, (uz as Record<string, string>)[k].trim().length > 0]).toEqual([k, true]);
    }
  });

  it('одинаковые подстановки {param} в обоих языках', () => {
    for (const k of ruKeys) {
      expect([k, placeholders((uz as Record<string, string>)[k])]).toEqual([k, placeholders((ru as Record<string, string>)[k])]);
    }
  });

  it('узбекский — латиница, без кириллицы', () => {
    const cyr = Object.entries(uz).filter(([, v]) => /[Ѐ-ӿ]/.test(v)).map(([k]) => k);
    expect(cyr).toEqual([]);
  });

  it('подстановка параметров', () => {
    expect(translate('ru', 'login_resend_in', { s: 42 })).toBe('Новый код через 42 с');
    expect(translate('uz', 'new_photos_count', { n: 2, max: 5 })).toBe('Suratlar: 2 / 5');
  });

  it('статусы проекта и заказа переведены', () => {
    for (const s of ['draft', 'sketch', 'sent', 'measured', 'contract', 'in_work', 'delivered', 'cancelled']) expect(`st_${s}` in uz).toBe(true);
    for (const s of ['created', 'paid', 'accepted', 'cutting', 'ready', 'issued', 'cancelled', 'returned', 'awaiting_approval', 'rejected']) expect(`os_${s}` in uz).toBe(true);
  });
});
