import { z } from 'zod';
import { AI_FORMATS, AI_LANGUAGES, CUSTOMER_INTENTS, HANDOFF_REASONS, NEXT_STEPS, PURCHASE_INTENTS, AI_PLATFORMS, ASPECT_RATIOS, CONTENT_PILLARS, VIDEO_FORMAT_KEYS } from '@touma/shared';

const s = (max: number) => z.string().min(1).max(max);
const list = <T extends z.ZodTypeAny>(item: T, max: number, min = 0) => z.array(item).min(min).max(max);
const platform = z.enum(AI_PLATFORMS);
/** A statement tied to a source from the business context: "business", "product:<id>", "service:<id>", "knowledge:<id>". */
const sourced = z.object({ text: s(500), source: s(80) });

export const businessAnalysisSchema = z.object({
  summary: s(1500),
  industry: s(200),
  positioning: s(800),
  geographicMarket: z.object({
    primaryMarket: s(300),
    contentLanguages: list(s(40), 6),
    localConsiderations: list(s(300), 8),
  }),
  brandIdentity: z.object({
    personality: list(s(80), 8),
    values: list(s(150), 8),
    visualStyleSuggestions: list(s(200), 6),
  }),
  communicationStyle: z.object({
    recommendedTone: s(200),
    do: list(s(200), 8),
    avoid: list(s(200), 8),
  }),
  targetSegments: list(
    z.object({ name: s(100), description: s(500), needs: list(s(200), 6), preferredPlatforms: list(platform, 4) }),
    6,
    1,
  ),
  customerNeeds: list(s(200), 10),
  strengths: list(sourced, 10),
  marketingObjectives: list(s(250), 8),
  recommendedPlatforms: list(z.object({ platform, priority: z.enum(['HIGH', 'MEDIUM', 'LOW']), reason: s(400) }), 4, 1),
  missingInformation: list(s(300), 15),
  assumptions: list(s(300), 10),
});
export type BusinessAnalysis = z.infer<typeof businessAnalysisSchema>;

export const productAnalysisSchema = z.object({
  item: z.object({ type: z.enum(['PRODUCT', 'SERVICE']), id: s(60), name: s(200) }),
  summary: s(1200),
  characteristics: list(sourced, 15),
  verifiedBenefits: list(sourced, 12),
  customerProblems: list(s(300), 10),
  customerSegments: list(z.object({ name: s(100), reason: s(400) }), 6),
  positioning: s(800),
  marketingAngles: list(z.object({ name: s(100), hook: s(200), description: s(500) }), 8, 1),
  differentiationOpportunities: list(s(300), 8),
  possibleObjections: list(z.object({ objection: s(300), suggestedResponse: s(600), needsBusinessInput: z.boolean() }), 8),
  faq: list(
    z.object({ question: s(300), answer: z.string().max(800).nullable(), source: z.string().max(80).nullable(), needsBusinessInput: z.boolean() }),
    10,
  ),
  missingInformation: list(s(300), 15),
  assumptions: list(s(300), 10),
});
export type ProductAnalysis = z.infer<typeof productAnalysisSchema>;

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;

export const marketingStrategySchema = z.object({
  summary: s(1500),
  goal: s(400),
  platforms: list(
    z.object({
      platform,
      objective: s(400),
      targetAudience: s(400),
      contentPillars: list(z.object({ name: s(80), description: s(400) }), 6, 2),
      recommendedFormats: list(z.enum(AI_FORMATS), 6, 1),
      postingFrequency: s(160),
      weeklyPlan: list(
        z.object({ day: z.enum(DAYS), pillar: s(80), format: z.enum(AI_FORMATS), idea: s(400), callToAction: s(200) }),
        7,
        1,
      ),
      kpis: list(s(160), 6),
    }),
    4,
    1,
  ),
  campaigns: list(
    z.object({
      name: s(120),
      concept: s(600),
      targetAudience: s(300),
      marketingAngle: s(300),
      platforms: list(platform, 4, 1),
      durationWeeks: z.number().int().min(1).max(12),
      promotionalIdea: s(500),
      callToAction: s(200),
      relatedSources: list(s(80), 10),
    }),
    5,
    1,
  ),
  monthlyPlan: list(z.object({ week: z.number().int().min(1).max(5), theme: s(160), focus: s(400), actions: list(s(300), 6, 1) }), 5, 4),
  promotionalIdeas: list(s(400), 10),
  callsToAction: list(s(200), 10),
  missingInformation: list(s(300), 15),
  assumptions: list(s(300), 10),
});
export type MarketingStrategy = z.infer<typeof marketingStrategySchema>;

export const contentSchema = z.object({
  language: z.enum(AI_LANGUAGES),
  format: z.enum(AI_FORMATS),
  platform: platform.nullable(),
  title: z.string().max(200).nullable(),
  hook: z.string().max(300).nullable(),
  caption: z.string().max(6000).nullable(),
  description: z.string().max(6000).nullable(),
  slides: list(z.object({ heading: s(120), body: s(600) }), 10),
  scenes: list(
    z.object({
      order: z.number().int().min(1).max(30),
      durationSeconds: z.number().min(1).max(60),
      visual: s(400),
      voiceover: z.string().max(600).nullable(),
      onScreenText: z.string().max(200).nullable(),
    }),
    20,
  ),
  storyFrames: list(z.object({ text: s(300), visualIdea: s(300), interactiveElement: z.string().max(120).nullable() }), 10),
  hashtags: list(z.string().max(60), 30),
  callToAction: s(250),
  visualSuggestions: list(s(300), 6),
  /** Every factual statement used, with its source. Unsourced facts are not allowed. */
  claims: list(z.object({ claim: s(400), source: s(80) }), 15),
  warnings: list(s(300), 8),
});
export type GeneratedContent = z.infer<typeof contentSchema>;

/** Storyboard + script for one promotional video. Every factual statement is sourced like any other TOUMA AI output. */
export const storyboardSchema = z.object({
  language: z.enum(AI_LANGUAGES),
  format: z.enum(VIDEO_FORMAT_KEYS as [string, ...string[]]),
  aspectRatio: z.enum(ASPECT_RATIOS),
  totalSeconds: z.number().min(4).max(120),
  title: s(150),
  concept: s(500),
  hook: s(300),
  voiceoverScript: z.string().max(3000).nullable(),
  scenes: list(
    z.object({
      order: z.number().int().min(1).max(30),
      durationSeconds: z.number().min(1).max(30),
      visual: s(500),
      camera: z.string().max(200).nullable(),
      voiceover: z.string().max(600).nullable(),
      onScreenText: z.string().max(200).nullable(),
      audio: z.string().max(200).nullable(),
      productFocus: z.string().max(200).nullable(),
    }),
    12,
    1,
  ),
  callToAction: s(250),
  musicMood: z.string().max(150).nullable(),
  hashtags: list(z.string().max(60), 15),
  /** One paragraph describing the visuals, usable as the prompt of a video model. */
  videoPrompt: s(1000),
  claims: list(z.object({ claim: s(400), source: s(80) }), 15),
  warnings: list(s(300), 8),
  missingInformation: list(s(300), 10),
});
export type Storyboard = z.infer<typeof storyboardSchema>;

/**
 * A day-by-day marketing plan. The model chooses WHAT to post and WHEN (day number); the exact time of day is chosen
 * by TOUMA from the audience data it has (or labelled estimates). Seasonal items may only use occasions the merchant supplied.
 */
export const contentPlanSchema = z.object({
  language: z.enum(AI_LANGUAGES),
  startDate: s(10),
  days: z.number().int().min(7).max(30),
  summary: s(600),
  items: list(
    z.object({
      day: z.number().int().min(1).max(30),
      platform,
      pillar: z.enum(CONTENT_PILLARS as unknown as [string, ...string[]]),
      contentType: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL']),
      title: s(120),
      brief: s(400),
      itemType: z.enum(['PRODUCT', 'SERVICE']).nullable(),
      itemId: z.string().max(80).nullable(),
      /** The merchant-supplied occasion this post is about (exact name), or null. */
      occasion: z.string().max(80).nullable(),
    }),
    60,
    1,
  ),
  claims: list(z.object({ claim: s(400), source: s(80) }), 20),
  warnings: list(s(300), 8),
  missingInformation: list(s(300), 10),
});
export type ContentPlan = z.infer<typeof contentPlanSchema>;

/** One customer-facing answer. Everything the service needs to decide what to do next is explicit and validated. */
export const salesReplySchema = z.object({
  language: z.enum(AI_LANGUAGES),
  intent: z.enum(CUSTOMER_INTENTS),
  reply: s(1500),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  /** False when the verified data does not contain the answer. */
  answerable: z.boolean(),
  handoff: z.object({ needed: z.boolean(), reason: z.enum(HANDOFF_REASONS) }),
  purchaseIntent: z.enum(PURCHASE_INTENTS),
  nextStep: z.enum(NEXT_STEPS),
  recommended: list(z.object({ type: z.enum(['PRODUCT', 'SERVICE']), id: s(60), reason: s(300) }), 3),
  sources: list(s(80), 12),
  missingInformation: list(s(300), 6),
});
export type SalesReply = z.infer<typeof salesReplySchema>;
