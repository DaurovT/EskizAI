import { clarifyRows, isProposal } from '../clarify';

const q = (id: string, extra: object = {}) => ({ id, text: id, options: ['a', 'b'], ...extra });

describe('clarify: вопросы, пояснения и предложения (Clarify.dc.html)', () => {
  it('предложение — kind proposal или id alt_/swap_/replace_/offer_; kind question перекрывает id', () => {
    expect(isProposal(q('q_legs'))).toBe(false);
    expect(isProposal(q('alt_riffle'))).toBe(true);
    expect(isProposal(q('swap-front'))).toBe(true);
    expect(isProposal(q('fronts', { kind: 'proposal' }))).toBe(true);
    expect(isProposal(q('alt_x', { kind: 'question' }))).toBe(false);
    expect(isProposal(q('alternative'))).toBe(false);
  });
  it('порядок как в макете: вопрос, пояснения (до двух, без повторов), остальные вопросы, предложения', () => {
    const rows = clarifyRows([q('alt_riffle'), q('q_round'), q('q_legs')], ['Петли с доводчиком', ' Петли с доводчиком ', 'Ножки 150', 'Третье']);
    expect(rows.map((r) => (r.type === 'i' ? `i:${r.text}` : `${r.type}:${r.q.id}`))).toEqual(['q:q_round', 'i:Петли с доводчиком', 'i:Ножки 150', 'q:q_legs', 's:alt_riffle']);
    expect(clarifyRows([], ['x'])).toEqual([{ type: 'i', text: 'x' }]);
    expect(clarifyRows([q('alt_a')])).toEqual([{ type: 's', q: q('alt_a') }]);
  });
});
