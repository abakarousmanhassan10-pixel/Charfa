import { FORMAT_RULES, type AiFormat, type AiLanguage, type AiPlatform } from '@touma/shared';
import { ProviderError } from '../errors';
import type { GenerateRequest, GenerateResult, TextModelProvider } from '../provider';

/**
 * TEST-ONLY provider (AI_PROVIDER=fake, accepted by the API only when APP_ENV=test).
 * - Default answers are deterministic, schema-valid and built only from the delimited business data,
 *   so end-to-end flows can be tested without calling a real model.
 * - Tests can script exact responses (raw text or errors) and inspect every request received.
 */
type Scripted = string | Error | ((req: GenerateRequest) => string | Promise<string>);

export class FakeTextProvider implements TextModelProvider {
  readonly name = 'fake';
  readonly requests: GenerateRequest[] = [];
  private queue: Scripted[] = [];
  configured = true;

  isConfigured() {
    return this.configured;
  }

  enqueue(...items: Scripted[]) {
    this.queue.push(...items);
  }

  reset() {
    this.queue = [];
    this.requests.length = 0;
    this.configured = true;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    const text = typeof next === 'function' ? await next(req) : typeof next === 'string' ? next : JSON.stringify(defaultAnswer(req));
    return { text, inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4), model: `fake:${req.model}` };
  }
}

/** The deterministic default answer for a request (useful to build tampered variants in tests). */
export function fakeDefaultAnswer(req: GenerateRequest): Record<string, unknown> {
  return defaultAnswer(req) as Record<string, unknown>;
}

export const fakeErrors = {
  rateLimit: () => new ProviderError('rate_limit', 'Fake rate limit', 429),
  server: () => new ProviderError('server', 'Fake server error', 500),
  auth: () => new ProviderError('auth', 'Fake auth failure', 401),
};

// ─── Deterministic default answers ────────────────────────────────────────────

// Test-only parser of untyped prompt blocks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function block(user: string, tag: string): any {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(user);
  return m ? JSON.parse(m[1]!) : null;
}

const T: Record<AiLanguage, (biz: string, item: string) => { s: string; long: string; cta: string; hook: string; seg: string }> = {
  en: (b, i) => ({
    s: `${b} offers ${i} for customers who want quality and a friendly experience.`,
    long: `Discover ${i} by ${b}. We prepare it with care for you and your family, and our team is happy to answer your questions. This is the right moment to visit us and enjoy the experience with the people you love.`,
    cta: 'Send us a message to order',
    hook: `Have you tried ${i} yet?`,
    seg: 'Local families and young professionals',
  }),
  fr: (b, i) => ({
    s: `${b} propose ${i} pour les clients qui recherchent la qualité et un accueil chaleureux.`,
    long: `Découvrez ${i} de ${b}. Nous le préparons avec soin pour vous et votre famille, et notre équipe est à votre écoute pour toutes vos questions. C'est le moment de venir nous voir et de partager une expérience avec des personnes que vous aimez.`,
    cta: 'Envoyez-nous un message pour commander',
    hook: `Avez-vous déjà goûté ${i} ?`,
    seg: 'Les familles et les jeunes actifs de la ville',
  }),
  tr: (b, i) => ({
    s: `${b}, kaliteli ve samimi bir deneyim isteyen müşteriler için ${i} sunuyor.`,
    long: `${b} ile ${i} keşfedin. Bu ürünü sizin ve aileniz için özenle hazırlıyoruz ve ekibimiz tüm sorularınız için hemen yardımcı olmaya hazır. Sevdiklerinizle birlikte bu deneyimi yaşamak için bizi ziyaret etmenin tam zamanı, en güzel anlar için bir mesaj gibi.`,
    cta: 'Sipariş için bize mesaj gönderin',
    hook: `${i} denediniz mi?`,
    seg: 'Şehirdeki aileler ve genç çalışanlar',
  }),
  ar: () => ({
    s: 'نقدم لعملائنا منتجات عالية الجودة وتجربة ودية ومميزة في كل زيارة.',
    long: 'اكتشفوا منتجاتنا المحضرة بعناية من أجلكم ومن أجل عائلاتكم، وفريقنا سعيد بالإجابة عن جميع أسئلتكم في أي وقت. هذه هي اللحظة المناسبة لزيارتنا والاستمتاع بتجربة جميلة مع من تحبون.',
    cta: 'راسلونا الآن للطلب',
    hook: 'هل جربتم منتجنا الجديد؟',
    seg: 'العائلات والشباب في المدينة',
  }),
};

const tag = (v: string) => `#${v.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40) || 'touma'}`;

function defaultAnswer(req: GenerateRequest): unknown {
  const data = block(req.user, 'business_data') ?? {};
  const task = block(req.user, 'task') ?? {};
  const lang: AiLanguage = task.language ?? 'en';
  const bizName: string = data.business?.name ?? 'Business';
  const item = data.item ?? data.products?.[0] ?? data.services?.[0] ?? null;
  const t = T[lang](bizName, item?.name ?? bizName);

  switch (req.schemaName) {
    case 'sales_reply':
      return salesAnswer(data, task);
    case 'content_plan': {
      const days: number = task.days ?? 30;
      const platforms: string[] = task.platforms ?? ['INSTAGRAM'];
      const occasions: Array<{ name: string; day: number }> = task.occasions ?? [];
      const target = Math.max(1, Math.round(((task.postsPerWeek ?? 5) * days) / 7));
      const catalog: Array<{ type: 'PRODUCT' | 'SERVICE'; id: string; name: string }> = [
        ...(data.products ?? []).map((p: { id: string; name: string }) => ({ type: 'PRODUCT' as const, id: p.id, name: p.name })),
        ...(data.services ?? []).map((x: { id: string; name: string }) => ({ type: 'SERVICE' as const, id: x.id, name: x.name })),
      ];
      const pillars = catalog.length ? ['PRODUCT_SHOWCASE', 'EDUCATIONAL', 'ENGAGEMENT', 'PROMOTIONAL', 'BRAND_AWARENESS'] : ['EDUCATIONAL', 'ENGAGEMENT', 'BRAND_AWARENESS'];
      const perDay = new Map<string, number>();
      const items: Array<Record<string, unknown>> = [];
      for (let i = 0; i < target; i++) {
        const platform = platforms[i % platforms.length]!;
        let day = Math.min(days, 1 + Math.floor((i * days) / target));
        while ((perDay.get(`${platform}:${day}`) ?? 0) >= 1 && day < days) day++;
        perDay.set(`${platform}:${day}`, (perDay.get(`${platform}:${day}`) ?? 0) + 1);
        const pillar = pillars[i % pillars.length]!;
        const entry = catalog.length && (pillar === 'PRODUCT_SHOWCASE' || pillar === 'PROMOTIONAL') ? catalog[i % catalog.length]! : null;
        items.push({ day, platform, pillar, contentType: i % 3 === 0 ? 'IMAGE' : i % 3 === 1 ? 'TEXT' : 'VIDEO', title: `${entry?.name ?? bizName} ${i + 1}`, brief: t.s, itemType: entry?.type ?? null, itemId: entry?.id ?? null, occasion: null });
      }
      occasions.forEach((o, k) => {
        const platform = platforms[k % platforms.length]!;
        const used = items.filter((x) => x.platform === platform && x.day === o.day).length;
        if (used >= 1) {
          // Make room: move the colliding post one day later.
          const clash = items.find((x) => x.platform === platform && x.day === o.day);
          if (clash) clash.day = Math.min(days, o.day + 1);
        }
        items.push({ day: o.day, platform, pillar: 'SEASONAL', contentType: 'IMAGE', title: o.name, brief: t.s, itemType: null, itemId: null, occasion: o.name });
      });
      return {
        language: lang,
        startDate: task.startDate,
        days,
        summary: t.long,
        items,
        claims: catalog[0] ? [{ claim: catalog[0].name, source: `${catalog[0].type === 'SERVICE' ? 'service' : 'product'}:${catalog[0].id}` }] : [],
        warnings: [],
        missingInformation: [],
      };
    }
    case 'video_storyboard': {
      const seconds = Number(task.seconds ?? 8);
      const per = Math.max(1, Math.floor(seconds / 3));
      const durations = [per, per, seconds - 2 * per];
      const aspect = task.aspectRatio ?? '9:16';
      return {
        language: lang,
        format: task.format ?? 'SHORT_VERTICAL',
        aspectRatio: aspect,
        totalSeconds: seconds,
        title: t.hook.slice(0, 100),
        concept: t.s,
        hook: t.hook,
        voiceoverScript: t.long,
        scenes: durations.map((d, i) => ({ order: i + 1, durationSeconds: d, visual: t.s, camera: i === 0 ? 'Slow push-in' : null, voiceover: i === 0 ? t.hook : t.s, onScreenText: t.seg, audio: null, productFocus: item?.name ?? null })),
        callToAction: t.cta,
        musicMood: null,
        hashtags: [],
        videoPrompt: `${t.s} ${t.s}`,
        claims: item ? [{ claim: item.name, source: `${data.item ? (task.item?.type === 'SERVICE' ? 'service' : 'product') : 'product'}:${item.id}` }] : [],
        warnings: [],
        missingInformation: [],
      };
    }
    case 'business_marketing_profile':
      return {
        summary: t.long,
        industry: data.business?.industry ?? data.business?.type ?? 'General',
        positioning: t.s,
        geographicMarket: { primaryMarket: [data.business?.city, data.business?.country].filter(Boolean).join(', ') || t.seg, contentLanguages: [lang], localConsiderations: [t.s] },
        brandIdentity: { personality: [t.seg], values: [t.s], visualStyleSuggestions: [t.s] },
        communicationStyle: { recommendedTone: t.s, do: [t.s], avoid: [t.s] },
        targetSegments: [{ name: t.seg, description: t.s, needs: [t.s], preferredPlatforms: ['INSTAGRAM', 'FACEBOOK'] }],
        customerNeeds: [t.s],
        strengths: [{ text: t.s, source: 'business' }],
        marketingObjectives: [t.s],
        recommendedPlatforms: [{ platform: 'INSTAGRAM', priority: 'HIGH', reason: t.s }],
        missingInformation: [],
        assumptions: [t.s],
      };
    case 'product_marketing_analysis': {
      const itemRef = task.item ?? { type: 'PRODUCT', id: item?.id ?? 'unknown' };
      const src = `${itemRef.type === 'PRODUCT' ? 'product' : 'service'}:${itemRef.id}`;
      return {
        item: { type: itemRef.type, id: itemRef.id, name: item?.name ?? 'Item' },
        summary: t.long,
        characteristics: ((item?.features as string[]) ?? []).slice(0, 5).map((f) => ({ text: f, source: src })),
        verifiedBenefits: ((item?.benefits as string[]) ?? []).slice(0, 5).map((f) => ({ text: f, source: src })),
        customerProblems: [t.s],
        customerSegments: [{ name: t.seg, reason: t.s }],
        positioning: t.s,
        marketingAngles: [{ name: t.seg, hook: t.hook, description: t.s }],
        differentiationOpportunities: [t.s],
        possibleObjections: [{ objection: t.hook, suggestedResponse: t.s, needsBusinessInput: true }],
        faq: [{ question: t.hook, answer: null, source: null, needsBusinessInput: true }],
        missingInformation: [],
        assumptions: [t.s],
      };
    }
    case 'marketing_strategy': {
      const platforms: AiPlatform[] = task.platforms ?? ['INSTAGRAM'];
      return {
        summary: t.long,
        goal: task.goal ?? t.s,
        platforms: platforms.map((p) => {
          const own = (Object.keys(FORMAT_RULES) as AiFormat[]).filter((f) => FORMAT_RULES[f].platform === p);
          return {
            platform: p,
            objective: t.s,
            targetAudience: t.seg,
            contentPillars: [{ name: 'Produits', description: t.s }, { name: 'Coulisses', description: t.s }],
            recommendedFormats: own.slice(0, 2),
            postingFrequency: t.s,
            weeklyPlan: [{ day: 'MONDAY', pillar: 'Produits', format: own[0]!, idea: t.s, callToAction: t.cta }],
            kpis: [t.s],
          };
        }),
        campaigns: [{ name: t.seg, concept: t.long, targetAudience: t.seg, marketingAngle: t.s, platforms, durationWeeks: 2, promotionalIdea: t.s, callToAction: t.cta, relatedSources: ['business'] }],
        monthlyPlan: [1, 2, 3, 4].map((week) => ({ week, theme: t.seg, focus: t.s, actions: [t.s] })),
        promotionalIdeas: [t.s],
        callsToAction: [t.cta],
        missingInformation: [],
        assumptions: [t.s],
      };
    }
    case 'marketing_content': {
      const format: AiFormat = task.format;
      const rule = FORMAT_RULES[format];
      const need = (k: string) => rule.requires.includes(k as never);
      const hashtags = rule.maxHashtags > 0 ? [...new Set([tag(bizName), tag(item?.name ?? 'touma'), '#TOUMA'])].slice(0, Math.min(3, rule.maxHashtags)) : [];
      return {
        language: lang,
        format,
        platform: rule.platform,
        title: need('title') ? t.hook.slice(0, rule.maxTitleChars ?? 100) : null,
        hook: need('hook') ? t.hook : null,
        caption: need('caption') ? t.long : null,
        description: need('description') ? t.long : null,
        slides: rule.slides ? Array.from({ length: rule.slides.min + 1 }, (_, i) => ({ heading: `${i + 1}. ${t.seg}`.slice(0, 120), body: t.s })) : [],
        scenes: need('scenes') ? [1, 2, 3].map((order) => ({ order, durationSeconds: 5, visual: t.s, voiceover: order === 1 ? t.hook : t.s, onScreenText: t.seg })) : [],
        storyFrames: rule.storyFrames ? [1, 2, 3].map(() => ({ text: t.s, visualIdea: t.seg, interactiveElement: null })) : [],
        hashtags,
        callToAction: t.cta,
        visualSuggestions: [t.s],
        claims: [{ claim: t.s, source: task.item ? `${task.item.type === 'PRODUCT' ? 'product' : 'service'}:${task.item.id}` : 'business' }],
        warnings: [],
      };
    }
    default:
      return {};
  }
}

// ─── Customer conversation (test-only, deterministic, built only from the delimited data) ─────────────────────────────

const SALES_T: Record<AiLanguage, { hello: (b: string) => string; price: (n: string, p: string) => string; noPrice: (n: string) => string; compare: (a: string, b: string) => string; unknown: string; buy: string; policy: (t: string) => string; unavailable: (n: string) => string; found: (n: string) => string }> = {
  en: { hello: (b) => `Hello! Welcome to ${b}. How can I help you today?`, price: (n, p) => `${n} costs ${p}.`, noPrice: (n) => `${n} is available; the price is available on request.`, compare: (a, b) => `Here is how ${a} and ${b} compare:`, unknown: 'I do not have verified information about that, so I will not guess.', buy: 'Great choice! Please leave your name and phone number and our team will confirm your order.', policy: (t) => t, unavailable: (n) => `${n} is currently unavailable.`, found: (n) => `${n} could suit you.` },
  fr: { hello: (b) => `Bonjour ! Bienvenue chez ${b}. Comment puis-je vous aider ?`, price: (n, p) => `${n} coûte ${p}.`, noPrice: (n) => `${n} est disponible ; le prix est communiqué sur demande.`, compare: (a, b) => `Voici une comparaison de ${a} et ${b} :`, unknown: 'Je n’ai pas d’information vérifiée à ce sujet, donc je ne vais pas deviner.', buy: 'Excellent choix ! Laissez-nous votre nom et votre numéro, notre équipe confirmera votre commande.', policy: (t) => t, unavailable: (n) => `${n} est actuellement indisponible.`, found: (n) => `${n} pourrait vous convenir.` },
  tr: { hello: (b) => `Merhaba! ${b} mağazasına hoş geldiniz. Size nasıl yardımcı olabilirim?`, price: (n, p) => `${n} fiyatı ${p}.`, noPrice: (n) => `${n} mevcut; fiyat istek üzerine bildirilir.`, compare: (a, b) => `${a} ve ${b} karşılaştırması:`, unknown: 'Bu konuda doğrulanmış bilgim yok, tahmin yürütmeyeceğim.', buy: 'Harika bir seçim! Adınızı ve telefon numaranızı bırakın, ekibimiz siparişinizi onaylasın.', policy: (t) => t, unavailable: (n) => `${n} şu anda mevcut değil.`, found: (n) => `${n} size uygun olabilir.` },
  ar: { hello: (b) => `مرحبًا بك في ${b}. كيف يمكنني مساعدتك؟`, price: (n, p) => `سعر ${n} هو ${p}.`, noPrice: (n) => `${n} متوفر؛ السعر متاح عند الطلب.`, compare: (a, b) => `مقارنة بين ${a} و${b}:`, unknown: 'ليست لدي معلومات موثقة حول ذلك، لذلك لن أخمّن.', buy: 'اختيار رائع! اترك اسمك ورقم هاتفك وسيؤكد فريقنا طلبك.', policy: (t) => t, unavailable: (n) => `${n} غير متوفر حاليًا.`, found: (n) => `${n} قد يناسبك.` },
};

type SalesItem = { id: string; name: string; price?: string | null; discountPrice?: string | null; currency?: string | null; availability?: string; features?: string[]; benefits?: string[] };

function salesAnswer(data: any, task: any): Record<string, unknown> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const lang: AiLanguage = task.replyLanguage ?? 'en';
  const t = SALES_T[lang];
  const conv: Array<{ from: string; text: string }> = data.conversation ?? [];
  const last = [...conv].reverse().find((m) => m.from === 'customer')?.text ?? '';
  const low = last.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const items: Array<SalesItem & { type: 'PRODUCT' | 'SERVICE' }> = [...(data.products ?? []).map((p: SalesItem) => ({ ...p, type: 'PRODUCT' as const })), ...(data.services ?? []).map((p: SalesItem) => ({ ...p, type: 'SERVICE' as const }))];
  const hit = items.filter((i) => low.includes(i.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()));
  const base = { language: lang, handoff: { needed: false, reason: 'NONE' }, recommended: [] as unknown[], missingInformation: [] as string[], nextStep: 'NONE', purchaseIntent: 'NONE' };
  const money = (i: SalesItem) => (i.price ? `${i.discountPrice ?? i.price} ${i.currency ?? data.business?.currency ?? ''}`.trim() : null);
  const wantsBuy = /(\bbuy\b|\border\b|acheter|commander|almak|siparis vermek|اشتري|اطلب|شراء)/.test(low);
  const wantsPrice = /(price|how much|cost|prix|combien|fiyat|kac|kadar|سعر|كم)/.test(low);
  const wantsCompare = /(compare|difference|vs|versus|comparer|difference|fark|karsilastir|قارن|الفرق)/.test(low);
  const policyWords = /(deliver|shipping|livraison|teslimat|kargo|return|retour|iade|توصيل|ارجاع|policy|politique)/.test(low);

  if (policyWords) {
    const k = (data.knowledge ?? []).find((e: { category: string }) => ['DELIVERY_POLICY', 'RETURN_POLICY', 'FAQ', 'OTHER'].includes(e.category) && (/(deliver|shipping|livraison|teslimat|kargo|توصيل)/.test(low) ? e.category === 'DELIVERY_POLICY' : e.category === 'RETURN_POLICY'));
    if (k) return { ...base, intent: 'POLICY_FAQ', reply: t.policy(k.body), confidence: 'HIGH', answerable: true, sources: [`knowledge:${k.id}`] };
    return { ...base, intent: 'POLICY_FAQ', reply: t.unknown, confidence: 'LOW', answerable: false, handoff: { needed: true, reason: 'UNVERIFIED_INFO' }, sources: [], missingInformation: ['policy'] };
  }
  if (hit.length >= 2 && wantsCompare) {
    const lines = hit.slice(0, 2).map((i) => `${i.name}: ${money(i) ?? '—'}${i.benefits?.[0] ? `, ${i.benefits[0]}` : ''}`);
    return { ...base, intent: 'PRODUCT_COMPARISON', reply: `${t.compare(hit[0]!.name, hit[1]!.name)} ${lines.join(' | ')}`, confidence: 'HIGH', answerable: true, recommended: hit.slice(0, 2).map((i) => ({ type: i.type, id: i.id, reason: i.benefits?.[0] ?? i.name })), sources: hit.slice(0, 2).map((i) => `${i.type === 'PRODUCT' ? 'product' : 'service'}:${i.id}`) };
  }
  if (hit.length >= 1) {
    const i = hit[0]!;
    const src = `${i.type === 'PRODUCT' ? 'product' : 'service'}:${i.id}`;
    if (['OUT_OF_STOCK', 'DISCONTINUED', 'UNAVAILABLE'].includes(String(i.availability))) return { ...base, intent: 'AVAILABILITY_INQUIRY', reply: t.unavailable(i.name), confidence: 'HIGH', answerable: true, sources: [src] };
    const p = money(i);
    const text = wantsPrice ? (p ? t.price(i.name, p) : t.noPrice(i.name)) : t.found(i.name);
    return { ...base, intent: wantsBuy ? 'PURCHASE_INTENT' : wantsPrice ? 'PRICE_INQUIRY' : 'PRODUCT_INQUIRY', reply: wantsBuy ? `${text} ${t.buy}` : text, confidence: 'HIGH', answerable: true, purchaseIntent: wantsBuy ? 'HIGH' : wantsPrice ? 'MEDIUM' : 'LOW', nextStep: wantsBuy ? 'COLLECT_CONTACT' : 'NONE', recommended: [{ type: i.type, id: i.id, reason: i.benefits?.[0] ?? i.name }], sources: [src] };
  }
  if (/(hello|hi\b|bonjour|salut|merhaba|selam|مرحبا)/.test(low) && low.length < 40) return { ...base, intent: 'GREETING', reply: t.hello(data.business?.name ?? 'our shop'), confidence: 'HIGH', answerable: true, sources: ['business'] };
  return { ...base, intent: 'OTHER', reply: t.unknown, confidence: 'LOW', answerable: false, handoff: { needed: true, reason: 'UNVERIFIED_INFO' }, sources: [], missingInformation: ['answer'] };
}
