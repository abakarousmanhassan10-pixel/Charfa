import { agentMessage, detectEscalation, detectLanguage, escalationMessage, resolveReplyLanguage } from './sales';

describe('language detection', () => {
  it.each([
    ['Hello, how much is the red dress? Do you have it in stock?', 'en'],
    ['Bonjour, combien coûte la robe rouge ? Est-ce que vous avez encore du stock ?', 'fr'],
    ['Merhaba, kırmızı elbisenin fiyatı ne kadar? Stokta var mı?', 'tr'],
    ['مرحبا، كم سعر الفستان الأحمر؟ هل هو متوفر؟', 'ar'],
    ['كم سعر Bissap juice؟', 'ar'],
  ])('%s → %s', (text, lang) => {
    expect(detectLanguage(text)).toMatchObject({ language: lang, confidence: 'HIGH' });
  });
  it('returns null with no signal (numbers, emoji, very short or unknown text)', () => {
    expect(detectLanguage('12345').language).toBeNull();
    expect(detectLanguage('👍').language).toBeNull();
    expect(detectLanguage('ok').language).toBeNull();
    expect(detectLanguage('').language).toBeNull();
  });
  it('replies in the customer language only when the business supports it', () => {
    expect(resolveReplyLanguage('tr', ['en', 'fr', 'tr'], 'en')).toEqual({ language: 'tr', supported: true });
    expect(resolveReplyLanguage('ar', ['en', 'fr'], 'fr')).toEqual({ language: 'fr', supported: false });
    expect(resolveReplyLanguage(null, ['en', 'fr'], 'en', 'fr')).toEqual({ language: 'fr', supported: true });
    expect(resolveReplyLanguage(null, ['en', 'fr'], 'en')).toEqual({ language: 'en', supported: true });
  });
});

describe('escalation rules', () => {
  it.each([
    ['I want a refund right now', 'REFUND'], ['Je veux être remboursé', 'REFUND'], ['iade istiyorum', 'REFUND'], ['أريد استرداد المبلغ', 'REFUND'],
    ['Where is my order? Tracking please', 'ORDER_STATUS'], ['Où est ma commande ?', 'ORDER_STATUS'], ['siparişim nerede', 'ORDER_STATUS'], ['أين طلبي', 'ORDER_STATUS'],
    ['I will call my lawyer', 'LEGAL_COMPLAINT'], ['je vais porter plainte', 'LEGAL_COMPLAINT'],
    ['This is a scam!', 'SENSITIVE'], ['arnaque !', 'SENSITIVE'],
    ['Can I speak to a human?', 'CUSTOMER_REQUESTED'], ['je veux parler à un conseiller', 'CUSTOMER_REQUESTED'], ['insanla konuşmak istiyorum', 'CUSTOMER_REQUESTED'], ['أريد التحدث مع موظف', 'CUSTOMER_REQUESTED'],
  ])('%s → %s', (text, reason) => {
    expect(detectEscalation(text)?.reason).toBe(reason);
  });
  it('does not escalate ordinary shopping questions', () => {
    for (const t of ['How much is the blue shirt?', 'Do you have it in size M?', 'Quel est le prix ?', 'Bu ürün var mı?', 'كم السعر؟', 'What is your return policy?']) expect(detectEscalation(t)).toBeNull();
  });
  it('legal and refund outrank an order question in the same message', () => {
    expect(detectEscalation('Where is my order? I will sue you')?.reason).toBe('LEGAL_COMPLAINT');
  });
});

describe('fixed messages', () => {
  it('exist in all four languages and never promise anything', () => {
    for (const l of ['en', 'fr', 'tr', 'ar'] as const) {
      for (const r of ['ORDER_STATUS', 'REFUND', 'LEGAL_COMPLAINT', 'AI_UNAVAILABLE', 'CUSTOMER_REQUESTED', 'UNVERIFIED_INFO'] as const) expect(escalationMessage(r, l).length).toBeGreaterThan(20);
      expect(agentMessage('greeting', l, { business: 'Maquis Awa' })).toContain('Maquis Awa');
      expect(agentMessage('disclosure', l)).not.toMatch(/\{/);
    }
    expect(escalationMessage('ORDER_STATUS', 'en')).toMatch(/will not guess/);
    expect(escalationMessage('ORDER_STATUS', 'fr')).not.toMatch(/livrée|expédiée|en route/);
  });
});
