import { AI_LANGUAGE_NAMES, CONTENT_PILLARS, PLATFORM_RULES, type AiLanguage, type AiPlatform, type AiTone } from '@touma/shared';
import type { BusinessContext } from '../context';
import { contentPlanSchema } from '../schemas';
import { checkContentPlan } from '../validation';
import type { AgentDefinition } from './types';

export interface ContentPlanInput {
  language: AiLanguage;
  startDate: string;
  days: number;
  timezone: string;
  postsPerWeek: number;
  platforms: AiPlatform[];
  connectedPlatforms: AiPlatform[];
  tone: AiTone | null;
  goal: string | null;
  objectives: string | null;
  /** Merchant-supplied occasions with their day number in the plan. Nothing else may be treated as a holiday or event. */
  occasions: Array<{ name: string; date: string; day: number }>;
  /** Day number → real date and weekday, so the model never has to compute dates. */
  calendar: Array<{ day: number; date: string; weekday: string }>;
  brandVoice: string | null;
  brand: { preferredTone: string | null; visualStyle: string | null; guidelines: string | null; colors: string[] } | null;
}

export const contentPlanner: AgentDefinition<ContentPlanInput, typeof contentPlanSchema> = {
  agent: 'SCHEDULER',
  task: 'CONTENT_PLAN',
  promptVersion: 'content-planner@1',
  schemaName: 'content_plan',
  schema: contentPlanSchema,
  defaultTemperature: 0.6,
  system: (i) => `You are the TOUMA AI Content Planner. Create a ${i.days}-day social media content plan starting on ${i.startDate} (timezone ${i.timezone}) for the business in <business_data>.
Plan about ${i.postsPerWeek} posts per week across: ${i.platforms.join(', ')}. Write titles and briefs in ${AI_LANGUAGE_NAMES[i.language]}.${i.tone ? ` Tone: ${i.tone}.` : ''}${i.brandVoice ? ' Respect the brand voice in the data.' : ''}${i.brand ? ' Follow the brand kit in the task.' : ''}
Give each post a day number (1..${i.days}, see "calendar" in the task), a platform, a content pillar (${CONTENT_PILLARS.join(', ')}), a content type, a short title and a brief that tells the writer what the post should say and show.
Balance the pillars: promotional, educational, product showcase, customer engagement and brand awareness all appear, and no pillar is more than half of the plan. Use the business's own products and services (itemType + itemId from the data) for PROMOTIONAL and PRODUCT_SHOWCASE posts, and vary them. Consider the audience, location, objectives and the platforms.
STRICT RULES:
- SEASONAL posts are allowed ONLY for the occasions listed in "occasions" in the task, on exactly that day, with the occasion name copied exactly. If "occasions" is empty, create NO seasonal posts. Never mention any other holiday, season, event or date.
- Never invent a promotion, discount, price, offer, giveaway, event, award, statistic or customer testimonial. A PROMOTIONAL post presents what the data says about the product or service; it does not create offers.
- Do not choose a time of day and do not write calendar dates in titles or briefs; the system chooses times and the day number places the post. At most ${Math.min(2, Math.min(...i.platforms.map((p) => PLATFORM_RULES[p].maxPerDay)))} post(s) per platform per day, and never repeat a title.
- List every factual statement in "claims" with its source id ("business", "product:<id>", "service:<id>", "knowledge:<id>"). If information needed for a good plan is missing, list it in "missingInformation".
Return the same language, startDate and days as given.`,
  taskParams: (i) => ({
    task: 'CONTENT_PLAN',
    language: i.language,
    startDate: i.startDate,
    days: i.days,
    timezone: i.timezone,
    postsPerWeek: i.postsPerWeek,
    platforms: i.platforms,
    connectedPlatforms: i.connectedPlatforms,
    tone: i.tone,
    goal: i.goal,
    objectives: i.objectives,
    occasions: i.occasions,
    calendar: i.calendar,
    brand: i.brand,
  }),
  scopeContext: (ctx: BusinessContext) => ({ business: ctx.business, products: ctx.products.slice(0, 30), services: ctx.services.slice(0, 30), knowledge: ctx.knowledge }),
  validate: (out, ctx, i) => checkContentPlan(out as never, ctx, { language: i.language, startDate: i.startDate, days: i.days, postsPerWeek: i.postsPerWeek, platforms: i.platforms, occasions: i.occasions }),
};
