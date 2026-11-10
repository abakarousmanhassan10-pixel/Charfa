import { AI_LANGUAGE_NAMES, FORMAT_RULES, type AiContentPurpose, type AiFormat, type AiLanguage, type AiPlatform, type AiTone } from '@touma/shared';
import type { BusinessContext } from '../context';
import { contentSchema } from '../schemas';
import { checkContent } from '../validation';
import type { AgentDefinition } from './types';

export interface ContentInput {
  language: AiLanguage;
  platform: AiPlatform | null;
  format: AiFormat;
  purpose: AiContentPurpose;
  tone: AiTone;
  item: { type: 'PRODUCT' | 'SERVICE'; id: string } | null;
  /** Marketing angle chosen by the orchestrator from the strategy/analysis (step 4). */
  angle: { name: string; hook?: string; description?: string } | null;
  brandVoice: string | null;
}

export const contentCreator: AgentDefinition<ContentInput, typeof contentSchema> = {
  agent: 'CONTENT_CREATOR',
  task: 'CONTENT',
  promptVersion: 'content-creator@1',
  schemaName: 'marketing_content',
  schema: contentSchema,
  defaultTemperature: 0.8,
  system: (i) => {
    const rule = FORMAT_RULES[i.format];
    const limits = [
      `caption ≤ ${rule.maxCaptionChars} characters`,
      rule.maxTitleChars && `title ≤ ${rule.maxTitleChars} characters`,
      rule.maxDescriptionChars && `description ≤ ${rule.maxDescriptionChars} characters`,
      `at most ${rule.maxHashtags} hashtags (each starting with #, no spaces)`,
      rule.slides && `${rule.slides.min}–${rule.slides.max} slides`,
      rule.storyFrames && `${rule.storyFrames.min}–${rule.storyFrames.max} story frames`,
      rule.durationSeconds && `scenes totalling ${rule.durationSeconds.min}–${rule.durationSeconds.max} seconds, ordered 1..n`,
    ]
      .filter(Boolean)
      .join('; ');
    return `You are the TOUMA AI Content Creator, an expert social media copywriter.
Write ONE ${i.format} (${rule.platform ?? 'any channel'}) for the business in <business_data>.
Format guidance: ${rule.guidance}
Required sections: ${rule.requires.join(', ')}. Leave unused sections empty ([] or null).
Platform limits: ${limits}.
Purpose: ${i.purpose}. Tone: ${i.tone}.${i.brandVoice ? ' Respect the brand voice given in the data.' : ''}
List every factual statement in "claims" with its source id. Prefer benefits over features, be specific with verified facts, and end with a clear call to action that does not invent contact details or offers.
Write everything (including hashtags where natural) in ${AI_LANGUAGE_NAMES[i.language]}.`;
  },
  taskParams: (i) => ({
    task: 'CONTENT',
    language: i.language,
    platform: FORMAT_RULES[i.format].platform,
    format: i.format,
    purpose: i.purpose,
    tone: i.tone,
    item: i.item,
    angle: i.angle,
  }),
  scopeContext: (ctx: BusinessContext, i) => {
    if (!i.item) return { business: ctx.business, products: ctx.products.slice(0, 20), services: ctx.services.slice(0, 20), knowledge: ctx.knowledge };
    const item = (i.item.type === 'PRODUCT' ? ctx.products : ctx.services).find((x) => x.id === i.item!.id) ?? null;
    return { business: ctx.business, item, knowledge: ctx.knowledge };
  },
  validate: (out, _ctx, i) => checkContent(out, { format: i.format, platform: FORMAT_RULES[i.format].platform, language: i.language }),
};
