import { AI_LANGUAGES, type AiLanguage } from './ai';

/**
 * Vocabulary and deterministic safety rules of the TOUMA sales and customer service agent.
 * Everything here is rule-based and testable: language detection, escalation triggers and the fixed, human-written
 * messages the agent uses when it must not (or cannot) let the AI model answer.
 */
export const AGENT_LANGUAGES = AI_LANGUAGES;
export type AgentLanguage = AiLanguage;

export const CUSTOMER_INTENTS = [
  'GREETING', 'PRODUCT_INQUIRY', 'PRODUCT_COMPARISON', 'PRICE_INQUIRY', 'AVAILABILITY_INQUIRY', 'PURCHASE_INTENT', 'ORDER_STATUS',
  'DELIVERY_INQUIRY', 'RETURN_REFUND', 'POLICY_FAQ', 'COMPLAINT', 'HUMAN_REQUEST', 'SMALL_TALK', 'OTHER',
] as const;
export type CustomerIntent = (typeof CUSTOMER_INTENTS)[number];

export const LEAD_STATUSES = ['NEW', 'ENGAGED', 'QUALIFIED', 'OPPORTUNITY', 'WON', 'LOST'] as const;
export type LeadStatusId = (typeof LEAD_STATUSES)[number];
export const PURCHASE_INTENTS = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type PurchaseIntentId = (typeof PURCHASE_INTENTS)[number];

export const HANDOFF_REASONS = ['NONE', 'ORDER_STATUS', 'REFUND', 'FINANCIAL_COMMITMENT', 'LEGAL_COMPLAINT', 'SENSITIVE', 'UNVERIFIED_INFO', 'CUSTOMER_REQUESTED', 'LOW_CONFIDENCE', 'AI_UNAVAILABLE', 'OTHER'] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];
export const NEXT_STEPS = ['NONE', 'ASK_CLARIFYING_QUESTION', 'SHARE_PRODUCT_LINK', 'SUGGEST_BOOKING', 'COLLECT_CONTACT', 'HANDOFF_TO_HUMAN', 'CONTACT_BUSINESS'] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

export const SALES_LIMITS = { messageMax: 2000, nameMax: 120, notesMax: 2000, historyForModel: 12, greetingMax: 500 } as const;

// ─── Language detection ───────────────────────────────────────────────────────

const STOP: Record<'en' | 'fr' | 'tr', RegExp> = {
  en: /\b(the|is|are|what|how|much|do|does|you|your|have|has|can|could|would|please|hello|hi|thanks|thank|price|cost|want|need|buy|order|with|for|this|that|available|delivery|shipping|which|best|between|difference)\b/gi,
  fr: /\b(le|la|les|un|une|des|est|sont|que|quel|quelle|quels|quelles|combien|vous|votre|avez|avoir|pouvez|peut|bonjour|salut|merci|prix|coûte|cout|coût|je|veux|voudrais|besoin|acheter|commande|pour|avec|dans|pas|livraison|disponible|différence|entre|svp|s'il)\b/gi,
  tr: /\b(ve|bir|bu|şu|için|ile|mi|mı|mu|mü|merhaba|selam|teşekkür|teşekkürler|fiyat|fiyatı|kaç|ne|kadar|var|yok|istiyorum|almak|sipariş|teslimat|kargo|ürün|hangi|arasında|fark|lütfen|nasıl|değil|çok|daha)\b/gi,
};
const DIACRITICS: Record<'en' | 'fr' | 'tr', RegExp> = { en: /$^/g, fr: /[éèêëàâçôùûîïœ]/gi, tr: /[ğşıİöüç]/g };

export interface LanguageGuess {
  language: AgentLanguage | null;
  confidence: 'HIGH' | 'LOW';
}

/** Detects en, fr, tr or ar from the text alone. Returns null when there is not enough signal (very short or unknown). */
export function detectLanguage(text: string): LanguageGuess {
  const t = text.normalize('NFC');
  const letters = t.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return { language: null, confidence: 'LOW' };
  const arabic = (t.match(/[؀-ۿݐ-ݿ]/g) ?? []).length;
  // Arabic sentences often embed Latin product names, so a quarter of the letters is enough.
  if (arabic >= 3 && arabic / letters.length >= 0.25) return { language: 'ar', confidence: 'HIGH' };
  const score = { en: 0, fr: 0, tr: 0 };
  for (const l of ['en', 'fr', 'tr'] as const) {
    score[l] = (t.match(STOP[l]) ?? []).length * 2 + (t.match(DIACRITICS[l]) ?? []).length * (l === 'tr' ? 2 : 1);
  }
  // Turkish-only letters are decisive; "ç" is shared with French, so it only counts when no French signal says otherwise.
  if (/[ğşıİ]/.test(t)) score.tr += 4;
  const ranked = (Object.entries(score) as Array<['en' | 'fr' | 'tr', number]>).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < 2) return { language: null, confidence: 'LOW' };
  return { language: best[0], confidence: best[1] - (second?.[1] ?? 0) >= 2 ? 'HIGH' : 'LOW' };
}

/** The language the agent answers in: the customer's when the business supports it, otherwise the business default. */
export function resolveReplyLanguage(detected: AgentLanguage | null, supported: readonly string[], fallback: AgentLanguage, previous?: AgentLanguage | null): { language: AgentLanguage; supported: boolean } {
  const ok = (l: string | null | undefined): l is AgentLanguage => Boolean(l) && supported.includes(l as string) && (AGENT_LANGUAGES as readonly string[]).includes(l as string);
  if (ok(detected)) return { language: detected, supported: true };
  if (!detected && ok(previous)) return { language: previous, supported: true };
  return { language: supported.includes(fallback) ? fallback : ((supported[0] as AgentLanguage | undefined) ?? 'en'), supported: detected === null };
}

// ─── Escalation rules (never left to the model) ───────────────────────────────

const RULES: Array<{ reason: HandoffReason; intent: CustomerIntent; re: RegExp }> = [
  { reason: 'LEGAL_COMPLAINT', intent: 'COMPLAINT', re: /\b(lawyer|attorney|sue you|legal action|lawsuit|court|consumer protection|avocat|procès|tribunal|plainte|poursuites?|avukat|dava|mahkeme|şikayet)\b|محامي|قضية|محكمة|شكوى قانونية/i },
  { reason: 'REFUND', intent: 'RETURN_REFUND', re: /\b(refund|money back|chargeback|reimburse|rembours\w*|iade|geri ödeme|paramı geri)\b|استرداد|استرجاع المبلغ|أريد مالي/i },
  { reason: 'SENSITIVE', intent: 'COMPLAINT', re: /\b(scam|fraud|cheat(ed)?|stole|unacceptable|furious|disgusting|arnaque|escroquerie|voleur|inadmissible|scandaleux|dolandırıcı|dolandırıldım|rezalet|kabul edilemez)\b|احتيال|نصب|سرقة|غير مقبول/i },
  { reason: 'ORDER_STATUS', intent: 'ORDER_STATUS', re: /\b(where is my (order|package|parcel)|order status|track(ing)?( my| the)?( order| package| parcel)?|my order (has|hasn)|suivi de (ma )?commande|où est ma commande|ma commande|statut de (ma )?commande|siparişim|sipariş durumu|kargom|kargo takip)\b|أين طلبي|طلبي|تتبع الطلب|حالة الطلب|شحنتي/i },
  { reason: 'CUSTOMER_REQUESTED', intent: 'HUMAN_REQUEST', re: /\b(human|real person|live agent|speak to (a |an )?(agent|person|someone|manager)|talk to (a |an )?(agent|person|someone|manager)|representative|manager|parler (à|a) (un|une|quelqu)\w*|un humain|conseiller|responsable|insan\w*|gerçek (biri|kişi)|müşteri temsilcisi|yetkili)\b|موظف|شخص حقيقي|إنسان|مدير|أتحدث مع/i },
];

export interface EscalationMatch {
  reason: HandoffReason;
  intent: CustomerIntent;
}

/** Deterministic triggers evaluated BEFORE any model call, in priority order (legal, refund, sensitive, order status, human request). */
export function detectEscalation(text: string): EscalationMatch | null {
  for (const r of RULES) if (r.re.test(text)) return { reason: r.reason, intent: r.intent };
  return null;
}

// ─── Fixed messages (written by TOUMA, reviewed by humans, never generated) ───

type Key = 'privacy' | 'handoff' | 'orderStatus' | 'refund' | 'legal' | 'reviewPending' | 'paused' | 'human' | 'aiUnavailable' | 'limit' | 'greeting' | 'disclosure' | 'unsupported' | 'unverified';
const T: Record<Key, Record<AgentLanguage, string>> = {
  handoff: {
    en: 'I want to be sure you get a correct answer, so I have passed your question to our team. They will reply here as soon as possible.',
    fr: 'Je veux m’assurer que vous receviez une réponse exacte : j’ai transmis votre question à notre équipe. Elle vous répondra ici dès que possible.',
    tr: 'Size doğru bir yanıt verebilmek için sorunuzu ekibimize ilettim. En kısa sürede burada yanıt verecekler.',
    ar: 'أريد التأكد من حصولك على إجابة صحيحة، لذلك أحلت سؤالك إلى فريقنا. سيردون عليك هنا في أقرب وقت.',
  },
  orderStatus: {
    en: 'I cannot see order or delivery details, so I will not guess. I have asked our team to check your order and reply here. Please have your order number ready.',
    fr: 'Je n’ai pas accès aux détails des commandes ni des livraisons, donc je ne vais pas deviner. J’ai demandé à notre équipe de vérifier votre commande et de vous répondre ici. Préparez votre numéro de commande.',
    tr: 'Sipariş veya teslimat ayrıntılarını göremiyorum, bu yüzden tahmin yürütmeyeceğim. Ekibimizden siparişinizi kontrol edip burada yanıt vermelerini istedim. Lütfen sipariş numaranızı hazır tutun.',
    ar: 'لا أستطيع الاطلاع على تفاصيل الطلبات أو التوصيل، لذلك لن أخمّن. طلبت من فريقنا التحقق من طلبك والرد هنا. يرجى تجهيز رقم الطلب.',
  },
  refund: {
    en: 'Refunds and payment matters are handled by our team, not by me. I have passed your request to them and they will reply here.',
    fr: 'Les remboursements et les questions de paiement sont traités par notre équipe, pas par moi. Je lui ai transmis votre demande et elle vous répondra ici.',
    tr: 'İade ve ödeme konularını ben değil ekibimiz ele alıyor. Talebinizi onlara ilettim, burada yanıt verecekler.',
    ar: 'يتولى فريقنا أمور الاسترداد والدفع وليس أنا. أحلت طلبك إليهم وسيردون عليك هنا.',
  },
  legal: {
    en: 'I am sorry about this. I am not able to deal with complaints of this kind, so I have passed your message to a member of our team who will contact you here.',
    fr: 'Je suis désolé pour cela. Je ne peux pas traiter ce type de réclamation : j’ai transmis votre message à un membre de notre équipe qui vous répondra ici.',
    tr: 'Bunun için üzgünüm. Bu tür şikayetleri ben ele alamıyorum; mesajınızı ekibimizden birine ilettim, size burada dönüş yapacak.',
    ar: 'أعتذر عن ذلك. لا أستطيع معالجة شكاوى من هذا النوع، لذلك أحلت رسالتك إلى أحد أعضاء فريقنا وسيتواصل معك هنا.',
  },
  reviewPending: {
    en: 'Thank you for your message. A member of our team will reply shortly.',
    fr: 'Merci pour votre message. Un membre de notre équipe vous répondra très bientôt.',
    tr: 'Mesajınız için teşekkürler. Ekibimizden biri kısa süre içinde yanıt verecek.',
    ar: 'شكرًا لرسالتك. سيرد عليك أحد أعضاء فريقنا قريبًا.',
  },
  paused: {
    en: 'Thank you. A member of our team will reply shortly.',
    fr: 'Merci. Un membre de notre équipe vous répondra très bientôt.',
    tr: 'Teşekkürler. Ekibimizden biri kısa süre içinde yanıt verecek.',
    ar: 'شكرًا لك. سيرد عليك أحد أعضاء فريقنا قريبًا.',
  },
  human: {
    en: 'You are now talking with a member of our team.',
    fr: 'Vous échangez maintenant avec un membre de notre équipe.',
    tr: 'Şu anda ekibimizden biriyle konuşuyorsunuz.',
    ar: 'أنت الآن تتحدث مع أحد أعضاء فريقنا.',
  },
  aiUnavailable: {
    en: 'Sorry, I cannot answer right now. I have noted your message and a member of our team will follow up here.',
    fr: 'Désolé, je ne peux pas répondre pour le moment. J’ai noté votre message et un membre de notre équipe vous répondra ici.',
    tr: 'Üzgünüm, şu anda yanıt veremiyorum. Mesajınızı not ettim, ekibimizden biri burada dönüş yapacak.',
    ar: 'عذرًا، لا أستطيع الرد الآن. سجّلت رسالتك وسيتابع معك أحد أعضاء فريقنا هنا.',
  },
  limit: {
    en: 'This conversation has reached the limit for automatic answers. A member of our team will continue it.',
    fr: 'Cette conversation a atteint la limite des réponses automatiques. Un membre de notre équipe la poursuivra.',
    tr: 'Bu konuşma otomatik yanıt sınırına ulaştı. Ekibimizden biri devam edecek.',
    ar: 'وصلت هذه المحادثة إلى حد الردود التلقائية. سيتابعها أحد أعضاء فريقنا.',
  },
  greeting: {
    en: 'Hello! I am the virtual assistant of {business}. I can help you find products and answer questions. For anything I cannot answer reliably, I will pass you to our team.',
    fr: 'Bonjour ! Je suis l’assistant virtuel de {business}. Je peux vous aider à trouver des produits et répondre à vos questions. Pour tout ce que je ne peux pas confirmer, je vous passerai à notre équipe.',
    tr: 'Merhaba! Ben {business} sanal asistanıyım. Ürün bulmanıza ve sorularınızı yanıtlamanıza yardımcı olabilirim. Güvenilir şekilde yanıtlayamadığım konularda sizi ekibimize yönlendireceğim.',
    ar: 'مرحبًا! أنا المساعد الافتراضي لـ {business}. يمكنني مساعدتك في إيجاد المنتجات والإجابة عن أسئلتك. وفي أي أمر لا أستطيع تأكيده سأحوّلك إلى فريقنا.',
  },
  disclosure: {
    en: 'You are chatting with an AI assistant. Do not share passwords or payment card details.',
    fr: 'Vous discutez avec un assistant IA. Ne partagez ni mots de passe ni coordonnées de carte bancaire.',
    tr: 'Bir yapay zekâ asistanıyla konuşuyorsunuz. Şifre veya kart bilgilerinizi paylaşmayın.',
    ar: 'أنت تتحدث مع مساعد ذكاء اصطناعي. لا تشارك كلمات المرور أو بيانات بطاقتك المصرفية.',
  },
  unsupported: {
    en: 'I can answer in English, French, Turkish or Arabic if the business enabled them; I will continue in the language configured for this shop.',
    fr: 'Je réponds dans les langues activées par le commerce ; je continue dans la langue configurée pour cette boutique.',
    tr: 'İşletmenin etkinleştirdiği dillerde yanıt veriyorum; bu mağaza için ayarlanan dilde devam ediyorum.',
    ar: 'أجيب باللغات التي فعّلها المتجر؛ سأتابع باللغة المُعدّة لهذا المتجر.',
  },
  privacy: {
    en: 'Your messages are stored by this business to answer you and follow up. Contact details are kept only if you choose to share them and agree to be contacted. Conversations are erased after {days} days without activity, and you can delete yours at any time below.',
    fr: 'Vos messages sont conservés par ce commerce pour vous répondre et assurer le suivi. Vos coordonnées ne sont conservées que si vous choisissez de les partager et acceptez d’être contacté. Les conversations sont effacées après {days} jours sans activité, et vous pouvez supprimer la vôtre à tout moment ci-dessous.',
    tr: 'Mesajlarınız size yanıt vermek ve takip etmek için bu işletme tarafından saklanır. İletişim bilgileriniz yalnızca paylaşmayı seçerseniz ve iletişime geçilmesini kabul ederseniz saklanır. Konuşmalar {days} gün işlem görmezse silinir ve kendinizinkini istediğiniz zaman aşağıdan silebilirsiniz.',
    ar: 'يحتفظ هذا النشاط التجاري برسائلك للرد عليك ومتابعة طلبك. لا تُحفظ بيانات الاتصال إلا إذا اخترت مشاركتها ووافقت على التواصل معك. تُحذف المحادثات بعد {days} يومًا من عدم النشاط، ويمكنك حذف محادثتك في أي وقت من الأسفل.',
  },
  unverified: {
    en: 'I do not have verified information about that, so I will not guess. I have passed your question to our team.',
    fr: 'Je n’ai pas d’information vérifiée à ce sujet, donc je ne vais pas deviner. J’ai transmis votre question à notre équipe.',
    tr: 'Bu konuda doğrulanmış bilgim yok, bu yüzden tahmin yürütmeyeceğim. Sorunuzu ekibimize ilettim.',
    ar: 'ليست لدي معلومات موثقة حول ذلك، لذلك لن أخمّن. أحلت سؤالك إلى فريقنا.',
  },
};

export function agentMessage(key: Key, language: AgentLanguage, vars: Record<string, string> = {}): string {
  return Object.entries(vars).reduce((t, [k, v]) => t.split(`{${k}}`).join(v), T[key][language] ?? T[key].en);
}

/** The fixed message that goes with an escalation reason. */
export function escalationMessage(reason: HandoffReason, language: AgentLanguage): string {
  if (reason === 'ORDER_STATUS') return agentMessage('orderStatus', language);
  if (reason === 'REFUND' || reason === 'FINANCIAL_COMMITMENT') return agentMessage('refund', language);
  if (reason === 'LEGAL_COMPLAINT' || reason === 'SENSITIVE') return agentMessage('legal', language);
  if (reason === 'AI_UNAVAILABLE') return agentMessage('aiUnavailable', language);
  if (reason === 'UNVERIFIED_INFO') return agentMessage('unverified', language);
  return agentMessage('handoff', language);
}
