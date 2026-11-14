import { breakEvenPrice, compare, simulate, unitEconomics, type EconomicsInput } from './finance';

const product = { price: '10000', discountPrice: null, currency: 'XAF' };
const econ: EconomicsInput = { currency: 'XAF', unitCost: '4000', shippingCost: '1000', paymentFeePercent: '2.5', paymentFixedFee: '0', returnsAllowancePercent: '5' };

describe('unit economics (reuses the N4 calculation)', () => {
  it('computes contribution exactly: 10000 - 4000 - 1000 - 250 - 500 = 4250', () => {
    const u = unitEconomics(product, econ);
    expect(u.paymentFees.amount).toBe('250.00');
    expect(u.returnsAllowance.amount).toBe('500.00');
    expect(u.contributionBeforeAds.amount).toBe('4250.00');
    expect(u.breakEvenAdCost.amount).toBe('4250.00');
    expect(u.missing).toEqual(['advertising cost per acquisition']);
  });
  it('uses the promotional price when there is one', () => {
    expect(unitEconomics({ ...product, discountPrice: '8000' }, econ).revenue.amount).toBe('8000.00');
  });
  it('never invents a missing cost: the contribution stays unknown and names what is missing', () => {
    const u = unitEconomics(product, { ...econ, unitCost: null });
    expect(u.contributionBeforeAds).toMatchObject({ status: 'UNKNOWN', amount: null });
    expect(u.contributionBeforeAds.note).toMatch(/unit cost/);
    const none = unitEconomics(product, null);
    expect(none.contributionBeforeAds.status).toBe('UNKNOWN');
    expect(unitEconomics({ price: null, discountPrice: null, currency: 'XAF' }, econ).revenue.status).toBe('UNKNOWN');
  });
  it('break-even price: the smallest price with zero contribution (rounded up, never below)', () => {
    const be = breakEvenPrice(econ)!; // (4000+1000+0) / (1 - 0.075) = 5405.405... -> 5405.41
    expect(be).toBe('5405.41');
    expect(unitEconomics({ ...product, price: be }, econ).contributionBeforeAds.amount).toBe('0.00'); // exactly break-even at the printed price
    expect(unitEconomics({ ...product, price: '5405.40' }, econ).contributionBeforeAds.amount).toBe('-0.01');
    expect(breakEvenPrice({ ...econ, unitCost: null })).toBeNull();
    expect(breakEvenPrice({ ...econ, paymentFeePercent: '60', returnsAllowancePercent: '40' })).toBeNull();
  });
});

describe('scenario simulator (deterministic, assumptions explicit)', () => {
  const ads = { adBudget: '100000', costPerClick: '50', conversionPercent: '2' };
  it('computes orders, cost per order and net profit: 2000 clicks x 2% = 40 orders; 40 x 4250 - 100000 = 70000', () => {
    const r = simulate(product, econ, { name: 'base', ...ads });
    expect(r.ads).toMatchObject({ clicks: '2000', orders: '40', costPerOrder: '2500.00' });
    expect(r.netProfit).toBe('70000.00');
    expect(r.netMarginPercent).toBe('17.50'); // 70000 / (40 x 10000)
    expect(r.ads!.breakEvenConversionPercent).toBe('1.18'); // 50 x 100 / 4250 = 1.176.. rounded up
    expect(r.flags).toEqual([]);
    expect(r.assumptions.find((a) => a.name === 'conversionPercent')!.kind).toBe('SCENARIO_ASSUMPTION');
  });
  it('flags a negative unit margin and a negative net profit', () => {
    const r = simulate({ ...product, price: '5000' }, econ, { name: 'cheap', ...ads });
    expect(r.unit.contributionBeforeAds).toBe('-375.00'); // 5000 - 4000 - 1000 - 125 - 250
    expect(r.ads!.orders).toBe('40');
    expect(r.netProfit).toBe('-115000.00'); // 40 x -375 - 100000
    expect(r.flags).toEqual(expect.arrayContaining(['NEGATIVE_UNIT_MARGIN', 'NEGATIVE_NET_PROFIT']));
  });
  it('rounds orders down and reports no orders when the budget buys none', () => {
    const r = simulate(product, econ, { name: 'tiny', adBudget: '10', costPerClick: '50', conversionPercent: '2' });
    expect(r.ads!.orders).toBe('0');
    expect(r.flags).toContain('NO_ORDERS');
    expect(r.netProfit).toBe('-10.00');
    expect(r.flags).toContain('NEGATIVE_NET_PROFIT');
  });
  it('does not guess missing assumptions or costs', () => {
    const noConv = simulate(product, econ, { name: 'a', adBudget: '1000', costPerClick: '50' });
    expect(noConv.netProfit).toBeNull();
    expect(noConv.missing).toContain('conversion rate (scenario assumption)');
    const noCost = simulate(product, { ...econ, unitCost: null }, { name: 'b', ...ads });
    expect(noCost.netProfit).toBeNull();
    expect(noCost.flags).toContain('INCOMPLETE_INPUTS');
  });
  it('compares scenarios and names the highest simulated profit without promising it', () => {
    const c = compare(product, econ, [{ name: 'price 10000', ...ads }, { name: 'price 12000', price: '12000', ...ads }, { name: 'free shipping', shippingCost: '0', ...ads }]);
    expect(c.results).toHaveLength(3);
    expect(c.best).toBeTruthy();
    expect(c.note).toMatch(/not forecasts or guarantees/);
    expect(compare(product, econ, [{ name: 'only one', ...ads }]).best).toBeNull();
  });
});
