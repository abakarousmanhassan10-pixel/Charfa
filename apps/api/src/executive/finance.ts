import { Prisma } from '@touma/database';
import { computeProfitability, type Profitability } from '../market/market-calc';

/**
 * Phase N22 profit intelligence for the merchant's OWN products. It reuses the verified N4 unit-economics calculation
 * (Decimal arithmetic, each line rounded half-up before summing, UNKNOWN when an input was not supplied) and adds the
 * break-even price and a scenario simulator on top. A cost that was not entered is reported missing, never guessed.
 */
const Decimal = Prisma.Decimal;
type Dec = Prisma.Decimal;
const r2 = (d: Dec) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export interface ProductPrice { price: string | null; discountPrice: string | null; currency: string }
export interface EconomicsInput {
  currency: string;
  unitCost: string | null;
  shippingCost: string | null;
  paymentFeePercent: string | null;
  paymentFixedFee: string | null;
  returnsAllowancePercent: string | null;
}

/** The selling price used: the promotional price when there is one (it is what a customer pays). */
export const sellingPrice = (p: ProductPrice): string | null => p.discountPrice ?? p.price;

export function unitEconomics(p: ProductPrice, e: EconomicsInput | null, o: { advertisingCostPerAcquisition?: string; price?: string; shippingCost?: string } = {}): Profitability {
  const cur = p.currency;
  return computeProfitability(
    {
      observedAt: new Date(0), costCurrency: e?.currency ?? cur, unitCost: e?.unitCost ?? null, shippingCost: o.shippingCost ?? e?.shippingCost ?? null, sellingCurrency: cur,
      sellingPrice: o.price ?? sellingPrice(p), estimatedDeliveryDays: null, supplierRating: null, supplierRatingSource: null, monthlySearches: null, demandSource: null, competitorCount: null, competitorSource: null,
    },
    {
      ...(e?.paymentFeePercent != null ? { paymentFeePercent: e.paymentFeePercent } : {}),
      ...(e?.paymentFixedFee != null ? { paymentFixedFee: e.paymentFixedFee } : {}),
      ...(e?.returnsAllowancePercent != null ? { returnsAllowancePercent: e.returnsAllowancePercent } : {}),
      ...(o.advertisingCostPerAcquisition !== undefined ? { advertisingCostPerAcquisition: o.advertisingCostPerAcquisition } : {}),
    },
  );
}

/** The lowest selling price at which one order contributes zero before advertising. null when an input is missing or fees reach 100%. */
export function breakEvenPrice(e: EconomicsInput | null): string | null {
  if (!e || e.unitCost == null || e.shippingCost == null || e.paymentFeePercent == null || e.paymentFixedFee == null || e.returnsAllowancePercent == null) return null;
  const keep = new Decimal(100).minus(new Decimal(e.paymentFeePercent)).minus(new Decimal(e.returnsAllowancePercent)).div(100);
  if (keep.lte(0)) return null;
  const costs = new Decimal(e.unitCost).plus(new Decimal(e.shippingCost)).plus(new Decimal(e.paymentFixedFee));
  return costs.div(keep).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed(2);
}

// ─── Scenario simulator ───────────────────────────────────────────────────────

export interface ScenarioInput {
  name: string;
  /** Overrides the selling price. */
  price?: string;
  /** Overrides the shipping cost per order. */
  shippingCost?: string;
  /** Advertising budget for the period. A SIMULATION: nothing is spent. */
  adBudget?: string;
  /** Assumed cost per click, in the selling currency. */
  costPerClick?: string;
  /** Assumed share of clicks that become orders, 0-100. */
  conversionPercent?: string;
}
export interface ScenarioResult {
  name: string;
  assumptions: Array<{ name: string; value: string; kind: 'VERIFIED_INPUT' | 'SCENARIO_ASSUMPTION' }>;
  unit: { revenue: string | null; contributionBeforeAds: string | null; marginPercentBeforeAds: string | null; breakEvenAdCostPerOrder: string | null };
  ads: { budget: string; clicks: string; orders: string; costPerOrder: string | null; breakEvenConversionPercent: string | null } | null;
  netProfit: string | null;
  netMarginPercent: string | null;
  flags: Array<'NEGATIVE_UNIT_MARGIN' | 'NEGATIVE_NET_PROFIT' | 'INCOMPLETE_INPUTS' | 'NO_ORDERS'>;
  missing: string[];
}

const num = (s: string | undefined) => (s === undefined ? null : new Decimal(s));

/** Deterministic: the same inputs always give the same numbers. Orders are rounded DOWN (conservative). */
export function simulate(p: ProductPrice, e: EconomicsInput | null, s: ScenarioInput): ScenarioResult {
  const unit = unitEconomics(p, e, { price: s.price, shippingCost: s.shippingCost });
  const rev = unit.revenue.status === 'OK' ? new Decimal(unit.revenue.amount!) : null;
  const before = unit.contributionBeforeAds.status === 'OK' ? new Decimal(unit.contributionBeforeAds.amount!) : null;
  const assumptions: ScenarioResult['assumptions'] = [];
  if (s.price !== undefined) assumptions.push({ name: 'price', value: s.price, kind: 'SCENARIO_ASSUMPTION' });
  else if (rev) assumptions.push({ name: 'price', value: rev.toFixed(2), kind: 'VERIFIED_INPUT' });
  if (s.shippingCost !== undefined) assumptions.push({ name: 'shippingCost', value: s.shippingCost, kind: 'SCENARIO_ASSUMPTION' });
  const flags: ScenarioResult['flags'] = [];
  const missing = [...unit.missing.filter((m) => m !== 'advertising cost per acquisition')];
  if (missing.length) flags.push('INCOMPLETE_INPUTS');
  if (before && before.lt(0)) flags.push('NEGATIVE_UNIT_MARGIN');

  let ads: ScenarioResult['ads'] = null;
  let net: Dec | null = null;
  if (s.adBudget !== undefined) {
    const budget = num(s.adBudget)!;
    assumptions.push({ name: 'adBudget', value: budget.toFixed(2), kind: 'SCENARIO_ASSUMPTION' });
    const cpc = num(s.costPerClick);
    const conv = num(s.conversionPercent);
    if (cpc) assumptions.push({ name: 'costPerClick', value: cpc.toFixed(2), kind: 'SCENARIO_ASSUMPTION' });
    if (conv) assumptions.push({ name: 'conversionPercent', value: conv.toFixed(2), kind: 'SCENARIO_ASSUMPTION' });
    if (!cpc || cpc.lte(0)) missing.push('cost per click (scenario assumption)');
    if (!conv) missing.push('conversion rate (scenario assumption)');
    if (cpc && cpc.gt(0) && conv) {
      const clicks = budget.div(cpc);
      const orders = clicks.mul(conv).div(100).floor();
      ads = {
        budget: budget.toFixed(2), clicks: clicks.toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0), orders: orders.toFixed(0),
        costPerOrder: orders.gt(0) ? r2(budget.div(orders)).toFixed(2) : null,
        breakEvenConversionPercent: before && before.gt(0) ? cpc.mul(100).div(before).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed(2) : null,
      };
      if (orders.lte(0)) flags.push('NO_ORDERS');
      if (before) net = r2(orders.mul(before).minus(budget));
    }
  } else if (before) {
    net = null; // no advertising in this scenario: the unit contribution is the answer
  }
  if (net && net.lt(0)) flags.push('NEGATIVE_NET_PROFIT');
  const revenueTotal = ads && rev ? new Decimal(ads.orders).mul(rev) : null;
  return {
    name: s.name,
    assumptions,
    unit: {
      revenue: rev ? rev.toFixed(2) : null,
      contributionBeforeAds: before ? before.toFixed(2) : null,
      marginPercentBeforeAds: before && rev && rev.gt(0) ? before.div(rev).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
      breakEvenAdCostPerOrder: before ? before.toFixed(2) : null,
    },
    ads, netProfit: net ? net.toFixed(2) : null,
    netMarginPercent: net && revenueTotal && revenueTotal.gt(0) ? net.div(revenueTotal).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
    flags, missing: [...new Set(missing)],
  };
}

/** Side-by-side comparison. "Best" is only the highest simulated net profit under the stated assumptions: never a forecast. */
export function compare(p: ProductPrice, e: EconomicsInput | null, scenarios: ScenarioInput[]) {
  const results = scenarios.map((s) => simulate(p, e, s));
  const comparable = results.filter((r) => r.netProfit !== null);
  const best = comparable.length > 1 ? comparable.reduce((a, b) => (new Decimal(b.netProfit!).gt(new Decimal(a.netProfit!)) ? b : a)).name : null;
  return { results, best, note: 'Simulated with the assumptions shown. These are not forecasts or guarantees.' };
}
