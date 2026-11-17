import type { ClientRequestOut } from '../../api/types';
import { askText, initials, isNew, requestCounts, shortWhen, telegramUrl, withStatus } from '../clientRequests';
import { routeForPush } from '../pushRoute';

describe('client change requests', () => {
  it('push «клиент просит изменить» opens the request (old push — the project requests)', () => {
    expect(routeForPush({ kind: 'client_change_request', project_id: 'p1', share_event_id: 'e1' })).toBe('/client-requests/e1');
    expect(routeForPush({ kind: 'client_change_request', project_id: 'p1' })).toBe('/project/p1/client-requests');
    expect(routeForPush({ kind: 'share_opened', project_id: 'p1' })).toBe('/project/p1');
  });

  it('initials like the board', () => {
    expect(initials('Азиз Каримов')).toBe('АК');
    expect(initials('Дилноза Р.')).toBe('ДР');
    expect(initials('лола')).toBe('Л');
    expect(initials(null)).toBe('·');
  });

  it('short time: today, yesterday, weekday, date', () => {
    const now = new Date(2026, 10, 17, 18, 0); // вторник, 17 ноября
    expect(shortWhen(new Date(2026, 10, 17, 14, 20).toISOString(), 'ru', now)).toBe('14:20');
    expect(shortWhen(new Date(2026, 10, 16, 23, 50).toISOString(), 'ru', now)).toBe('вчера');
    expect(shortWhen(new Date(2026, 10, 16, 9, 0).toISOString(), 'uz', now)).toBe('kecha');
    expect(shortWhen(new Date(2026, 10, 15, 9, 0).toISOString(), 'ru', now)).toBe('вс');
    expect(shortWhen(new Date(2026, 10, 3, 9, 0).toISOString(), 'ru', now)).toBe('3 нояб');
    expect(shortWhen(new Date(2026, 10, 3, 9, 0).toISOString(), 'uz', now)).toBe('3-noy');
    expect(shortWhen('nope', 'ru', now)).toBe('');
  });

  it('counts new vs all; old server without status — new', () => {
    const items = [{ status: 'new' as const }, { status: 'done' as const }, {}];
    expect(requestCounts(items)).toEqual({ fresh: 2, all: 3 });
    expect(isNew({})).toBe(true);
  });

  it('text for the editor chat and telegram link', () => {
    expect(askText('Клиент просит', '  Ручки\nчёрные  ')).toBe('Клиент просит: Ручки чёрные');
    expect(telegramUrl('+998 (90) 111-22-33')).toBe('https://t.me/+998901112233');
  });

  it('local status mark keeps the first done time', () => {
    const r: ClientRequestOut = { id: '1', text: 'x', created_at: '', link_id: 'l', status: 'new' };
    const done = withStatus(r, 'done', 'T1');
    expect(done).toMatchObject({ status: 'done', done_at: 'T1' });
    expect(withStatus(done, 'done', 'T2').done_at).toBe('T1');
    expect(withStatus(done, 'new').done_at).toBeNull();
  });
});
