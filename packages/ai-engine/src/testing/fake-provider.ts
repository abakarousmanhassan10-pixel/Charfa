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
