import { MIN_COVERAGE, NEAR_DUPLICATE_THRESHOLD, WEIGHTS, analyze, computeProfitability, dedupeKey, freshness, nameSimilarity, normalizeName, normalizeUrl, type Assumptions, type MarketProductInput } from './market-calc';

const AS_OF = new Date('2026-11-13T12:00:00Z');
const daysBefore = (n: number) => new Date(AS_OF.getTime() - n * 86_400_000);

/** Fixture A: every piece of evidence supplied, supplier paid in CNY, sold in USD. */
const FULL: MarketProductInput = {
  observedAt: daysBefore(3), costCurrency: 'CNY', unitCost: '20.00', shippingCost: '5.00', sellingCurrency: 'USD', sellingPrice: '49.90', estimatedDeliveryDays: 12,
  supplierRating: '4.50', supplierRatingSource: 'Supplier marketplace profile', monthlySearches: 12_000, demandSource: 'Keyword tool export', competitorCount: 22, competitorSource: 'Manual count of listings',
};
const ASSUME: Assumptions = { paymentFeePercent: '2.9', paymentFixedFee: '0.30', returnsAllowancePercent: '5', advertisingCostPerAcquisition: '12.00', fx: { source: 'Bank rate sheet', asOf: '2026-11-12', rates: { CNY: '0.14' } } };
/** Fixture B: only a name, a cost and a price. */
const SPARSE: MarketProductInput = { observedAt: daysBefore(40), costCurrency: 'USD', unitCost: '10.00', shippingCost: null, sellingCurrency: 'USD', sellingPrice: '30.00', estimatedDeliveryDays: null, supplierRating: null, supplierRatingSource: null, monthlySearches: null, demandSource: null, competitorCount: null, competitorSource: null };

describe('normalisation and duplicates', () => {
  it('normalises names: case, accents, punctuation, spacing', () => {
    expect(normalizeName('  Café-Filtre  (500 ML)! ')).toBe('cafe filtre 500 ml');
    expect(normalizeName('ÉTUI iPhone 15')).toBe('etui iphone 15');
  });
  it('gives the same key to the same words in any order, per market and supplier', () => {
    expect(dedupeKey('Bissap Juice 500ml', 'td')).toBe(dedupeKey('500ML  juice, BISSAP', 'TD'));
    expect(dedupeKey('Bissap Juice', 'TD')).not.toBe(dedupeKey('Bissap Juice', 'FR'));
    expect(dedupeKey('Bissap Juice', 'TD', 'Acme')).not.toBe(dedupeKey('Bissap Juice', 'TD', 'Other'));
    expect(dedupeKey('Bissap Juice', 'TD', 'ACME  Ltd.')).toBe(dedupeKey('Bissap Juice', 'TD', 'acme ltd'));
  });
  it('measures word-set similarity and flags near duplicates at the threshold', () => {
    expect(nameSimilarity('Wireless Bluetooth Earbuds Pro', 'Bluetooth Wireless Earbuds')).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
    expect(nameSimilarity('Wireless Earbuds', 'Garden Hose')).toBe(0);
    expect(nameSimilarity('', 'x')).toBe(0);
  });
  it('recognises the same page behind tracking parameters, case and trailing slashes', () => {
    const a = normalizeUrl('HTTPS://Shop.Example.com/p/123/?utm_source=x&b=2&a=1&gclid=zzz#frag');
    expect(a).toBe('https://shop.example.com/p/123?a=1&b=2');
    expect(normalizeUrl('https://shop.example.com/p/123?b=2&a=1')).toBe(a);
    expect(normalizeUrl('https://shop.example.com/p/124?a=1&b=2')).not.toBe(a);
  });
});

describe('data freshness', () => {
  it('has exact day boundaries', () => {
    const level = (n: number) => freshness(daysBefore(n), AS_OF);
    expect(level(0)).toEqual({ days: 0, level: 'FRESH' });
    expect(level(7).level).toBe('FRESH');
    expect(level(8).level).toBe('RECENT');
    expect(level(30).level).toBe('RECENT');
    expect(level(31).level).toBe('STALE');
    expect(level(90).level).toBe('STALE');
    expect(level(91).level).toBe('OUTDATED');
    expect(freshness(new Date(AS_OF.getTime() + 86_400_000), AS_OF).days).toBe(0); // a future date never gives negative age
  });
});

describe('profitability', () => {
  it('computes every line, converts the supplier currency with the supplied rate and adds up exactly', () => {
    const p = computeProfitability(FULL, ASSUME);
    expect(p.currency).toBe('USD');
    expect(p.revenue.amount).toBe('49.90');
    expect(p.acquisitionCost).toMatchObject({ amount: '2.80', note: 'converted from CNY at 0.14' }); // 20.00 x 0.14
    expect(p.shippingCost.amount).toBe('0.70'); // 5.00 x 0.14
    expect(p.paymentFees.amount).toBe('1.75'); // 1.45 (2.9% of 49.90 = 1.4471) + 0.30
    expect(p.returnsAllowance.amount).toBe('2.50'); // 5% of 49.90 = 2.495, half up
    expect(p.contributionBeforeAds.amount).toBe('42.15'); // 49.90 - 2.80 - 0.70 - 1.75 - 2.50
    expect(p.advertisingCost.amount).toBe('12.00');
    expect(p.contributionAfterAds.amount).toBe('30.15');
    expect(p.marginPercent.amount).toBe('60.42'); // 30.15 / 49.90
    expect(p.breakEvenAdCost.amount).toBe('42.15');
    expect(p.missing).toEqual([]);
    expect(p.fx).toEqual({ used: [{ currency: 'CNY', rate: '0.14' }], source: 'Bank rate sheet', asOf: '2026-11-12' });
  });

  it('rounds half up line by line (so printed lines add up)', () => {
    const p = computeProfitability({ ...FULL, costCurrency: 'USD', sellingPrice: '10.10', unitCost: '1.00', shippingCost: '1.00' }, { ...ASSUME, paymentFeePercent: '0', paymentFixedFee: '0', returnsAllowancePercent: '5' });
    expect(p.returnsAllowance.amount).toBe('0.51'); // 0.505
    expect(p.contributionBeforeAds.amount).toBe('7.59'); // 10.10 - 1 - 1 - 0 - 0.51
  });

  it('never invents a number: missing inputs make the dependent figures UNKNOWN and say why', () => {
    const p = computeProfitability(SPARSE, {});
    expect(p.revenue.status).toBe('OK');
    for (const k of ['shippingCost', 'paymentFees', 'returnsAllowance', 'advertisingCost', 'contributionBeforeAds', 'contributionAfterAds', 'marginPercent', 'breakEvenAdCost'] as const) {
      expect(p[k]).toMatchObject({ status: 'UNKNOWN', amount: null });
      expect(p[k].note).toBeTruthy();
    }
    expect(p.missing).toEqual(expect.arrayContaining(['shipping cost', 'payment fees', 'returns allowance', 'advertising cost per acquisition']));
    // A fee percentage without the fixed fee is not enough: zero must be stated, not assumed.
    expect(computeProfitability(FULL, { ...ASSUME, paymentFixedFee: undefined }).paymentFees.note).toMatch(/fixed fee/);
  });

  it('reports a missing exchange rate instead of guessing one', () => {
    const p = computeProfitability(FULL, { ...ASSUME, fx: undefined });
    expect(p.acquisitionCost).toMatchObject({ status: 'UNKNOWN', note: 'no exchange rate CNY→USD was supplied' });
    expect(p.contributionBeforeAds.status).toBe('UNKNOWN');
    expect(p.fx).toEqual({ used: [], source: null, asOf: null });
  });

  it('still gives the break-even advertising cost when only the advertising cost is missing', () => {
    const p = computeProfitability(FULL, { ...ASSUME, advertisingCostPerAcquisition: undefined });
    expect(p.breakEvenAdCost.amount).toBe('42.15');
    expect(p.contributionAfterAds.status).toBe('UNKNOWN');
    expect(p.marginPercent.status).toBe('UNKNOWN');
  });

  it('reports a loss honestly, with a negative break-even', () => {
    const p = computeProfitability({ ...FULL, costCurrency: 'USD', unitCost: '60.00' }, ASSUME);
    expect(p.contributionBeforeAds.amount).toBe('-19.35'); // 49.90 - 60 - 5.00 (USD) - 1.75 - 2.50
    expect(p.breakEvenAdCost.amount).toBe('-19.35');
  });
});

describe('opportunity score', () => {
  it('weights sum to 100', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('explains a fully evidenced product, component by component', () => {
    const r = analyze(FULL, ASSUME, AS_OF);
    const s = r.score;
    expect(Object.fromEntries(s.components.map((c) => [c.key, c.points]))).toEqual({ demand: 80, margin: 100, competition: 45, supplier: 90, shipping: 75, quality: 100 });
    expect(s).toMatchObject({ score: 83, verdict: 'PROMISING', coverage: 100, confidence: 'HIGH', flags: [] }); // (80*25+100*25+45*15+90*15+75*10+100*10)/100 = 82.75
    expect(s.components.every((c) => c.status === 'OK' && c.evidence.length > 0)).toBe(true);
    expect(r.quality.freshness).toMatchObject({ days: 3, level: 'FRESH' });
  });

  it('is reproducible: same inputs and asOf give identical results, and key order does not matter', () => {
    const a = JSON.stringify(analyze(FULL, ASSUME, AS_OF));
    for (let i = 0; i < 5; i++) expect(JSON.stringify(analyze({ ...FULL }, { ...ASSUME }, new Date(AS_OF)))).toBe(a);
    const reordered = { fx: ASSUME.fx, advertisingCostPerAcquisition: ASSUME.advertisingCostPerAcquisition, returnsAllowancePercent: ASSUME.returnsAllowancePercent, paymentFixedFee: ASSUME.paymentFixedFee, paymentFeePercent: ASSUME.paymentFeePercent };
    expect(JSON.stringify(analyze(FULL, reordered, AS_OF).score)).toBe(JSON.stringify(analyze(FULL, ASSUME, AS_OF).score));
  });

  it('leaves unknown components out instead of counting them as zero, and lowers the confidence', () => {
    const partial = analyze({ ...FULL, supplierRating: null, supplierRatingSource: null, estimatedDeliveryDays: null }, ASSUME, AS_OF).score;
    expect(partial.components.filter((c) => c.status === 'UNKNOWN').map((c) => c.key).sort()).toEqual(['shipping', 'supplier']);
    expect(partial.components.filter((c) => c.status === 'UNKNOWN').every((c) => c.points === null)).toBe(true);
    expect(partial).toMatchObject({ coverage: 75, confidence: 'MEDIUM', score: 80 }); // (80*25+100*25+45*15+86*10)/75
  });

  it('shows no score below the minimum evidence, instead of a number made of nothing', () => {
    const s = analyze(SPARSE, {}, AS_OF).score;
    expect(s).toMatchObject({ score: null, verdict: 'INSUFFICIENT_EVIDENCE', coverage: 10, confidence: 'LOW' });
    expect(s.coverage).toBeLessThan(MIN_COVERAGE);
    expect(s.components.find((c) => c.key === 'quality')).toMatchObject({ status: 'OK', points: 34 }); // 2/7 fields known, 40 days old (STALE)
    expect(s.flags).toContain('STALE_DATA');
  });

  it('a figure without a named source is not evidence', () => {
    const s = analyze({ ...FULL, demandSource: null, competitorSource: '', supplierRatingSource: null }, ASSUME, AS_OF).score;
    for (const k of ['demand', 'competition', 'supplier'] as const) expect(s.components.find((c) => c.key === k)).toMatchObject({ status: 'UNKNOWN', points: null });
  });

  it('flags a negative margin and gives it zero points, and ages the data', () => {
    const s = analyze({ ...FULL, costCurrency: 'USD', unitCost: '60.00', observedAt: daysBefore(120) }, ASSUME, AS_OF).score;
    expect(s.flags).toEqual(expect.arrayContaining(['NEGATIVE_MARGIN', 'STALE_DATA']));
    expect(s.components.find((c) => c.key === 'margin')?.points).toBe(0);
    expect(s.components.find((c) => c.key === 'quality')?.evidence).toMatch(/OUTDATED/);
  });

  it('scores the band edges as documented', () => {
    const pts = (over: Partial<MarketProductInput>, key: string) => analyze({ ...FULL, ...over }, ASSUME, AS_OF).score.components.find((c) => c.key === key)?.points;
    expect([99, 100, 999, 1000, 9999, 10000, 99999, 100000].map((n) => pts({ monthlySearches: n }, 'demand'))).toEqual([10, 30, 30, 55, 55, 80, 80, 100]);
    expect([0, 4, 5, 14, 15, 39, 40, 99, 100].map((n) => pts({ competitorCount: n }, 'competition'))).toEqual([90, 90, 70, 70, 45, 45, 25, 25, 10]);
    expect([7, 8, 14, 15, 21, 22, 30, 31].map((n) => pts({ estimatedDeliveryDays: n }, 'shipping'))).toEqual([100, 75, 75, 50, 50, 25, 25, 5]);
    expect(['0.00', '2.50', '5.00'].map((r) => pts({ supplierRating: r }, 'supplier'))).toEqual([0, 50, 100]);
  });
});
