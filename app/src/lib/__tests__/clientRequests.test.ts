import { routeForPush } from '../pushRoute';

describe('client change requests', () => {
  it('push «клиент просит изменить» opens the requests screen', () => {
    expect(routeForPush({ kind: 'client_change_request', project_id: 'p1' })).toBe('/project/p1/client-requests');
    expect(routeForPush({ kind: 'share_opened', project_id: 'p1' })).toBe('/project/p1');
  });
});
