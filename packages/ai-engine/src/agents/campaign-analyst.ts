import { AI_LANGUAGE_NAMES, type AiLanguage } from '@touma/shared';
import { campaignAnalysisSchema } from '../schemas';
import type { AgentDefinition } from './types';

/** What TOUMA already measured for a campaign (computed by the platform, not by the model). */
export interface CampaignReport {
  evidence: 'REAL' | 'SIMULATED_ONLY' | 'NONE';
  counts: { real: number; simulated: number; unavailable: number };
  summary: string;
  bestEngagementRate: number | null;
  recommendations: string[];
  caveat: string;
}
export interface CampaignAnalysisInput {
  language: AiLanguage;
  campaign: { name: string; goal: string | null; status: string };
  report: CampaignReport;
}

/** Every number written in the answer must be one of the numbers supplied. */
const numbersIn = (v: unknown): string[] => (JSON.stringify(v).match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', '.'));
const CAUSAL = /\b(sales|revenue|orders?|profit)\b.{0,40}\b(increased|grew|rose|went up|were generated|came from|due to|because of)\b|\b(because of|thanks to|caused by)\b.{0,30}\b(this|the) campaign\b|\bROI\b|\bguarantee/i;
const MORE_SPEND = /\b(increase|raise|boost|double|scale up|spend more|invest more)\b.{0,40}\b(ad|ads|advertising|marketing|promotion)\b.{0,20}\b(budget|spend|spending)?/i;

export const campaignAnalyst: AgentDefinition<CampaignAnalysisInput, typeof campaignAnalysisSchema> = {
  agent: 'PERFORMANCE_ANALYST',
  task: 'CAMPAIGN_ANALYSIS',
  promptVersion: 'campaign-analyst@1',
  schemaName: 'campaign_analysis',
  schema: campaignAnalysisSchema,
  defaultTemperature: 0.2,
  system: ({ language }) =>
    `You are the TOUMA AI Campaign Analyst. Explain, in plain words for a merchant, what the measured results of ONE campaign (in <business_data>.performance) show.
Rules:
- Use ONLY the figures in performance. Never write a number that is not there. Do not write percentages.
- Keep real, simulated and unavailable measurements apart. If evidence is SIMULATED_ONLY say clearly that the data comes from a simulator and is not market feedback. Unavailable is unknown, never zero.
- Never claim sales, revenue, orders or profit results, and never claim the campaign caused anything: engagement is not a sales result.
- Never recommend spending more on advertising, changing a price, or issuing a refund. Recommendations are small, organic, reversible steps, and each one needs the merchant's approval (needsMerchantApproval true).
- Copy "evidence" exactly from performance.evidence. Mention what is missing or uncertain in caveats.
Write every text value in ${AI_LANGUAGE_NAMES[language]}.`,
  taskParams: (i) => ({ task: 'CAMPAIGN_ANALYSIS', language: i.language }),
  // Least data necessary: the business name, the campaign and the report. No customer data, no costs.
  scopeContext: (ctx, i) => ({ business: { name: ctx.business.name }, campaign: i.campaign, performance: i.report }),
  validate: (out, _ctx, i) => {
    const issues: string[] = [];
    if (out.evidence !== i.report.evidence) issues.push(`evidence must be ${i.report.evidence}`);
    const allowed = new Set(numbersIn(i.report).concat(numbersIn(i.campaign)));
    const text = [out.summary, ...out.observations.map((o) => o.text), ...out.recommendations.map((r) => r.text), ...out.caveats].join('\n');
    for (const n of numbersIn(text)) if (!allowed.has(n)) issues.push(`the figure ${n} is not in the performance data`);
    if (/%/.test(text)) issues.push('do not write percentages');
    if (CAUSAL.test(text)) issues.push('do not claim sales results, causes, ROI or guarantees');
    if (out.recommendations.some((r) => MORE_SPEND.test(r.text))) issues.push('a recommendation must not propose spending more on advertising');
    if (out.recommendations.some((r) => !r.needsMerchantApproval)) issues.push('every recommendation needs merchant approval');
    if (i.report.evidence === 'SIMULATED_ONLY' && !/simulat/i.test(text)) issues.push('say that the data is simulated');
    return issues;
  },
};
