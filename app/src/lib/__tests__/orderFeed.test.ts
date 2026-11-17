import type { OrderCorrection, OrderDispute, OrderEvent, OrderMessage, OrderReturn } from '../../api/types';
import { disputeSteps, orderFeed, pendingFixes } from '../orderFeed';

const msg = (id: string, at: string, author: OrderMessage['author_type'] = 'vendor'): OrderMessage =>
  ({ id, order_id: 'o', author_type: author, text: id, attachments: [], created_at: at });
const fix = (id: string, at: string, status: OrderCorrection['status'] = 'pending'): OrderCorrection =>
  ({ id, order_id: 'o', comment: null, lines_before: [], lines_after: [], files: [], status, created_at: at });
const ret = (id: string, at: string, decided?: string): OrderReturn =>
  ({ id, order_id: 'o', type: 'defect', description: 'скол', lines: [], photos: [], status: decided ? 'resolved' : 'open', decision: decided ? 'declined' : null, created_at: at, decided_at: decided ?? null });
const ev = (id: string, status: OrderEvent['status'], at: string, type = 'status_changed'): OrderEvent => ({ id, type, status, created_at: at });

describe('order feed', () => {
  it('merges messages, corrections, returns, disputes and status events by time', () => {
    const d: OrderDispute = { id: 'd1', order_id: 'o', subject: 'return', return_id: 'r1', reason: 'other', comment: null, photos: [], status: 'open', created_at: '2026-11-16T12:00:00Z' };
    const feed = orderFeed({
      messages: [msg('m2', '2026-11-15T11:00:00Z', 'master'), msg('m1', '2026-11-15T09:00:00Z')],
      corrections: [fix('c1', '2026-11-15T10:00:00Z')],
      returns: [ret('r1', '2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z')],
      disputes: [d],
      events: [ev('e0', 'created', '2026-11-14T08:00:00Z'), ev('e1', 'paid', '2026-11-15T08:00:00Z'), ev('e2', 'cutting', '2026-11-15T12:00:00Z'),
        ev('e3', 'cutting', '2026-11-16T13:00:00Z'), ev('e4', 'awaiting_approval', '2026-11-15T10:00:00Z', 'correction_created')],
    });
    expect(feed.map((x) => x.id)).toEqual(['e:e1', 'm:m1', 'c:c1', 'm:m2', 'e:e2', 'r:r1', 'd:d1']);
  });

  it('empty sources — empty feed', () => {
    expect(orderFeed({})).toEqual([]);
  });

  it('counts pending corrections', () => {
    expect(pendingFixes([fix('a', ''), fix('b', '', 'approved'), fix('c', '', 'pending')])).toBe(2);
  });

  it('dispute steps: return declined → opened → manager decision', () => {
    const d: OrderDispute = { id: 'd', order_id: 'o', subject: 'return', return_id: 'r', reason: 'other', comment: null, photos: [], status: 'open', created_at: 'T2' };
    expect(disputeSteps(d, ret('r', 'T0', 'T1'))).toEqual([
      { key: 'declined', done: true, at: 'T1' }, { key: 'opened', done: true, at: 'T2' }, { key: 'decision', done: false, at: null },
    ]);
    const rej = disputeSteps({ ...d, subject: 'rejection', status: 'resolved', resolved_at: 'T3' });
    expect(rej.map((s) => s.key)).toEqual(['opened', 'decision']);
    expect(rej[1]).toEqual({ key: 'decision', done: true, at: 'T3' });
  });
});
