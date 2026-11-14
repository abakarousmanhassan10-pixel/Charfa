import { sanitizeUntrusted } from '@touma/ai-engine';

/**
 * Phase N22 customer intelligence. It reads inbound customer questions and returns ONLY aggregate counts: no text, no author,
 * no identifier. A theme asked fewer than K times is suppressed (counted, never shown), so a rare question cannot point to a person.
 */
export const K_ANONYMITY = 3;

const TOPICS: Record<string, { ask: RegExp; knowledge?: RegExp }> = {
  PRICE: { ask: /\b(price|prix|cost|combien|how much|tarif)\b/i },
  AVAILABILITY: { ask: /\b(available|in stock|stock|disponible|dispo|still have)\b/i },
  SHIPPING: { ask: /\b(deliver\w*|shipping|ship|livraison|livrer)\b/i, knowledge: /deliver|shipping|livraison|livrer/i },
  PAYMENT: { ask: /\b(pay|payment|paiement|payer|cash|card|carte|mobile money)\b/i, knowledge: /pay|paiement|cash|card|carte|mobile money/i },
  RETURNS: { ask: /\b(return|refund|rembours\w*|exchange|echange|échange)\b/i, knowledge: /return|refund|rembours|exchange|echange|échange/i },
  LOCATION: { ask: /\b(where|où|address|adresse|location|located)\b/i, knowledge: /address|adresse|located|quartier|avenue|rue|street/i },
  HOURS: { ask: /\b(open|ouvert|hours|horaires|closing|fermé)\b/i, knowledge: /hours|horaires|open|ouvert|fermé/i },
  SIZE_COLOR: { ask: /\b(size|taille|colou?r|couleur|dimension)\b/i },
};
const OBJECTIONS: Record<string, RegExp> = {
  TOO_EXPENSIVE: /\b(too expensive|trop cher|expensive|overpriced|cheaper|moins cher|discount|r[ée]duction)\b/i,
  TRUST: /\b(scam|arnaque|trust|confiance|fake|fiable|legit)\b/i,
  DELAY: /\b(too long|trop long|late|retard|delay)\b/i,
  QUALITY_DOUBT: /\b(poor quality|mauvaise qualit[ée]|broke|cass[ée]|not as described|defect)\b/i,
};

export interface Question { text: string; answered: boolean; ageHours: number }
export interface CustomerIntel {
  totals: { inbound: number; answered: number; unanswered: number; unansweredOver24h: number };
  faq: Array<{ topic: string; count: number }>;
  objections: Array<{ type: string; count: number }>;
  /** Themes customers ask about that no verified merchant knowledge covers. */
  missingInformation: Array<{ topic: string; count: number }>;
  bottlenecks: Array<{ type: 'SLOW_REPLIES' | 'LOW_REPLY_RATE'; detail: string }>;
  suppressed: number;
  privacy: { k: number; note: string };
}

export function analyzeQuestions(items: Question[], knowledgeText: string, k = K_ANONYMITY): CustomerIntel {
  const topicCount = new Map<string, number>();
  const objCount = new Map<string, number>();
  for (const q of items) {
    const text = sanitizeUntrusted(q.text, 1000);
    for (const [name, t] of Object.entries(TOPICS)) if (t.ask.test(text)) topicCount.set(name, (topicCount.get(name) ?? 0) + 1);
    for (const [name, re] of Object.entries(OBJECTIONS)) if (re.test(text)) objCount.set(name, (objCount.get(name) ?? 0) + 1);
  }
  let suppressed = 0;
  const shown = (m: Map<string, number>) => [...m].filter(([, n]) => (n >= k ? true : (suppressed++, false))).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const faq = shown(topicCount).map((x) => ({ topic: x.name, count: x.count }));
  const objections = shown(objCount).map((x) => ({ type: x.name, count: x.count }));
  const missingInformation = faq.filter((f) => TOPICS[f.topic]?.knowledge && !TOPICS[f.topic]!.knowledge!.test(knowledgeText));
  const answered = items.filter((q) => q.answered).length;
  const over24 = items.filter((q) => !q.answered && q.ageHours > 24).length;
  const bottlenecks: CustomerIntel['bottlenecks'] = [];
  if (over24 >= k) bottlenecks.push({ type: 'SLOW_REPLIES', detail: `${over24} questions have waited more than 24 hours` });
  if (items.length >= 5 && answered / items.length < 0.5) bottlenecks.push({ type: 'LOW_REPLY_RATE', detail: `${answered} of ${items.length} questions were answered` });
  return {
    totals: { inbound: items.length, answered, unanswered: items.length - answered, unansweredOver24h: over24 },
    faq, objections, missingInformation, bottlenecks, suppressed,
    privacy: { k, note: `Only themes asked at least ${k} times are shown. No message text, name or identifier is included.` },
  };
}
