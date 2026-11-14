import { detectInjection, sanitizeUntrusted } from '@touma/ai-engine';

/**
 * Phase N20: the specialised agents, as pure deterministic functions (the "mock provider": no model, no network, no cost).
 * Each takes sanitized structured input and returns structured output. A real model can replace one later behind the same
 * signature, inside the same contract (tools, scope, timeout, budget). None can publish, send or spend.
 */

export interface ProductFacts {
  id: string;
  name: string;
  description?: string | null;
  price?: string | number | null;
  discountPrice?: string | number | null;
  currency?: string | null;
  stockQuantity?: number | null;
  availability?: string | null;
  features?: string[] | null;
  benefits?: string[] | null;
  targetAudience?: string | null;
  category?: { name: string } | null;
}

const clean = (s: string, max = 200) => sanitizeUntrusted(s, max).replace(/\s+/g, ' ').trim();
const list = (v: string[] | null | undefined) => (v ?? []).map((x) => clean(x, 120)).filter(Boolean).slice(0, 6);
const money = (p: ProductFacts) => (p.price !== null && p.price !== undefined && p.price !== '' ? `${p.price}${p.currency ? ` ${p.currency}` : ''}` : null);

// ── 1. Product Intelligence ──────────────────────────────────────────────────
export interface ProductInsight {
  productId: string;
  name: string;
  positioning: string;
  problemsAddressed: string[];
  verifiedFacts: { price: string | null; availability: string | null };
  missing: string[];
  /** Untrusted text that looked like an instruction: it is kept out of every output. */
  flagged: boolean;
}

export function productIntelligence(products: ProductFacts[]): { insights: ProductInsight[] } {
  return {
    insights: products.map((p) => {
      const benefits = list(p.benefits);
      const features = list(p.features);
      const flagged = [p.name, p.description ?? '', ...benefits, ...features].some((t) => detectInjection(t).length > 0);
      const safe = (t: string) => (detectInjection(t).length > 0 ? '' : t);
      const name = clean(p.name, 120);
      const category = p.category?.name ? clean(p.category.name, 60) : null;
      const missing = [!p.description && 'description', benefits.length === 0 && 'benefits', features.length === 0 && 'features', money(p) === null && 'price', !p.targetAudience && 'targetAudience'].filter(Boolean) as string[];
      return {
        productId: p.id,
        name,
        positioning: [`${name}${category ? `, a ${category.toLowerCase()} product` : ''}`, benefits[0] ? `known for: ${safe(benefits[0])}` : features[0] ? `key feature: ${safe(features[0])}` : null].filter(Boolean).join(': ').slice(0, 300),
        problemsAddressed: benefits.map(safe).filter(Boolean),
        verifiedFacts: { price: money(p), availability: p.availability ?? null },
        missing,
        flagged,
      };
    }),
  };
}

// ── 2. Market Research ───────────────────────────────────────────────────────
export interface MarketReport {
  status: 'UNAVAILABLE' | 'AVAILABLE';
  reason: string;
  /** Only figures the merchant workspace actually holds. Empty when unavailable: nothing is invented. */
  items: Array<{ label: string; value: string; source: string }>;
}
export function marketResearch(): MarketReport {
  return { status: 'UNAVAILABLE', reason: 'No verified market data in this workspace. TOUMA does not estimate market sizes, trends or competitor figures.', items: [] };
}

// ── 3. Audience Strategy ─────────────────────────────────────────────────────
const SENSITIVE = /\b(religio\w*|ethnic\w*|race|racial|politic\w*|sexual\w*|orientation|health|medical|disab\w*|pregnan\w*|age of children|minor|child(?:ren)?|union|religion|musulman\w*|chr[ée]tien\w*|sant[ée]|politique)\b/i;
export interface AudienceSegment { label: string; basis: 'PRODUCT_TARGET_AUDIENCE' | 'PRODUCT_CATEGORY' | 'GENERAL' }
export function audienceStrategy(products: ProductFacts[]): { segments: AudienceSegment[]; excluded: number } {
  const seen = new Set<string>();
  const segments: AudienceSegment[] = [];
  let excluded = 0;
  for (const p of products) {
    const fromProduct = p.targetAudience ? clean(p.targetAudience, 120) : null;
    const candidates: AudienceSegment[] = [];
    if (fromProduct) candidates.push({ label: fromProduct, basis: 'PRODUCT_TARGET_AUDIENCE' });
    if (p.category?.name) candidates.push({ label: `Shoppers browsing ${clean(p.category.name, 60)}`, basis: 'PRODUCT_CATEGORY' });
    for (const c of candidates) {
      if (SENSITIVE.test(c.label) || detectInjection(c.label).length > 0) { excluded++; continue; }
      const k = c.label.toLowerCase();
      if (!seen.has(k)) { seen.add(k); segments.push(c); }
    }
  }
  if (segments.length === 0) segments.push({ label: 'Existing followers and customers of the merchant', basis: 'GENERAL' });
  return { segments: segments.slice(0, 6), excluded };
}

// ── 4. Creative Strategy ─────────────────────────────────────────────────────
export type Angle = 'BENEFIT' | 'FEATURE' | 'AVAILABILITY';
export interface ContentIdea { productId: string; angle: Angle; title: string; caption: string; hashtags: string[]; language: 'en' | 'fr' }

const PHRASES = {
  en: { benefit: (n: string, b: string) => `${n}: ${b}.`, feature: (n: string, f: string) => `Discover ${n}. ${f}.`, avail: (n: string, a: string) => `${n} is ${a}.`, price: (p: string) => ` Price: ${p}.`, cta: 'Message us to order.' },
  fr: { benefit: (n: string, b: string) => `${n} : ${b}.`, feature: (n: string, f: string) => `Découvrez ${n}. ${f}.`, avail: (n: string, a: string) => `${n} est ${a}.`, price: (p: string) => ` Prix : ${p}.`, cta: 'Écrivez-nous pour commander.' },
} as const;
const AVAIL: Record<'en' | 'fr', Record<string, string>> = { en: { IN_STOCK: 'available', OUT_OF_STOCK: 'currently out of stock', LIMITED: 'available in limited quantity', PREORDER: 'available to pre-order' }, fr: { IN_STOCK: 'disponible', OUT_OF_STOCK: 'actuellement en rupture de stock', LIMITED: 'disponible en quantité limitée', PREORDER: 'disponible en précommande' } };
const tag = (s: string) => `#${s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 3).map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join('')}`;

/** Two variants per product at most (benefit, feature) plus an availability note; only sentences built from verified fields. */
export function creativeStrategy(products: ProductFacts[], languages: Array<'en' | 'fr'>, maxIdeas: number): { ideas: ContentIdea[] } {
  const ideas: ContentIdea[] = [];
  for (const lang of languages) {
    const t = PHRASES[lang];
    for (const p of products) {
      const insight = productIntelligence([p]).insights[0]!;
      const price = money(p);
      const name = insight.name;
      const hashtags = [tag(name), p.category?.name ? tag(p.category.name) : null].filter(Boolean) as string[];
      const add = (angle: Angle, body: string) => ideas.push({ productId: p.id, angle, title: `${name} · ${angle.toLowerCase()}`.slice(0, 120), caption: `${body}${price ? t.price(price) : ''} ${t.cta}`.slice(0, 900), hashtags, language: lang });
      if (insight.problemsAddressed[0]) add('BENEFIT', t.benefit(name, insight.problemsAddressed[0]));
      const feature = list(p.features).find((f) => detectInjection(f).length === 0);
      if (feature) add('FEATURE', t.feature(name, feature));
      const av = p.availability ? AVAIL[lang][p.availability] : undefined;
      if (av && ideas.filter((i) => i.productId === p.id && i.language === lang).length === 0) add('AVAILABILITY', t.avail(name, av));
    }
  }
  return { ideas: ideas.slice(0, maxIdeas) };
}

// ── 5. Campaign Planning ─────────────────────────────────────────────────────
export interface PlanInput { ideas: ContentIdea[]; platforms: string[]; connectedPlatforms: string[]; startDate: string; days: number; entriesMax: number }
export interface CalendarProposal { index: number; platform: string; localDate: string; localTime: string; idea: ContentIdea; accountConnected: boolean; calendarEventId?: string }
export interface CampaignPlan {
  channels: Array<{ platform: string; reason: string; accountConnected: boolean }>;
  calendar: CalendarProposal[];
  costEstimate: { aiCostMicros: number; publishingCostMicros: number; adSpendMicros: 0; humanReviewMinutes: number; note: string };
}
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function campaignPlanning(i: PlanInput): CampaignPlan {
  const platforms = i.platforms.length ? i.platforms : ['FACEBOOK', 'INSTAGRAM'];
  const ideas = i.ideas.slice(0, Math.min(i.entriesMax, 10));
  const span = Math.max(1, Math.min(i.days, 30));
  const step = Math.max(1, Math.floor(span / Math.max(ideas.length, 1)));
  const calendar = ideas.map((idea, k) => {
    const platform = platforms[k % platforms.length]!;
    return { index: k, platform, localDate: addDays(i.startDate, 1 + k * step), localTime: '10:00', idea, accountConnected: i.connectedPlatforms.includes(platform) };
  });
  return {
    channels: platforms.map((p) => ({ platform: p, reason: 'Organic reach through the merchant\'s own account; no paid promotion.', accountConnected: i.connectedPlatforms.includes(p) })),
    calendar,
    costEstimate: { aiCostMicros: 0, publishingCostMicros: 0, adSpendMicros: 0, humanReviewMinutes: calendar.length * 2, note: 'Mock providers cost 0 USD. The review time is a planning estimate (about 2 minutes per post), not a measurement. No advertising spend is planned.' },
  };
}

// ── 6. Performance Analysis ──────────────────────────────────────────────────
export interface MetricRow { publicationId: string; productId: string | null; origin: 'REAL' | 'SIMULATED' | 'UNAVAILABLE'; engagementRate: number | null; reach: number | null; likes: number | null }
export interface PerformanceReport {
  counts: { real: number; simulated: number; unavailable: number };
  evidence: 'REAL' | 'SIMULATED_ONLY' | 'NONE';
  summary: string;
  best: { publicationId: string; engagementRate: number } | null;
  recommendations: string[];
  followUps: Array<{ basedOnPublicationId: string; productId: string; angle: Angle; basis: 'REAL' | 'SIMULATED' }>;
  caveat: string;
}
export function performanceAnalysis(rows: MetricRow[]): PerformanceReport {
  const counts = { real: rows.filter((r) => r.origin === 'REAL').length, simulated: rows.filter((r) => r.origin === 'SIMULATED').length, unavailable: rows.filter((r) => r.origin === 'UNAVAILABLE').length };
  const caveat = 'These figures describe engagement with the posts only. TOUMA has no evidence linking a post to sales, so no sales impact is claimed. Advertising spend is never changed automatically.';
  const evidence = counts.real > 0 ? 'REAL' : counts.simulated > 0 ? 'SIMULATED_ONLY' : 'NONE';
  const usable = rows.filter((r) => r.origin !== 'UNAVAILABLE' && r.engagementRate !== null);
  const pool = evidence === 'REAL' ? usable.filter((r) => r.origin === 'REAL') : usable;
  const top = [...pool].sort((a, b) => b.engagementRate! - a.engagementRate! || a.publicationId.localeCompare(b.publicationId))[0] ?? null;
  const recommendations: string[] = [];
  if (counts.unavailable > 0) recommendations.push(`${counts.unavailable} post(s) returned no metrics (permission or platform limit). Their performance is unknown, not zero.`);
  if (evidence === 'SIMULATED_ONLY') recommendations.push('Only simulated data exists: treat this as a test of the workflow, not as market feedback.');
  if (!top) recommendations.push('Not enough measured posts to compare. Wait for platform metrics before changing the plan.');
  if (top && pool.length < 3) recommendations.push('Fewer than 3 comparable posts: the ranking is indicative only.');
  const followUps = top && top.productId ? [{ basedOnPublicationId: top.publicationId, productId: top.productId, angle: 'BENEFIT' as Angle, basis: (top.origin === 'REAL' ? 'REAL' : 'SIMULATED') as 'REAL' | 'SIMULATED' }] : [];
  if (followUps.length) recommendations.push('A follow-up draft in the style of the best post can be prepared. It needs its own individual approval before any publication.');
  return {
    counts, evidence, caveat, recommendations, followUps,
    best: top ? { publicationId: top.publicationId, engagementRate: top.engagementRate! } : null,
    summary: evidence === 'NONE' ? 'No metrics available yet.' : `${counts.real} real, ${counts.simulated} simulated and ${counts.unavailable} unavailable measurement(s).`,
  };
}

// ── 7. Customer Service triage ───────────────────────────────────────────────
export type ReplyMode = 'AUTO' | 'MANUAL' | 'PAUSED';
export interface Triage { action: 'DRAFT_REPLY' | 'ESCALATE' | 'IGNORE'; reasons: string[]; /** True only in AUTO mode for a safe, grounded draft. The send itself is still checked again by the N19 reply service. */ autoSendAllowed: boolean }
const ESCALATE = /\b(refund|rembours\w*|lawyer|avocat|legal|lawsuit|plainte|complain\w*|scam|arnaque|fraud\w*|police|threat\w*|menace\w*|chargeback|allerg\w*|medical|m[ée]dic\w*|injur\w*|blessure|password|mot de passe|card number|num[ée]ro de carte|iban|urgent|furious|furieux)\b/i;
export function customerServiceTriage(i: { text: string; mode: ReplyMode; knowledgeMatches: number; isOwnComment: boolean }): Triage {
  const reasons: string[] = [];
  if (i.isOwnComment) return { action: 'IGNORE', reasons: ['own comment'], autoSendAllowed: false };
  if (i.mode === 'PAUSED') return { action: 'ESCALATE', reasons: ['customer service is paused: a person decides'], autoSendAllowed: false };
  const text = sanitizeUntrusted(i.text, 1000);
  if (detectInjection(text).length > 0) reasons.push('message looks like an instruction to the assistant');
  if (ESCALATE.test(text)) reasons.push('sensitive topic (refund, complaint, legal, health, payment or credentials)');
  if (i.knowledgeMatches === 0) reasons.push('no verified merchant knowledge covers this question');
  if (reasons.length) return { action: 'ESCALATE', reasons, autoSendAllowed: false };
  return { action: 'DRAFT_REPLY', reasons: ['covered by verified merchant knowledge'], autoSendAllowed: i.mode === 'AUTO' };
}
