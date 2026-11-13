/**
 * Deterministic helpers of the sales assistant (Phase N5): signal extraction in French, English, Arabic and Turkish,
 * rule-based lead qualification, the factual handoff summary and follow-up templates. Pure functions: no database, no
 * clock, no network and no model. Customer text is only pattern-matched: it is never executed, never sent to a model here,
 * and only short, bounded values are kept.
 */
export const QUALIFICATION_MODEL_VERSION = '1';

/** Points of each rule; they sum to 100. Documented in docs/SALES-ASSISTANT.md. */
export const RULE_POINTS = { buyCue: 30, productInterest: 20, budget: 15, contact: 15, quantity: 10, urgency: 10 } as const;
export type RuleKey = keyof typeof RULE_POINTS;

export interface AssistMessage {
  id: string;
  text: string;
}
export interface Signals {
  budget: { amount: string; currency: string | null; messageId: string } | null;
  quantity: { value: number; messageId: string } | null;
  urgency: { messageId: string } | null;
  buyCue: { messageId: string } | null;
  preferences: Array<{ text: string; messageId: string }>;
  interests: string[];
  hasContact: boolean;
}
export interface Reason {
  rule: RuleKey;
  points: number;
  evidence: string;
}
export type QualificationLevel = 'UNKNOWN' | 'COLD' | 'WARM' | 'HOT';
export interface Qualification {
  modelVersion: string;
  score: number;
  /** A summary of the rules that fired. It is not a prediction of a sale. */
  level: QualificationLevel;
  evaluatedMessages: number;
  signals: Signals;
  reasons: Reason[];
  notObserved: RuleKey[];
}

const ARABIC_DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

/** Lower case, accents and Arabic diacritics removed, Arabic digits converted, apostrophes unified. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] ?? d)
    .replace(/[’‘`´]/g, "'")
    .replace(/İ/g, 'i')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A message that contains a card-like number is skipped entirely: nothing of it is extracted or stored. */
const CARD_LIKE = /(?:\d[ -]?){13,19}/;

const BUDGET_WORD = /(budget|maximum|\bmax\b|up to|under|at most|no more than|jusqu'?a|pas plus de|au maximum|butce|en fazla|ميزاني|بحد اقصي|بحد اقصى|اقصي|اقصى|الحد الاقصي|الحد الاقصى)/g;
const AMOUNT = /(\d{1,3}(?:[ .,\u00a0\u202f]\d{3})+|\d+)(?:[.,]\d{1,2})?\s*(xaf|f ?cfa|cfa|euros?|eur|€|usd|\$|dollars?|gbp|£|try|tl|₺|mad|dh|aed|sar|دولار|يورو|ليره|ليرة|درهم|ريال)?/g;
const CURRENCY: Record<string, string | null> = { xaf: 'XAF', fcfa: 'XAF', 'f cfa': 'XAF', cfa: 'XAF', euro: 'EUR', euros: 'EUR', eur: 'EUR', '€': 'EUR', usd: 'USD', $: 'USD', dollar: 'USD', dollars: 'USD', gbp: 'GBP', '£': 'GBP', try: 'TRY', tl: 'TRY', '₺': 'TRY', mad: 'MAD', dh: 'MAD', aed: 'AED', sar: 'SAR', دولار: 'USD', يورو: 'EUR', ليره: 'TRY', ليرة: 'TRY', درهم: null, ريال: null };

function parseAmount(raw: string): string | null {
  const digits = /^\d{1,3}(?:[ .,\u00a0\u202f]\d{3})+$/.test(raw) ? raw.replace(/\D/g, '') : raw.replace(/\D/g, '');
  if (!digits || digits.length > 10) return null;
  const n = Number(digits);
  return n >= 1 && n <= 1_000_000_000 ? String(n) : null;
}

function extractBudget(t: string): { amount: string; currency: string | null } | null {
  for (const w of t.matchAll(BUDGET_WORD)) {
    const from = Math.max(0, (w.index ?? 0) - 30);
    const window = t.slice(from, (w.index ?? 0) + w[0].length + 40);
    const wordAt = (w.index ?? 0) - from;
    const found = [...window.matchAll(AMOUNT)].filter((m) => parseAmount(m[1]!) !== null);
    if (!found.length) continue;
    // An amount with a currency beats one without (a quantity such as "3 bottles" is not a budget), then one placed after the
    // budget word beats one before it, then the closest wins.
    const rank = (m: RegExpMatchArray) => (m[2] ? 0 : 2) + ((m.index ?? 0) > wordAt ? 0 : 1);
    found.sort((a, b) => rank(a) - rank(b) || Math.abs((a.index ?? 0) - wordAt) - Math.abs((b.index ?? 0) - wordAt));
    const m = found[0]!;
    return { amount: parseAmount(m[1]!)!, currency: m[2] ? (CURRENCY[m[2].replace(/\s+/g, ' ')] ?? null) : null };
  }
  return null;
}

const QUANTITY_A = /(?:i (?:want|need|would like|'ll take|will take)|je (?:veux|voudrais|prends|souhaite)|il me faut|besoin de|istiyorum|lazim|اريد|ابغي|احتاج)\s+(?:about |environ |yaklasik )?(\d{1,3})\b/;
const QUANTITY_B = /\b(\d{1,3})\s*(?:x\b|pcs\b|pieces?\b|units?\b|bottles?\b|bouteilles?\b|unites?\b|adet\b|sise\b)/;
const QUANTITY_AR = /(\d{1,3})\s*(?:قطع|حبه|حبة|علبه|علبة)/;
const URGENCY = /(\b(?:today|tomorrow|asap|urgent(?:ly)?|right now|this week|aujourd'?hui|demain|cette semaine|des que possible|bugun|yarin|acil|hemen|bu hafta)\b|اليوم|غدا|بكره|بكرة|عاجل|حالا|هذا الاسبوع)/;
const BUY_CUE = /(\bi(?:'ll| will)? (?:take|buy)\b|\bi want to (?:buy|order)\b|\bi(?:'d| would) like to (?:buy|order)\b|\bhow (?:do i|can i|to) (?:pay|order)\b|\bready to (?:buy|order)\b|\bplace an order\b|\bje (?:le |la |les )?prends\b|\bje (?:veux|voudrais|souhaite) (?:acheter|commander)\b|\bcomment (?:payer|commander)\b|\bpasser (?:une )?commande\b|\bsatin almak\b|\bsiparis (?:vermek|etmek)\b|\balacagim\b|\bnasil (?:odeme|siparis)\b|اريد ان اشتري|اريد شراء|اريد طلب|كيف (?:ادفع|اطلب)|ساشتري|سوف اشتري)/;
const PREFERENCE = /(?:\bi prefer\b|\bi like\b|\bje prefere\b|\bj'aime\b|\btercih ederim\b|\bseverim\b|افضل|احب)\s+(.{3,80}?)(?:[.!?\n]|$)/;

const looksPersonal = (s: string) => /@|\d{6,}/.test(s);

/**
 * Extracts what the customer volunteered, from customer messages only. Each value remembers the message it came from.
 * Messages with a card-like number are skipped whole.
 */
export function extractSignals(messages: AssistMessage[], interests: string[], hasContact: boolean): Signals {
  const s: Signals = { budget: null, quantity: null, urgency: null, buyCue: null, preferences: [], interests: [...new Set(interests)].slice(0, 10), hasContact };
  for (const m of messages) {
    if (CARD_LIKE.test(m.text)) continue;
    const t = normalizeText(m.text);
    if (!t) continue;
    if (!s.budget) {
      const b = extractBudget(t);
      if (b) s.budget = { ...b, messageId: m.id };
    }
    if (!s.quantity) {
      const q = QUANTITY_A.exec(t) ?? QUANTITY_B.exec(t) ?? QUANTITY_AR.exec(t);
      const v = q ? Number(q[1]) : 0;
      if (v >= 1 && v <= 999) s.quantity = { value: v, messageId: m.id };
    }
    if (!s.urgency && URGENCY.test(t)) s.urgency = { messageId: m.id };
    if (!s.buyCue && BUY_CUE.test(t)) s.buyCue = { messageId: m.id };
    if (s.preferences.length < 3) {
      const p = PREFERENCE.exec(t);
      const text = p?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (text && !looksPersonal(text) && !s.preferences.some((x) => x.text === text)) s.preferences.push({ text, messageId: m.id });
    }
  }
  return s;
}

/** Scores the signals with fixed rules. Every point has a named reason and its evidence. */
export function qualify(messages: AssistMessage[], interests: string[], hasContact: boolean): Qualification {
  const signals = extractSignals(messages, interests, hasContact);
  const fired: Array<[RuleKey, boolean, string]> = [
    ['buyCue', signals.buyCue !== null, signals.buyCue ? `buying phrase in message ${signals.buyCue.messageId}` : ''],
    ['productInterest', signals.interests.length > 0, `${signals.interests.length} catalog item(s) discussed`],
    ['budget', signals.budget !== null, signals.budget ? `budget ${signals.budget.amount}${signals.budget.currency ? ` ${signals.budget.currency}` : ''} volunteered in message ${signals.budget.messageId}` : ''],
    ['contact', signals.hasContact, 'contact details given with consent'],
    ['quantity', signals.quantity !== null, signals.quantity ? `quantity ${signals.quantity.value} in message ${signals.quantity.messageId}` : ''],
    ['urgency', signals.urgency !== null, signals.urgency ? `timing mentioned in message ${signals.urgency.messageId}` : ''],
  ];
  const reasons: Reason[] = fired.filter(([, on]) => on).map(([rule, , evidence]) => ({ rule, points: RULE_POINTS[rule], evidence }));
  const score = reasons.reduce((n, r) => n + r.points, 0);
  const level: QualificationLevel = messages.length === 0 ? 'UNKNOWN' : score >= 70 ? 'HOT' : score >= 40 ? 'WARM' : 'COLD';
  return { modelVersion: QUALIFICATION_MODEL_VERSION, score, level, evaluatedMessages: messages.length, signals, reasons, notObserved: fired.filter(([, on]) => !on).map(([rule]) => rule) };
}

// ─── Handoff summary (facts only) ─────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export interface HandoffSummary {
  language: string | null;
  reason: string;
  customerMessages: number;
  aiReplies: number;
  intent: string | null;
  purchaseIntent: string | null;
  products: Array<{ id: string; name: string }>;
  qualification: { level: QualificationLevel; score: number; budget: Signals['budget']; quantity: number | null; urgent: boolean; preferences: string[] } | null;
  lastCustomerMessages: Array<{ at: string; text: string }>;
}

/** The summary is compiled from stored data only (counts, catalog names, extracted signals, the last customer words): no model wrote it. */
export function buildHandoffSummary(i: {
  language: string | null;
  reason: string;
  customerMessages: Array<{ at: Date; text: string }>;
  aiReplies: number;
  intent: string | null;
  purchaseIntent: string | null;
  products: Array<{ id: string; name: string }>;
  qualification: Qualification | null;
}): HandoffSummary {
  const q = i.qualification;
  return {
    language: i.language,
    reason: i.reason,
    customerMessages: i.customerMessages.length,
    aiReplies: i.aiReplies,
    intent: i.intent,
    purchaseIntent: i.purchaseIntent,
    products: i.products.slice(0, 5),
    qualification: q ? { level: q.level, score: q.score, budget: q.signals.budget, quantity: q.signals.quantity?.value ?? null, urgent: q.signals.urgency !== null, preferences: q.signals.preferences.map((p) => p.text) } : null,
    lastCustomerMessages: i.customerMessages.slice(-3).map((m) => ({ at: m.at.toISOString(), text: clean(m.text, 200) })),
  };
}

// ─── Follow-up drafts ─────────────────────────────────────────────────────────────

const safeName = (n: string | null) => (n && /^[\p{L}\p{M}' -]{1,40}$/u.test(n.trim()) ? n.trim() : null);

/**
 * A follow-up draft built from a template and verified catalog names. It states no price, no discount and no promise:
 * it only invites the customer to continue the conversation. It is never sent by TOUMA in this phase.
 */
export function followUpText(language: string, name: string | null, products: string[]): string {
  const who = safeName(name);
  const list = products.slice(0, 3).join(', ');
  switch (language) {
    case 'fr':
      return `Bonjour${who ? ` ${who}` : ''}, merci pour votre intérêt${list ? ` pour : ${list}` : ''}. Souhaitez-vous que nous vous aidions à poursuivre ? Répondez ici et un membre de l'équipe vous accompagnera.`;
    case 'ar':
      return `مرحباً${who ? ` ${who}` : ''}، شكراً لاهتمامك${list ? ` بـ: ${list}` : ''}. هل تودّ أن نساعدك في المتابعة؟ يمكنك الرد هنا وسيساعدك أحد أفراد الفريق.`;
    case 'tr':
      return `Merhaba${who ? ` ${who}` : ''}, ilginiz için teşekkürler${list ? `: ${list}` : ''}. Devam etmeniz için yardımcı olalım mı? Buradan yanıt verin, ekibimizden biri size yardımcı olacaktır.`;
    default:
      return `Hello${who ? ` ${who}` : ''}, thank you for your interest${list ? ` in: ${list}` : ''}. Would you like us to help you continue? Reply here and a member of the team will assist you.`;
  }
}
