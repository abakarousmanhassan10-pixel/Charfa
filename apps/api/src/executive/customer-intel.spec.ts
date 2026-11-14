import { analyzeQuestions, type Question } from './customer-intel';

const q = (text: string, answered = false, ageHours = 1): Question => ({ text, answered, ageHours });

describe('customer intelligence', () => {
  const many: Question[] = [
    ...Array.from({ length: 4 }, (_, i) => q(`Do you deliver to town ${i}? Contact me on 66 12 34 5${i} or amina${i}@example.com`)),
    ...Array.from({ length: 3 }, () => q('How much is it? Too expensive!')),
    q('Is it in stock?'),
  ];
  it('counts themes and objections, and finds information the merchant never wrote down', () => {
    const r = analyzeQuestions(many, 'We sell sandals and juices.');
    expect(r.faq).toEqual(expect.arrayContaining([{ topic: 'SHIPPING', count: 4 }, { topic: 'PRICE', count: 3 }]));
    expect(r.objections).toEqual([{ type: 'TOO_EXPENSIVE', count: 3 }]);
    expect(r.missingInformation.map((m) => m.topic)).toEqual(['SHIPPING']);
    // Once the knowledge covers shipping, it is no longer missing.
    expect(analyzeQuestions(many, 'We deliver in N’Djamena within 2 days.').missingInformation).toEqual([]);
  });
  it('suppresses rare themes (k-anonymity) and never returns message text, contact data or names', () => {
    const r = analyzeQuestions(many, '');
    expect(r.faq.find((f) => f.topic === 'AVAILABILITY')).toBeUndefined(); // asked once: suppressed
    expect(r.suppressed).toBeGreaterThan(0);
    const out = JSON.stringify(r);
    expect(out).not.toMatch(/amina|@example|66 12|town \d|Do you deliver/i);
    expect(r.privacy.note).toMatch(/No message text, name or identifier/);
  });
  it('reports bottlenecks only from aggregate counts', () => {
    const slow = Array.from({ length: 5 }, () => q('Where is my order? delivery please', false, 30));
    const r = analyzeQuestions(slow, '');
    expect(r.totals).toMatchObject({ inbound: 5, answered: 0, unansweredOver24h: 5 });
    expect(r.bottlenecks.map((b) => b.type)).toEqual(['SLOW_REPLIES', 'LOW_REPLY_RATE']);
    expect(analyzeQuestions([], '').bottlenecks).toEqual([]);
  });
});
