import { AI_LANGUAGE_NAMES, VIDEO_FORMATS, type AiLanguage, type AiTone, type VideoFormat, type VideoStyle } from '@touma/shared';
import type { BusinessContext } from '../context';
import { checkFactPreservation } from '../grounding';
import { storyboardSchema } from '../schemas';
import { checkStoryboard } from '../validation';
import type { AgentDefinition } from './types';

export interface StoryboardInput {
  language: AiLanguage;
  format: VideoFormat;
  seconds: number;
  style: VideoStyle;
  tone: AiTone;
  item: { type: 'PRODUCT' | 'SERVICE'; id: string } | null;
  angle: { name: string; hook?: string; description?: string } | null;
  brandVoice: string | null;
  /** The business's brand kit, applied to the visuals and the voice. */
  brand: { visualStyle: string | null; guidelines: string | null; colors: string[] } | null;
}

export const storyboardCreator: AgentDefinition<StoryboardInput, typeof storyboardSchema> = {
  agent: 'VIDEO_CREATOR',
  task: 'STORYBOARD',
  promptVersion: 'storyboard-creator@1',
  schemaName: 'video_storyboard',
  schema: storyboardSchema,
  defaultTemperature: 0.7,
  system: (i) => {
    const rule = VIDEO_FORMATS[i.format];
    return `You are the TOUMA AI Video Director, an expert in short promotional video.
Create a script and storyboard for ONE ${i.seconds}-second ${i.format} video (${rule.aspect}) for the business in <business_data>.
Visual style: ${i.style}. Tone: ${i.tone}.${i.brandVoice ? ' Respect the brand voice given in the data.' : ''}${i.brand ? ' Follow the brand kit in the task (colours, visual style, guidelines).' : ''}
Structure: a hook in the first 2 seconds, scenes that each show something concrete and filmable, and a clear call to action at the end.
Use 3 to 6 scenes, numbered 1..n, whose durations add up to about ${i.seconds} seconds; totalSeconds must equal that sum.
For every scene give: the visual (what the camera sees), camera movement, voiceover (or null), on-screen text (or null), audio, and what part of the product is in focus.
"videoPrompt" is ONE paragraph describing the visuals scene by scene, suitable as the prompt of a video generation model. It must not contain prices or claims.
List every factual statement in "claims" with its source id. Show the product only as described in the data; never invent features, prices, offers, results or testimonials. If something needed is missing, list it in "missingInformation".
Write everything in ${AI_LANGUAGE_NAMES[i.language]}.`;
  },
  taskParams: (i) => ({
    task: 'STORYBOARD',
    language: i.language,
    format: i.format,
    aspectRatio: VIDEO_FORMATS[i.format].aspect,
    seconds: i.seconds,
    style: i.style,
    tone: i.tone,
    item: i.item,
    angle: i.angle,
    brand: i.brand,
  }),
  scopeContext: (ctx: BusinessContext, i) => {
    if (!i.item) return { business: ctx.business, products: ctx.products.slice(0, 20), services: ctx.services.slice(0, 20), knowledge: ctx.knowledge };
    const item = (i.item.type === 'PRODUCT' ? ctx.products : ctx.services).find((x) => x.id === i.item!.id) ?? null;
    return { business: ctx.business, item, knowledge: ctx.knowledge };
  },
  validate: (out, ctx, i) => [...checkStoryboard(out, { format: i.format, seconds: i.seconds, language: i.language }), ...checkFactPreservation(out, ctx, i.item)],
};
