import { AI_LANGUAGE_NAMES, FORMAT_RULES, type AiLanguage, type AiPlatform } from '@touma/shared';
import { marketingStrategySchema } from '../schemas';
import type { AgentDefinition } from './types';

export interface StrategyInput {
  language: AiLanguage;
  platforms: AiPlatform[];
  goal: string | null;
  focusItems: string[];
  /** Summary of a previous business analysis, if available (orchestrator step 2). */
  businessProfile: unknown;
}

export const marketingStrategist: AgentDefinition<StrategyInput, typeof marketingStrategySchema> = {
  agent: 'MARKETING_STRATEGIST',
  task: 'MARKETING_STRATEGY',
  promptVersion: 'marketing-strategist@1',
  schemaName: 'marketing_strategy',
  schema: marketingStrategySchema,
  defaultTemperature: 0.6,
  system: ({ language }) =>
    `You are the TOUMA AI Marketing Strategist. Build a practical social media strategy for the business in <business_data>, adapted to its industry, market and resources.
For each requested platform: objective, audience, 2–6 content pillars, recommended formats (only formats valid for that platform), posting frequency recommendation, a weekly plan, and KPIs to track (metrics to observe, not promised results).
Add campaign concepts, a 4-week monthly plan, promotional ideas and calls to action.
Promotions must not state discounts, prices or offers that are not in the data: suggest them as ideas for the business to decide ("consider offering…").
Never promise results (no "increase sales by X%").
Write every text value in ${AI_LANGUAGE_NAMES[language]}.`,
  taskParams: (i) => ({
    task: 'MARKETING_STRATEGY',
    language: i.language,
    platforms: i.platforms,
    goal: i.goal,
    focusItems: i.focusItems,
    validFormats: Object.fromEntries(i.platforms.map((p) => [p, Object.entries(FORMAT_RULES).filter(([, r]) => r.platform === p || r.platform === null).map(([f]) => f)])),
    businessProfile: i.businessProfile,
  }),
  validate: (out, ctx, input) => {
    const issues: string[] = [];
    const got = out.platforms.map((p) => p.platform).sort();
    if (JSON.stringify(got) !== JSON.stringify([...input.platforms].sort())) issues.push(`platforms must be exactly: ${input.platforms.join(', ')}`);
    for (const p of out.platforms) {
      for (const f of [...p.recommendedFormats, ...p.weeklyPlan.map((w) => w.format)]) {
        const owner = FORMAT_RULES[f].platform;
        if (owner !== null && owner !== p.platform) issues.push(`${f} is not a ${p.platform} format`);
      }
    }
    for (const c of out.campaigns) {
      if (c.platforms.some((p) => !input.platforms.includes(p))) issues.push(`campaign "${c.name}" uses a platform that was not requested`);
    }
    const weeks = out.monthlyPlan.map((w) => w.week);
    if (weeks.some((w, i) => w !== i + 1)) issues.push('monthlyPlan weeks must be numbered 1..n');
    void ctx;
    return [...new Set(issues)];
  },
};
