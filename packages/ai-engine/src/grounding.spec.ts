import { assessGrounding, checkFactPreservation, checkGrounding } from './grounding';
import { ctx } from './fixtures.spec-helper';

const base = ctx();
const issues = (caption: string, c = base) => checkGrounding({ caption }, c);
const clean = (caption: string, c = base) => expect(issues(caption, c)).toEqual([]);
const flagged = (caption: string, pattern: RegExp, c = base) => expect(issues(caption, c).join('\n')).toMatch(pattern);
const withKnowledge = (body: string, extra: Partial<typeof base> = {}) => ctx({ knowledge: [{ id: 'k9', category: 'COMPANY', title: 'Info', body }], ...extra });
const product = (over: Record<string, unknown>) => ({ id: 'p1', name: 'Bissap juice', price: '1500.00', discountPrice: null, currency: 'XAF', features: [], benefits: [], stock: 'not tracked', availability: 'IN_STOCK', ...over });

describe('amounts and prices', () => {
  it('accepts real prices in any formatting, including Arabic-Indic digits', () => {
    clean('Bissap juice 1 500 XAF, 1,500 XAF, XAF 1500, 1500 FCFA.');
    clean('Choose 1500, 1500 FCFA or 1500 XAF'); // a list of numbers is not one big number
    clean('Le bissap à ١٥٠٠ XAF');
  });
  it('accepts money written in the business text, and rejects everything else', () => {
    clean('Delivery in the city costs 1 000 XAF.');
    flagged('Only 990 XAF today', /990 XAF/);
    flagged('Only 2 500 XAF', /2 500 XAF/);
  });
  it('digits that appear elsewhere in the data no longer make an invented price look real', () => {
    const c = ctx({ business: { ...base.business, contactPhone: '+235 66 12 34 56' }, products: [product({ sku: 'A2000' })] });
    flagged('Take it for 2000 XAF', /2000 XAF/, c); // 2000 is only inside a SKU
    flagged('Just 66 XAF', /66 XAF/, c); // 66 is only inside the phone number
  });
  it('rejects a currency other than the verified one', () => {
    flagged('Only 1500 €', /Currency "€"/);
    flagged('USD 1500 for the bissap', /Currency "USD"/);
    clean('1500 FCFA'); // CFA francs are interchangeable
  });
});

describe('percentages', () => {
  it('accepts percentages written in the data', () => clean('Orders over 10 000 XAF get 10% off'));
  it('accepts the exact discount between two real prices, and nothing else', () => {
    const c = ctx({ products: [product({ price: '1500.00', discountPrice: '1200.00' })] });
    clean('Now 20% off: 1 200 XAF instead of 1 500 XAF', c);
    flagged('25% off!', /25%/, c);
    flagged('20% off!', /20%/); // no discount price in the base data
  });
});

describe('contacts and links', () => {
  const c = ctx({ business: { ...base.business, contactPhone: '+235 66 12 34 56', contactEmail: 'hello@cafe-awa.example', website: 'https://cafe-awa.example' }, knowledge: [{ id: 'k1', category: 'SOCIAL', title: 's', body: 'Follow @cafe_awa on Instagram.' }] });
  it('accepts the business phone in other formats, email, handle and website', () => {
    clean('Call +235 66 12 34 56 or 66123456, write to hello@cafe-awa.example, follow @cafe_awa, visit https://cafe-awa.example', c);
  });
  it('rejects invented phone numbers, emails, handles and URLs', () => {
    flagged('Call +235 99 88 77 66', /Phone number not present/, c);
    flagged('Write to sales@other.example', /Email address not present/, c);
    flagged('Follow @cafe_awa_official', /Social handle not present/, c);
    flagged('See https://evil.example/promo', /URL not present/, c);
  });
  it('does not mistake prices or percentages for phone numbers', () => {
    const withPhone = ctx({ business: { ...base.business, contactPhone: '+235 66 12 34 56' } });
    clean('Orders over 10 000 XAF get 10% off. Call 66123456', withPhone);
  });
});

describe('dates, years, durations and specifications', () => {
  it('rejects invented dates and years unless the data has them', () => {
    flagged('Offer valid until 31/12', /Date "31\/12"/);
    flagged('Serving you since 2015', /Year "2015"/);
    clean('Serving you since 2015', withKnowledge('Founded in 2015 in N Djamena.'));
  });
  it('rejects invented specifications; accepts the recorded ones, exactly', () => {
    const c = withKnowledge('Our bissap comes in a 330 ml bottle.');
    clean('A refreshing 330 ml bottle', c);
    clean('A refreshing 330ml bottle', c);
    flagged('A big 500 ml bottle', /500 ml/, c);
    flagged('Weighs 2 kg', /2 kg/, c);
  });
  it('rejects invented delivery times and periods; accepts recorded durations, also converted', () => {
    flagged('Delivered within 24 hours', /24 hours/);
    flagged('Open 7 days a week', /7 days/);
    const svc = ctx({ services: [{ id: 's1', name: 'Catering', price: null, currency: 'XAF', features: [], benefits: [], durationMinutes: 180, availability: 'AVAILABLE' }] });
    clean('A 180 minutes service', svc);
    clean('A 3 hours service', svc);
    flagged('A 5 hours service', /5 hours/, svc);
  });
  it('rejects invented audience and sales figures', () => {
    flagged('Loved by 10 000 happy customers', /10 000 happy customers/);
    clean('Loved by 10 000 happy customers', withKnowledge('We served 10000 customers last year.'));
  });
});

describe('claim families', () => {
  it.each([
    ['delivery time', 'Same-day delivery everywhere'],
    ['social proof', 'Rated 5 stars by our customers'],
    ['social proof', 'Trusted by thousands'],
    ['popularity', 'Our best-seller!'],
    ['medical claim', 'Clinically proven to detox your body'],
    ['medical claim', 'It cures fatigue'],
    ['time-limited offer', 'Today only!'],
    ['comparison', 'Cheaper than any other juice bar'],
    ['guarantee', 'Risk-free, satisfaction garantie'],
    ['certification', '100 bio and halal'],
  ])('rejects unsupported %s: "%s"', (name, text) => {
    flagged(text, new RegExp(`Unsupported claim \\(${name}\\)`));
  });
  it('allows a claim when the data itself says it', () => {
    clean('Same-day delivery in the city', withKnowledge('We offer same-day delivery in the city.'));
    clean('Our halal juice', withKnowledge('All drinks are halal.'));
  });
  it('scarcity needs recorded limited stock, or a stated number equal to the tracked stock', () => {
    flagged('Only 3 left!', /scarcity/);
    flagged('Limited stock, hurry', /scarcity/);
    clean('Only 3 left!', ctx({ products: [product({ stock: 3 })] }));
    flagged('Only 5 left!', /scarcity/, ctx({ products: [product({ stock: 3 })] }));
    clean('Limited stock', withKnowledge('Limited stock of seasonal flavours.'));
  });
});

describe('sources, leaks and the quality report', () => {
  it('rejects unknown sources and leaked instructions', () => {
    expect(checkGrounding({ caption: 'x', claims: [{ claim: 'x', source: 'product:nope' }] }, base).join()).toMatch(/Unknown source/);
    expect(checkGrounding({ caption: 'NON-NEGOTIABLE RULES: 1.' }, base)).toHaveLength(1);
  });
  it('reports what was verified and what failed', () => {
    const ok = assessGrounding({ caption: 'Bissap 1 500 XAF, 10% off over 10 000 XAF', claims: [{ claim: 'price', source: 'product:p1' }] }, base);
    expect(ok.passed).toBe(true);
    expect(ok.issues).toEqual([]);
    expect(ok.verified.amounts).toEqual(expect.arrayContaining(['1 500 XAF', '10 000 XAF']));
    expect(ok.verified.percentages).toEqual(['10%']);
    expect(ok.verified.sources).toEqual(['product:p1']);
    expect(ok.checks).toEqual(expect.arrayContaining(['amounts', 'currency', 'claims', 'sources']));
    const bad = assessGrounding({ caption: 'Only 990 XAF' }, base);
    expect(bad).toMatchObject({ passed: false });
    expect(bad.issues[0]).toMatch(/990 XAF/);
    expect(typeof bad.checkedAt).toBe('string');
  });
});

describe('fact preservation for the item being promoted', () => {
  const two = ctx({ products: [product({ id: 'p1', name: 'Bissap juice', price: '1500.00' }), product({ id: 'p2', name: 'Ginger juice', price: '2500.00' })] });
  const item: { type: 'PRODUCT' | 'SERVICE'; id: string } = { type: 'PRODUCT', id: 'p1' };
  const check = (caption: string, c = two, it: typeof item | null = item) => checkFactPreservation({ caption }, c, it);

  it("rejects another item's price attributed to this item, but not business-wide prices", () => {
    expect(check('Bissap juice for 1 500 XAF')).toEqual([]);
    expect(check('Bissap juice for 2 500 XAF').join()).toMatch(/belongs to another item/);
    const wide = ctx({ ...two, knowledge: [{ id: 'k1', category: 'DELIVERY_POLICY', title: 'd', body: 'Delivery costs 2 500 XAF.' }] });
    expect(check('Delivery costs 2 500 XAF', wide)).toEqual([]);
  });
  it('does not let content say an unavailable item is available now', () => {
    for (const availability of ['OUT_OF_STOCK', 'DISCONTINUED']) {
      expect(check('Order now!', ctx({ products: [product({ availability })] })).join()).toMatch(/available now/);
    }
    expect(check('Order now!', ctx({ products: [product({ stock: 0 })] })).join()).toMatch(/out of stock/);
    expect(check('Available now!', ctx({ products: [product({ availability: 'PREORDER' })] })).join()).toMatch(/preorder/);
    expect(check('Order now!', ctx({ products: [product({ availability: 'IN_STOCK' })] }))).toEqual([]);
    expect(check('Pre-order yours', ctx({ products: [product({ availability: 'PREORDER' })] }))).toEqual([]);
  });
  it('treats services the same way and ignores content without an item', () => {
    const svc = ctx({ services: [{ id: 's1', name: 'Catering', price: null, currency: 'XAF', features: [], benefits: [], availability: 'UNAVAILABLE' }] });
    expect(check('Book now, available now', svc, { type: 'SERVICE', id: 's1' }).join()).toMatch(/available now/);
    expect(check('Order now!', ctx({ products: [product({ availability: 'OUT_OF_STOCK' })] }), null)).toEqual([]);
  });
});
