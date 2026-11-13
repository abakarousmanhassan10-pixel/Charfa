import { createHash } from 'crypto';
import { Prisma } from '@touma/database';

/**
 * Deterministic market-intelligence calculations (Phase N4). Pure functions: no database, no clock, no network, no AI.
 * The same product, assumptions and `asOf` always give the same result. A number that was not supplied is UNKNOWN and is
 * never replaced by a guess; an UNKNOWN component is left out of the score instead of being counted as zero.
 */
const Decimal = Prisma.Decimal;
type Dec = Prisma.Decimal;
const HALF_UP = Decimal.ROUND_HALF_UP;

export const MODEL_VERSION = '1';

/** Scoring weights (they sum to 100). Documented in docs/MARKET-INTELLIGENCE.md. */
export const WEIGHTS = { demand: 25, margin: 25, competition: 15, supplier: 15, shipping: 10, quality: 10 } as const;
export type ComponentKey = keyof typeof WEIGHTS;
/** The score is only shown when the known components carry at least this share of the weights. */
export const MIN_COVERAGE = 50;

// ─── Normalisation and duplicates ───────────────────────────────────────────────

export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const nameTokens = (name: string): string[] => [...new Set(normalizeName(name).split(' ').filter(Boolean))].sort();

/** Exact-duplicate key: same words (any order), same market, same supplier. */
export function dedupeKey(name: string, country: string, supplier?: string | null): string {
  return createHash('sha256').update(`${nameTokens(name).join(' ')}|${country.toUpperCase()}|${normalizeName(supplier ?? '')}`).digest('hex');
}

/** Jaccard similarity of the word sets of two names, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const x = new Set(nameTokens(a));
  const y = new Set(nameTokens(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}
export const NEAR_DUPLICATE_THRESHOLD = 0.75;

const TRACKING = /^(utm_|gclid$|fbclid$|msclkid$|ref$|ref_$|igshid$)/i;
/** Canonical form of a source URL, to recognise the same page behind tracking parameters, case and trailing slashes. */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  const path = u.pathname.replace(/\/+$/, '') || '';
  return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
}

// ─── Freshness ──────────────────────────────────────────────────────────────────

export type FreshnessLevel = 'FRESH' | 'RECENT' | 'STALE' | 'OUTDATED';
export const FRESHNESS_DAYS = { FRESH: 7, RECENT: 30, STALE: 90 } as const;

export function freshness(observedAt: Date, asOf: Date): { days: number; level: FreshnessLevel } {
  const days = Math.max(0, Math.floor((asOf.getTime() - observedAt.getTime()) / 86_400_000));
  const level: FreshnessLevel = days <= FRESHNESS_DAYS.FRESH ? 'FRESH' : days <= FRESHNESS_DAYS.RECENT ? 'RECENT' : days <= FRESHNESS_DAYS.STALE ? 'STALE' : 'OUTDATED';
  return { days, level };
}

// ─── Profitability ──────────────────────────────────────────────────────────────

export interface MarketProductInput {
  observedAt: Date;
  costCurrency: string;
  unitCost: string | null;
  shippingCost: string | null;
  sellingCurrency: string;
  sellingPrice: string | null;
  estimatedDeliveryDays: number | null;
  supplierRating: string | null;
  supplierRatingSource: string | null;
  monthlySearches: number | null;
  demandSource: string | null;
  competitorCount: number | null;
  competitorSource: string | null;
}

export interface Assumptions {
  /** Share of the selling price taken by the payment processor, 0-100. */
  paymentFeePercent?: string;
  /** Fixed processor fee per order, in the selling currency. */
  paymentFixedFee?: string;
  /** Expected cost of returns and refunds, as a share of the selling price, 0-100. */
  returnsAllowancePercent?: string;
  /** Advertising cost to win one customer, in the selling currency. */
  advertisingCostPerAcquisition?: string;
  /** Currency conversion: `rates[CUR]` = units of the selling currency per 1 unit of CUR. Needs a named source and a date. */
  fx?: { source: string; asOf: string; rates: Record<string, string> };
}

export interface Amount {
  status: 'OK' | 'UNKNOWN';
  amount: string | null;
  note?: string;
}
const ok = (d: Dec, note?: string): Amount => ({ status: 'OK', amount: d.toFixed(2), ...(note ? { note } : {}) });
const unknown = (note: string): Amount => ({ status: 'UNKNOWN', amount: null, note });
const r2 = (d: Dec) => d.toDecimalPlaces(2, HALF_UP);
const val = (a: Amount): Dec | null => (a.status === 'OK' ? new Decimal(a.amount!) : null);

export interface Profitability {
  currency: string;
  revenue: Amount;
  acquisitionCost: Amount;
  shippingCost: Amount;
  paymentFees: Amount;
  returnsAllowance: Amount;
  advertisingCost: Amount;
  contributionBeforeAds: Amount;
  contributionAfterAds: Amount;
  /** Contribution margin after advertising, as a percentage of the selling price. */
  marginPercent: Amount;
  /** The most one acquisition may cost in advertising before the product loses money (= contribution before ads). */
  breakEvenAdCost: Amount;
  missing: string[];
  fx: { used: Array<{ currency: string; rate: string }>; source: string | null; asOf: string | null };
}

function convert(amount: string | null, from: string, to: string, a: Assumptions, used: Map<string, string>, label: string): Amount {
  if (amount === null) return unknown(`${label} was not supplied`);
  if (from === to) return ok(r2(new Decimal(amount)));
  const rate = a.fx?.rates?.[from];
  if (!rate) return unknown(`no exchange rate ${from}→${to} was supplied`);
  used.set(from, rate);
  return ok(r2(new Decimal(amount).mul(new Decimal(rate))), `converted from ${from} at ${rate}`);
}

/**
 * Unit economics in the selling currency. Each line is rounded to 2 decimals (half up) before it is added, so the
 * printed lines always add up to the printed totals. A total is UNKNOWN when any line it needs is UNKNOWN.
 */
export function computeProfitability(p: MarketProductInput, a: Assumptions): Profitability {
  const cur = p.sellingCurrency;
  const used = new Map<string, string>();
  const revenue: Amount = p.sellingPrice === null ? unknown('selling price was not supplied') : ok(r2(new Decimal(p.sellingPrice)));
  const acquisitionCost = convert(p.unitCost, p.costCurrency, cur, a, used, 'unit cost');
  const shippingCost = convert(p.shippingCost, p.costCurrency, cur, a, used, 'shipping cost');
  const rev = val(revenue);

  const paymentFees: Amount =
    rev === null ? unknown('needs the selling price')
    : a.paymentFeePercent === undefined ? unknown('payment fee percentage was not supplied')
    : a.paymentFixedFee === undefined ? unknown('payment fixed fee was not supplied (enter 0 if there is none)')
    : ok(r2(rev.mul(new Decimal(a.paymentFeePercent)).div(100)).plus(r2(new Decimal(a.paymentFixedFee))));
  const returnsAllowance: Amount =
    rev === null ? unknown('needs the selling price')
    : a.returnsAllowancePercent === undefined ? unknown('returns allowance was not supplied')
    : ok(r2(rev.mul(new Decimal(a.returnsAllowancePercent)).div(100)));
  const advertisingCost: Amount = a.advertisingCostPerAcquisition === undefined ? unknown('advertising cost per acquisition was not supplied') : ok(r2(new Decimal(a.advertisingCostPerAcquisition)));

  const lines = { 'selling price': revenue, 'unit cost': acquisitionCost, 'shipping cost': shippingCost, 'payment fees': paymentFees, 'returns allowance': returnsAllowance };
  const missingBefore = Object.entries(lines).filter(([, v]) => v.status !== 'OK').map(([k]) => k);
  let contributionBeforeAds: Amount = unknown(`needs: ${missingBefore.join(', ')}`);
  if (!missingBefore.length) contributionBeforeAds = ok(val(revenue)!.minus(val(acquisitionCost)!).minus(val(shippingCost)!).minus(val(paymentFees)!).minus(val(returnsAllowance)!));
  const before = val(contributionBeforeAds);
  const ads = val(advertisingCost);
  const contributionAfterAds: Amount = before === null ? unknown('needs the contribution before advertising') : ads === null ? unknown('advertising cost per acquisition was not supplied') : ok(before.minus(ads));
  const after = val(contributionAfterAds);
  const marginPercent: Amount = after === null ? unknown('needs the contribution after advertising') : rev === null || rev.lte(0) ? unknown('needs a positive selling price') : { status: 'OK', amount: after.div(rev).mul(100).toDecimalPlaces(2, HALF_UP).toFixed(2) };
  const breakEvenAdCost: Amount = before === null ? unknown('needs the contribution before advertising') : ok(before, 'maximum advertising cost per acquisition');

  const missing = [...new Set([...missingBefore, ...(ads === null ? ['advertising cost per acquisition'] : [])])];
  return {
    currency: cur, revenue, acquisitionCost, shippingCost, paymentFees, returnsAllowance, advertisingCost,
    contributionBeforeAds, contributionAfterAds, marginPercent, breakEvenAdCost, missing,
    fx: { used: [...used].map(([currency, rate]) => ({ currency, rate })), source: used.size ? (a.fx?.source ?? null) : null, asOf: used.size ? (a.fx?.asOf ?? null) : null },
  };
}

// ─── Opportunity score ──────────────────────────────────────────────────────────

export interface ScoreComponent {
  key: ComponentKey;
  weight: number;
  status: 'OK' | 'UNKNOWN';
  /** What the points were computed from. */
  evidence: string;
  points: number | null;
}
export interface OpportunityScore {
  modelVersion: string;
  /** 0-100, or null when the known components carry less than MIN_COVERAGE of the weights. */
  score: number | null;
  verdict: 'PROMISING' | 'MIXED' | 'WEAK' | 'INSUFFICIENT_EVIDENCE';
  /** Share (0-100) of the weights that rest on known evidence. */
  coverage: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  components: ScoreComponent[];
  flags: string[];
}

const band = (v: number, table: Array<[number, number]>, otherwise: number) => table.find(([max]) => v <= max)?.[1] ?? otherwise;

/** The evidence fields that make up the completeness part of the quality component. */
const EVIDENCE_FIELDS: Array<[string, (p: MarketProductInput) => boolean]> = [
  ['unitCost', (p) => p.unitCost !== null],
  ['shippingCost', (p) => p.shippingCost !== null],
  ['sellingPrice', (p) => p.sellingPrice !== null],
  ['estimatedDeliveryDays', (p) => p.estimatedDeliveryDays !== null],
  ['supplierRating', (p) => p.supplierRating !== null && Boolean(p.supplierRatingSource)],
  ['monthlySearches', (p) => p.monthlySearches !== null && Boolean(p.demandSource)],
  ['competitorCount', (p) => p.competitorCount !== null && Boolean(p.competitorSource)],
];

export interface Quality {
  freshness: { days: number; level: FreshnessLevel; observedAt: string };
  completeness: { known: string[]; missing: string[]; ratio: number };
}

export function computeQuality(p: MarketProductInput, asOf: Date): Quality {
  const known = EVIDENCE_FIELDS.filter(([, f]) => f(p)).map(([k]) => k);
  const missing = EVIDENCE_FIELDS.filter(([, f]) => !f(p)).map(([k]) => k);
  return { freshness: { ...freshness(p.observedAt, asOf), observedAt: p.observedAt.toISOString() }, completeness: { known, missing, ratio: known.length / EVIDENCE_FIELDS.length } };
}

export function computeScore(p: MarketProductInput, profit: Profitability, quality: Quality): OpportunityScore {
  const U = (key: ComponentKey, evidence: string): ScoreComponent => ({ key, weight: WEIGHTS[key], status: 'UNKNOWN', evidence, points: null });
  const K = (key: ComponentKey, points: number, evidence: string): ScoreComponent => ({ key, weight: WEIGHTS[key], status: 'OK', evidence, points: Math.max(0, Math.min(100, Math.round(points))) });

  const demand = p.monthlySearches === null ? U('demand', 'no demand evidence supplied') : !p.demandSource ? U('demand', 'demand figure has no named source') : K('demand', band(p.monthlySearches, [[99, 10], [999, 30], [9_999, 55], [99_999, 80]], 100), `${p.monthlySearches} monthly searches (${p.demandSource})`);
  const competition = p.competitorCount === null ? U('competition', 'no competitor count supplied') : !p.competitorSource ? U('competition', 'competitor count has no named source') : K('competition', band(p.competitorCount, [[4, 90], [14, 70], [39, 45], [99, 25]], 10), `${p.competitorCount} competitors (${p.competitorSource})`);
  const margin: ScoreComponent =
    profit.marginPercent.status === 'OK'
      ? K('margin', new Decimal(profit.marginPercent.amount!).div(40).mul(100).toNumber(), `contribution margin ${profit.marginPercent.amount}% after advertising (100 points from 40%)`)
      : U('margin', profit.marginPercent.note ?? 'margin cannot be computed');
  const shipping = p.estimatedDeliveryDays === null ? U('shipping', 'no delivery estimate supplied') : K('shipping', band(p.estimatedDeliveryDays, [[7, 100], [14, 75], [21, 50], [30, 25]], 5), `${p.estimatedDeliveryDays} days estimated delivery`);
  const supplier = p.supplierRating === null ? U('supplier', 'no supplier rating supplied') : !p.supplierRatingSource ? U('supplier', 'supplier rating has no named source') : K('supplier', new Decimal(p.supplierRating).mul(20).toNumber(), `rating ${p.supplierRating}/5 (${p.supplierRatingSource})`);
  const freshPoints = { FRESH: 100, RECENT: 70, STALE: 40, OUTDATED: 10 }[quality.freshness.level];
  const qualityC = K('quality', 0.5 * quality.completeness.ratio * 100 + 0.5 * freshPoints, `${quality.completeness.known.length}/${quality.completeness.known.length + quality.completeness.missing.length} evidence fields known; data ${quality.freshness.days} days old (${quality.freshness.level})`);

  const components = [demand, margin, competition, supplier, shipping, qualityC];
  const knownC = components.filter((c) => c.status === 'OK');
  const coverage = knownC.reduce((n, c) => n + c.weight, 0);
  const flags: string[] = [];
  if (profit.marginPercent.status === 'OK' && new Decimal(profit.marginPercent.amount!).lt(0)) flags.push('NEGATIVE_MARGIN');
  if (quality.freshness.level === 'STALE' || quality.freshness.level === 'OUTDATED') flags.push('STALE_DATA');
  const confidence = coverage >= 85 ? 'HIGH' : coverage >= 60 ? 'MEDIUM' : 'LOW';
  if (coverage < MIN_COVERAGE) return { modelVersion: MODEL_VERSION, score: null, verdict: 'INSUFFICIENT_EVIDENCE', coverage, confidence, components, flags };
  const weighted = knownC.reduce((s, c) => s.plus(new Decimal(c.points!).mul(c.weight)), new Decimal(0));
  const score = weighted.div(coverage).toDecimalPlaces(0, HALF_UP).toNumber();
  return { modelVersion: MODEL_VERSION, score, verdict: score >= 70 ? 'PROMISING' : score >= 40 ? 'MIXED' : 'WEAK', coverage, confidence, components, flags };
}

export function analyze(p: MarketProductInput, a: Assumptions, asOf: Date) {
  const profitability = computeProfitability(p, a);
  const quality = computeQuality(p, asOf);
  return { modelVersion: MODEL_VERSION, profitability, quality, score: computeScore(p, profitability, quality) };
}
