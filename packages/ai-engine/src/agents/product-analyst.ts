import { AI_LANGUAGE_NAMES, type AiLanguage } from '@touma/shared';
import type { BusinessContext } from '../context';
import { productAnalysisSchema } from '../schemas';
import type { AgentDefinition } from './types';

export interface ProductAnalysisInput {
  language: AiLanguage;
  itemType: 'PRODUCT' | 'SERVICE';
  itemId: string;
}

const findItem = (ctx: BusinessContext, input: ProductAnalysisInput) =>
  (input.itemType === 'PRODUCT' ? ctx.products : ctx.services).find((i) => i.id === input.itemId);

export const productAnalyst: AgentDefinition<ProductAnalysisInput, typeof productAnalysisSchema> = {
  agent: 'PRODUCT_ANALYST',
  task: 'PRODUCT_ANALYSIS',
  promptVersion: 'product-analyst@1',
  schemaName: 'product_marketing_analysis',
  schema: productAnalysisSchema,
  defaultTemperature: 0.3,
  system: ({ language }) =>
    `You are the TOUMA AI Product Analyst. Analyse ONE product or service (identified in <task>) of the business in <business_data>.
Identify its characteristics and verified benefits (each must cite the source it comes from), the customer problems it addresses, customer segments, commercial positioning, marketing angles, differentiation opportunities, likely objections with suggested responses, and frequently asked questions.
Never invent specifications, ingredients, materials, sizes, prices, stock, delivery or guarantees. An FAQ whose answer is not in the data must have answer null and needsBusinessInput true. An objection whose response needs facts that are missing must set needsBusinessInput true.
Write every text value in ${AI_LANGUAGE_NAMES[language]}.`,
  taskParams: (i) => ({ task: 'PRODUCT_ANALYSIS', language: i.language, item: { type: i.itemType, id: i.itemId } }),
  // Least data necessary: business profile, the item analysed, and verified knowledge.
  scopeContext: (ctx, input) => ({
    business: ctx.business,
    item: findItem(ctx, input) ?? null,
    knowledge: ctx.knowledge,
  }),
  validate: (out, ctx, input) => {
    const issues: string[] = [];
    if (out.item.id !== input.itemId || out.item.type !== input.itemType) issues.push(`item must be ${input.itemType} ${input.itemId}`);
    const own = `${input.itemType === 'PRODUCT' ? 'product' : 'service'}:${input.itemId}`;
    const allowed = new Set(['business', own, ...ctx.knowledge.map((k) => `knowledge:${k.id}`)]);
    for (const x of [...out.characteristics, ...out.verifiedBenefits]) {
      if (!allowed.has(x.source)) issues.push(`"${x.text.slice(0, 40)}" cites ${x.source}; cite the analysed item, the business or a knowledge entry`);
    }
    for (const f of out.faq) {
      if (f.answer && !f.source) issues.push(`FAQ "${f.question.slice(0, 40)}" has an answer without a source`);
      if (!f.answer && !f.needsBusinessInput) issues.push(`FAQ "${f.question.slice(0, 40)}" without answer must set needsBusinessInput`);
    }
    return issues;
  },
};
