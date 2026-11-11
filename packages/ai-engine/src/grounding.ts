import { type BusinessContext, validSources } from './context';
import { collectStrings } from './safety';

/**
 * Anti-fabrication checks. Every verifiable statement in a generated text is matched against the
 * business's verified data, by TYPE: an amount must be a real price (or appear as money in the
 * business's own text), a percentage must appear as a percentage or be an exact discount derived from
 * two real prices, a phone number must be the business's phone, a currency must be the business's
 * currency, and so on. A bare digit string elsewhere in the data (a SKU, a year, a phone number) no
 * longer makes an invented price look verified.
 *
 * This is rule-based: it catches the common, checkable kinds of invention. It cannot prove that every
 * sentence is true, which is why AI content also needs human approval before publication.
 */

export interface QualityReport {
  passed: boolean;
  /** The families of checks that were applied. */
  checks: string[];
  issues: string[];
  /** Facts in the text that were matched to the verified business data. */
  verified: { amounts: string[]; percentages: string[]; urls: string[]; contacts: string[]; sources: string[] };
  checkedAt: string;
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

const CURRENCY = String.raw`(?:XAF|XOF|FCFA|CFA|F\s?CFA|USD|EUR|GBP|TRY|MAD|AED|SAR|CAD|CHF|NGN|DH|TL|€|\$|£|₺|₦)`;
// Thousands groups of exactly three digits ('1 500', '1,500', '1.500') and up to two decimals; "1500, 1500" is two numbers.
const AMOUNT = String.raw`\d{1,3}(?:[ .,\u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
/** groups: 1 currency, 2 amount (currency first) | 3 amount, 4 currency (amount first) */
const MONEY_RE = new RegExp(String.raw`(?:(${CURRENCY})\s?(${AMOUNT}))|(?:(${AMOUNT})\s?(${CURRENCY}))`, 'giu');
const PERCENT_RE = /(\d+(?:[.,]\d+)?)\s?%/g;
const URL_RE = /https?:\/\/[^\s"'<>)]+/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const HANDLE_RE = /(?<![\w@./])@([A-Za-z0-9_.]{3,30})\b/g;
const PHONE_RE = /(?<![\w.])\+?\d[\d\s().-]{6,}\d(?![\w])/g;
const YEAR_RE = /(?<![\d.,/-])(?:19|20)\d{2}(?![\d/-])/g;
const DATE_RE = /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g;
/** Physical measures: ingredients, dimensions, weights, capacities, power. Must match the data exactly. */
const MEASURE_RE = /(\d+(?:[.,]\d+)?)\s?(kg|g|mg|ml|cl|dl|l|cm|mm|m|km|oz|lbs?|gb|tb|mb|mah|kwh|w|v|hz)\b/gi;
/** Durations and periods: delivery times, opening periods, experience. */
const TIME_RE = /(\d+(?:[.,]\d+)?)\s?(minutes?|mins?|hours?|hrs?|heures?|jours?|days?|dakika|saat|gün|ans|years?|yıl|semaines?|weeks?|mois|months?)\b/gi;
/** Audience/social-proof numbers: "10,000 customers", "5000 clients". */
const COUNT_RE = /(\d[\d.,  ]*)\s?\+?\s?(?:happy |satisfied |loyal |heureux |satisfaits )?(customers|clients|orders|users|followers|reviews|avis|members|sold|vendus|müşteri|sipariş|عميل|طلب)/gi;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ARABIC_DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
const ascii = (s: string) => s.replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] ?? d);
const digits = (v: string) => ascii(v).replace(/\D/g, '').replace(/^0+(?=\d)/, '');
const dropZeroDecimals = (v: string) => ascii(v).replace(/[.,]\s?00?\s*$/, '');
const num = (v: string) => Number(ascii(v).replace(/\s/g, '').replace(',', '.'));

/** Normal form of an amount: "1 500", "1,500", "1500.00" → "1500". */
function amountKey(raw: string): string {
  return digits(dropZeroDecimals(raw.trim()));
}

/** Currency tokens → ISO-ish codes. CFA francs are interchangeable (XAF/XOF share the notation FCFA). */
function currencyCode(token: string): string {
  const t = token.replace(/\s/g, '').toUpperCase();
  if (t === 'FCFA' || t === 'CFA' || t === 'FCFA') return 'CFA';
  if (t === '€') return 'EUR';
  if (t === '$') return 'USD';
  if (t === '£') return 'GBP';
  if (t === '₺' || t === 'TL') return 'TRY';
  if (t === '₦') return 'NGN';
  if (t === 'DH') return 'MAD';
  if (t === 'XAF' || t === 'XOF') return 'CFA';
  return t;
}

const UNIT_GROUP: Record<string, string> = {
  min: 'minute', mins: 'minute', minute: 'minute', minutes: 'minute', dakika: 'minute',
  hr: 'hour', hrs: 'hour', hour: 'hour', hours: 'hour', heure: 'hour', heures: 'hour', saat: 'hour',
  day: 'day', days: 'day', jour: 'day', jours: 'day', gün: 'day',
  week: 'week', weeks: 'week', semaine: 'week', semaines: 'week',
  month: 'month', months: 'month', mois: 'month',
  year: 'year', years: 'year', an: 'year', ans: 'year', yıl: 'year',
};
const norm = (v: string) => String(num(v));

type Row = Record<string, unknown>;

export interface Facts {
  /** Real prices (structured fields) and money written in the business's own text. */
  amounts: Set<string>;
  /** Prices of each item, to detect another item's price being attributed to the focus item. */
  priceOwners: Map<string, string[]>;
  percentages: Set<string>;
  measures: Set<string>;
  /** '3hour', '180minute', '24hour': durations written in the data or derived from structured durations. */
  durations: Set<string>;
  /** Audience and sales figures written in the data ('10000' next to 'customers'). */
  counts: Set<string>;
  numbers: Set<string>;
  years: Set<string>;
  dates: Set<string>;
  phones: string[];
  emails: Set<string>;
  handles: Set<string>;
  urls: string[];
  currencies: Set<string>;
  text: string;
}

function numberVariants(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of ascii(text).matchAll(/\d[\d\s.,  ]*\d|\d/g)) {
    out.add(digits(m[0]));
    out.add(digits(dropZeroDecimals(m[0])));
  }
  return out;
}

export function buildFacts(ctx: BusinessContext): Facts {
  const items: Row[] = [...(ctx.products as Row[]), ...(ctx.services as Row[])];
  const textOnly = collectStrings({ business: ctx.business, products: ctx.products.map(stripPrices), services: ctx.services.map(stripPrices), knowledge: ctx.knowledge });
  const text = ascii(textOnly.join('\n'));
  const allText = ascii(JSON.stringify({ business: ctx.business, products: ctx.products, services: ctx.services, knowledge: ctx.knowledge }));

  const amounts = new Set<string>();
  const priceOwners = new Map<string, string[]>();
  const currencies = new Set<string>();
  const add = (v: unknown, owner: string) => {
    if (typeof v !== 'string' && typeof v !== 'number') return;
    const k = amountKey(String(v));
    if (!k) return;
    amounts.add(k);
    priceOwners.set(k, [...(priceOwners.get(k) ?? []), owner]);
  };
  for (const it of items) {
    add(it.price, String(it.id));
    add(it.discountPrice, String(it.id));
    if (typeof it.currency === 'string') currencies.add(currencyCode(it.currency));
  }
  if (ctx.business.currency) currencies.add(currencyCode(ctx.business.currency));
  for (const m of text.matchAll(MONEY_RE)) {
    amounts.add(amountKey(m[2] ?? m[3] ?? ''));
    if (m[1] || m[4]) currencies.add(currencyCode(m[1] ?? m[4] ?? ''));
  }

  const percentages = new Set<string>();
  for (const m of text.matchAll(PERCENT_RE)) percentages.add(digits(dropZeroDecimals(m[1]!)));
  // A real discount is two real prices: derive its exact percentage (1500 → 1200 is 20%).
  for (const it of items) {
    const p = num(String(it.price ?? ''));
    const d = num(String(it.discountPrice ?? ''));
    if (p > 0 && d > 0 && d < p) {
      const pct = (1 - d / p) * 100;
      percentages.add(String(Math.round(pct)));
      percentages.add(digits(pct.toFixed(1)));
    }
  }

  const measures = new Set<string>();
  for (const m of text.matchAll(MEASURE_RE)) measures.add(`${digits(dropZeroDecimals(m[1]!))}${m[2]!.toLowerCase()}`);
  const numbers = numberVariants(allText);
  const durations = new Set<string>();
  for (const m of text.matchAll(TIME_RE)) durations.add(`${norm(m[1]!)}${UNIT_GROUP[m[2]!.toLowerCase()] ?? m[2]!.toLowerCase()}`);
  for (const it of items) {
    // Durations are structured data: 180 minutes may also be written "3 hours".
    const mins = Number(it.durationMinutes);
    if (Number.isFinite(mins) && mins > 0) {
      durations.add(`${mins}minute`);
      if (mins % 30 === 0) durations.add(`${mins / 60}hour`);
    }
  }
  const counts = new Set([...text.matchAll(COUNT_RE)].map((m) => digits(m[1]!)));

  const years = new Set([...allText.matchAll(YEAR_RE)].map((m) => m[0]));
  const dates = new Set([...allText.matchAll(DATE_RE)].map((m) => m[0]));
  const phones = [...allText.replace(MONEY_RE, ' ').matchAll(PHONE_RE)].map((m) => digits(m[0])).filter((d) => d.length >= 8 && d.length <= 15);
  const emails = new Set([...allText.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()));
  const handles = new Set([...allText.matchAll(HANDLE_RE)].map((m) => m[1]!.toLowerCase()));
  const urls = [...allText.matchAll(URL_RE)].map((m) => m[0].toLowerCase().replace(/[.,;:!?\\]+$/, ''));
  return { amounts, priceOwners, percentages, measures, durations, counts, numbers, years, dates, phones, emails, handles, urls, currencies, text: allText };
}

function stripPrices(row: Row): Row {
  const { price: _p, discountPrice: _d, stock: _s, ...rest } = row;
  return rest;
}

// ─── Claim families ───────────────────────────────────────────────────────────
// A claim is allowed only when the business data itself mentions the concept.

const CLAIMS: Array<{ name: string; output: RegExp; evidence: RegExp }> = [
  { name: 'free delivery', output: /free (delivery|shipping)|livraison (gratuite|offerte)|ücretsiz (kargo|teslimat)|(توصيل|شحن) مجاني/i, evidence: /free (delivery|shipping)|livraison (gratuite|offerte)|ücretsiz (kargo|teslimat)|(توصيل|شحن) مجاني|gratuit|free|ücretsiz|مجان/i },
  { name: 'guarantee', output: /guarantee|warranty|garantie|garanti|ضمان|risk[- ]free|sans risque|zero risk/i, evidence: /guarantee|warranty|garantie|garanti|ضمان|risk[- ]free|sans risque/i },
  { name: 'refund', output: /money[- ]back|refund|rembours|para iade|استرداد/i, evidence: /money[- ]back|refund|rembours|iade|return|retour|استرداد|إرجاع/i },
  { name: 'certification', output: /certified|certifi[ée]|sertifika|معتمد|organic|biologique|\bbio\b|organik|عضوي|halal|vegan|gluten[- ]free|sans gluten|fair[- ]trade|iso ?\d{3,5}/i, evidence: /certif|sertifika|معتمد|organic|biologique|\bbio\b|organik|عضوي|halal|vegan|gluten|fair[- ]trade|iso ?\d{3,5}/i },
  { name: 'ranking', output: /\b(number one|#1|n°\s?1|no\.\s?1|best in (town|the city|the country)|meilleur(e)? de|le meilleur|la meilleure|en iyi|top[- ]rated|unbeatable|imbattable)\b|الأفضل/i, evidence: /award|prix|ödül|جائزة|number one|#1|n°\s?1|best|meilleur|en iyi|الأفضل|top[- ]rated|unbeatable|imbattable/i },
  { name: 'award', output: /award[- ]winning|prize[- ]winning|primé|ödüllü|حائز|winner of/i, evidence: /award|prix|primé|ödül|جائزة|حائز|winner/i },
  { name: 'delivery time', output: /same[- ]day|next[- ]day|express (delivery|shipping)|livraison (express|rapide|en \d+)|fast (delivery|shipping)|ships? (today|tomorrow)|(aynı|ertesi) gün|hızlı (teslimat|kargo)|توصيل سريع/i, evidence: /same[- ]day|next[- ]day|express|rapide|fast|ships?|aynı gün|hızlı|سريع|within \d|\d+ ?(hours?|days?|jours?|heures?|saat|gün)/i },
  { name: 'social proof', output: /customers? (say|love|rave|trust)|trusted by|testimonials?|clients? (disent|adorent|nous font confiance)|ils nous font confiance|müşterilerimiz|5[- ]stars?|five[- ]stars?|[⭐★]{2,}|\b\d(\.\d)?\s?\/\s?5\b|rated \d|note de \d|عملاؤنا/i, evidence: /testimonial|review|avis|rated|rating|stars?|étoiles|yıldız|trusted|confiance|müşteri yorum|تقييم/i },
  { name: 'popularity', output: /best[- ]?sell(er|ing)|most popular|meilleure? vente|le plus populaire|çok satan|en popüler|الأكثر مبيع|sold out|épuisé|tükendi/i, evidence: /best[- ]?sell|popular|meilleure? vente|populaire|çok satan|popüler|مبيع|sold out|épuisé|tükendi/i },
  { name: 'medical claim', output: /\b(cures?|heals?|treats|prevents|guérit|soigne|prévient|iyileştirir|tedavi eder|detox|burns? fat|lose weight|perdre du poids|clinically proven|cliniquement prouvé|dermatolog\w* tested|testé dermatolog\w*|no side effects|sans effets secondaires|safe for (children|kids|babies)|approved by doctors)\b|يعالج|يشفي/i, evidence: /\b(cure|heal|treat|prevent|guéri|soign|prévi|iyileş|tedavi|detox|fat|weight|poids|clinical|clinique|dermatolog|side effect|effets|safe for|doctors?)\b|يعالج|يشفي/i },
  { name: 'time-limited offer', output: /limited[- ]time|today only|ends (today|tonight|soon|sunday|this)|this (weekend|week) only|offre limitée|dernier jour|jusqu'?au \d|valid until|until \d|sınırlı süre|bugüne özel|لفترة محدودة|اليوم فقط/i, evidence: /limited[- ]time|today only|ends|offre limitée|dernier jour|jusqu'?au|valid until|until|sınırlı süre|bugün|لفترة محدودة|اليوم فقط/i },
  { name: 'comparison', output: /cheaper than|better than|moins cher que|meilleur que|plus (rapide|efficace) que|daha (ucuz|iyi) من|unlike (other|competitors|most)|à la différence des autres|contrairement aux autres|أفضل من|أرخص من/i, evidence: /cheaper than|better than|moins cher que|meilleur que|unlike|contrairement|أفضل من|أرخص من/i },
];

const SCARCITY_RE = /(?:only|just)\s+(\d+)\s+(?:left|remaining|in stock|available)|plus que (\d+)|il (?:ne )?reste (?:que )?(\d+)|son (\d+) (?:adet|ürün)|last (?:few|pieces?|items?|chance)|dernières? pièces?|stock limité|limited (?:stock|quantity|supply|edition)|while supplies last|sınırlı stok|كمية محدودة/i;
const SCARCITY_EVIDENCE_RE = /limited|stock limité|dernières? pièces?|sınırlı|محدودة|while supplies last/i;

/** Statements that something can be bought/served now. Contradicting an item's recorded availability is a fabrication. */
const AVAILABLE_NOW_RE = /\b(in stock|available now|available today|order now|buy now|ready to ship|ships? (today|now)|en stock|disponible (maintenant|dès maintenant|immédiatement)|commandez maintenant|achetez maintenant|stokta|şimdi sipariş|متوفر الآن|اطلب الآن)\b/i;
const UNAVAILABLE_STATES = /^(OUT_OF_STOCK|DISCONTINUED|UNAVAILABLE)$/;
const NOT_READY_STATES = /^(PREORDER|MADE_TO_ORDER)$/;

// ─── Assessment ───────────────────────────────────────────────────────────────

export function assessGrounding(output: unknown, ctx: BusinessContext): QualityReport {
  const issues: string[] = [];
  const verified = { amounts: new Set<string>(), percentages: new Set<string>(), urls: new Set<string>(), contacts: new Set<string>(), sources: new Set<string>() };
  const f = buildFacts(ctx);
  const text = ascii(collectStrings(stripSourceFields(output)).join('\n'));

  // Amounts and their currency.
  for (const m of text.matchAll(MONEY_RE)) {
    const raw = (m[2] ?? m[3] ?? '').trim();
    const key = amountKey(raw);
    const shown = m[0].trim();
    if (key && !f.amounts.has(key)) issues.push(`Unsupported price or amount "${shown}": not present in the business data`);
    else if (key) verified.amounts.add(shown);
    const cur = m[1] ?? m[4];
    if (cur && f.currencies.size > 0 && !f.currencies.has(currencyCode(cur))) {
      issues.push(`Currency "${cur.trim()}" in "${shown}" differs from the verified currency (${[...f.currencies].join(', ')})`);
    }
  }
  let rest = text.replace(MONEY_RE, ' ');

  // Percentages: written in the data, or the exact discount between two real prices.
  for (const m of rest.matchAll(PERCENT_RE)) {
    if (!f.percentages.has(digits(dropZeroDecimals(m[1]!)))) issues.push(`Unsupported percentage "${m[0]}": not present in the business data and not the discount between two real prices`);
    else verified.percentages.add(m[0]);
  }
  rest = rest.replace(PERCENT_RE, ' ');

  // Contacts and links.
  for (const m of rest.matchAll(URL_RE)) {
    const u = m[0].toLowerCase().replace(/[.,;:!?\\]+$/, '');
    if (f.urls.some((x) => x === u || x.startsWith(u) || u.startsWith(x))) verified.urls.add(m[0]);
    else issues.push(`URL not present in the business data: ${m[0]}`);
  }
  rest = rest.replace(URL_RE, ' ');
  for (const m of rest.matchAll(EMAIL_RE)) {
    if (f.emails.has(m[0].toLowerCase())) verified.contacts.add(m[0]);
    else issues.push(`Email address not present in the business data: ${m[0]}`);
  }
  rest = rest.replace(EMAIL_RE, ' ');
  for (const m of rest.matchAll(HANDLE_RE)) {
    if (f.handles.has(m[1]!.toLowerCase())) verified.contacts.add(m[0]);
    else issues.push(`Social handle not present in the business data: ${m[0]}`);
  }
  rest = rest.replace(HANDLE_RE, ' ');
  for (const m of rest.matchAll(DATE_RE)) {
    if (f.dates.has(m[0])) verified.contacts.add(m[0]);
    else issues.push(`Date "${m[0]}" is not present in the business data`);
  }
  rest = rest.replace(DATE_RE, ' ');
  for (const m of rest.matchAll(PHONE_RE)) {
    const d = digits(m[0]);
    if (d.length < 8 || d.length > 15) continue;
    if (f.phones.some((p) => p.endsWith(d.slice(-8)) || d.endsWith(p.slice(-8)))) verified.contacts.add(m[0].trim());
    else issues.push(`Phone number not present in the business data: ${m[0].trim()}`);
  }
  rest = rest.replace(PHONE_RE, ' ');

  // Specifications, durations, history and audience size.
  for (const m of text.matchAll(MEASURE_RE)) {
    const key = `${digits(dropZeroDecimals(m[1]!))}${m[2]!.toLowerCase()}`;
    if (!f.measures.has(key)) issues.push(`Specification "${m[0].trim()}" is not present in the business data`);
  }
  for (const m of text.matchAll(TIME_RE)) {
    const key = `${norm(m[1]!)}${UNIT_GROUP[m[2]!.toLowerCase()] ?? m[2]!.toLowerCase()}`;
    if (!f.durations.has(key)) issues.push(`Duration or period "${m[0].trim()}" is not present in the business data`);
  }
  for (const m of rest.matchAll(YEAR_RE)) if (!f.years.has(m[0])) issues.push(`Year "${m[0]}" is not present in the business data`);
  for (const m of text.matchAll(COUNT_RE)) {
    const n = digits(m[1]!);
    if (n.length >= 2 && !f.counts.has(n)) issues.push(`Audience or sales figure "${m[0].trim()}" is not present in the business data`);
  }

  // Claims: the data must mention the concept.
  for (const c of CLAIMS) if (c.output.test(text) && !c.evidence.test(f.text)) issues.push(`Unsupported claim (${c.name}): the business data does not mention it`);
  const scarcity = SCARCITY_RE.exec(text);
  if (scarcity) {
    const stated = scarcity.slice(1).find((x) => x !== undefined);
    const stocks = new Set([...(ctx.products as Row[]).map((p) => p.stock).filter((s): s is number => typeof s === 'number').map(String)]);
    const backed = (stated !== undefined && stocks.has(stated)) || (stated === undefined && SCARCITY_EVIDENCE_RE.test(f.text));
    if (!backed) issues.push('Unsupported claim (scarcity): the business data does not record limited stock');
  }

  // Sources and leaks.
  const sources = validSources(ctx);
  for (const src of collectSources(output)) {
    if (!sources.has(src)) issues.push(`Unknown source "${src}": cite only ids present in the business data`);
    else verified.sources.add(src);
  }
  if (/<\/?business_data>|NON-NEGOTIABLE RULES|sk-[A-Za-z0-9]{16,}/.test(text)) issues.push('Output leaks internal instructions or secrets');

  const unique = [...new Set(issues)];
  return {
    passed: unique.length === 0,
    checks: ['amounts', 'currency', 'percentages', 'contacts', 'dates', 'specifications', 'durations', 'years', 'audience figures', 'claims', 'scarcity', 'sources'],
    issues: unique,
    verified: Object.fromEntries(Object.entries(verified).map(([k, v]) => [k, [...v].slice(0, 30)])) as QualityReport['verified'],
    checkedAt: new Date().toISOString(),
  };
}

export function checkGrounding(output: unknown, ctx: BusinessContext): string[] {
  return assessGrounding(output, ctx).issues;
}

/**
 * Facts about the ITEM the content is about must stay as recorded: another item's price must not be
 * attributed to it, and its availability must not be contradicted ("in stock" for an out-of-stock item).
 */
export function checkFactPreservation(output: unknown, ctx: BusinessContext, item: { type: 'PRODUCT' | 'SERVICE'; id: string } | null): string[] {
  if (!item) return [];
  const rows = (item.type === 'PRODUCT' ? ctx.products : ctx.services) as Row[];
  const row = rows.find((r) => r.id === item.id);
  if (!row) return [];
  const issues: string[] = [];
  const text = ascii(collectStrings(stripSourceFields(output)).join('\n'));
  const f = buildFacts(ctx);
  const own = new Set([row.price, row.discountPrice].filter((v) => v !== null && v !== undefined).map((v) => amountKey(String(v))));

  for (const m of text.matchAll(MONEY_RE)) {
    const key = amountKey(m[2] ?? m[3] ?? '');
    const owners = f.priceOwners.get(key);
    // The amount is a real price, but of a different item and nowhere else in the data: it was attributed to the wrong item.
    const inText = [...f.text.matchAll(MONEY_RE)].some((x) => amountKey(x[2] ?? x[3] ?? '') === key);
    if (key && owners && !own.has(key) && !owners.includes(String(row.id)) && !inText) {
      issues.push(`Price "${m[0].trim()}" belongs to another item, not to "${String(row.name)}"`);
    }
  }
  const availability = String(row.availability ?? '');
  const stock = row.stock;
  if (AVAILABLE_NOW_RE.test(text)) {
    if (UNAVAILABLE_STATES.test(availability) || stock === 0) issues.push(`"${String(row.name)}" is recorded as ${stock === 0 && !UNAVAILABLE_STATES.test(availability) ? 'out of stock' : availability.toLowerCase().replace(/_/g, ' ')}, but the text says it is available now`);
    else if (NOT_READY_STATES.test(availability)) issues.push(`"${String(row.name)}" is recorded as ${availability.toLowerCase().replace(/_/g, ' ')}, but the text says it is available now`);
  }
  return issues;
}

// ─── Source ids ───────────────────────────────────────────────────────────────

const SOURCE_KEYS = new Set(['source', 'relatedSources']);

function stripSourceFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSourceFields);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !SOURCE_KEYS.has(k)).map(([k, v]) => [k, stripSourceFields(v)]));
  }
  return value;
}

function collectSources(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collectSources(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'source' && typeof v === 'string') out.push(v);
      else if (k === 'relatedSources' && Array.isArray(v)) v.forEach((x) => typeof x === 'string' && out.push(x));
      else collectSources(v, out);
    }
  }
  return out;
}
