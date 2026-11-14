import { campaignAnalyst, type CampaignAnalysisInput } from './agents/campaign-analyst';
import { runAgent, type EngineConfig } from './engine';
import { ctx } from './fixtures.spec-helper';
import { FakeTextProvider, fakeDefaultAnswer } from './testing/fake-provider';

const config: EngineConfig = { model: 'm', maxOutputTokens: 2000, timeoutMs: 5000, maxProviderRetries: 0, maxRepairAttempts: 0 };
const sleep = async () => undefined;
const input = (over: Partial<CampaignAnalysisInput['report']> = {}): CampaignAnalysisInput => ({
  language: 'en', campaign: { name: 'Launch', goal: 'LAUNCH', status: 'ACTIVE' },
  report: { evidence: 'SIMULATED_ONLY', counts: { real: 0, simulated: 2, unavailable: 1 }, summary: '0 real, 2 simulated and 1 unavailable measurement(s).', bestEngagementRate: 0.05, recommendations: [], caveat: 'No sales impact is claimed.', ...over },
});
const good = { summary: 'The 2 measured posts come from a simulator and are not market feedback.', evidence: 'SIMULATED_ONLY', observations: [{ text: '2 simulated and 1 unavailable measurement(s); the unavailable one is unknown, not zero.', basedOn: 'performance.counts' }], recommendations: [{ text: 'Prepare one follow-up draft and send it for approval.', needsMerchantApproval: true }], caveats: ['Engagement is not a sales result.'] };
const run = (answer: unknown, i = input()) => {
  const p = new FakeTextProvider();
  p.enqueue(JSON.stringify(answer));
  return runAgent(campaignAnalyst, { provider: p, context: ctx(), input: i, config, sleep });
};

describe('campaign analyst (grounded in the platform report)', () => {
  it('accepts an answer that only uses the supplied figures and keeps simulated data labelled', async () => {
    expect((await run(good)).output.evidence).toBe('SIMULATED_ONLY');
  });
  it('the default test answer is valid for every evidence level', async () => {
    for (const evidence of ['REAL', 'SIMULATED_ONLY', 'NONE'] as const) {
      const p = new FakeTextProvider();
      const r = await runAgent(campaignAnalyst, { provider: p, context: ctx(), input: input({ evidence, counts: { real: evidence === 'REAL' ? 3 : 0, simulated: evidence === 'SIMULATED_ONLY' ? 2 : 0, unavailable: 0 } }), config, sleep });
      expect(r.output.evidence).toBe(evidence);
    }
    expect(Object.keys(fakeDefaultAnswer({ system: '', user: '<business_data>\n{}\n</business_data>\n<task>\n{}\n</task>', schemaName: 'campaign_analysis', jsonSchema: {}, model: 'm', maxOutputTokens: 1, timeoutMs: 1 }))).toContain('observations');
  });
  it.each([
    ['an invented figure', { ...good, observations: [{ text: '37 posts were published.', basedOn: 'x' }] }, /figure 37/],
    ['a percentage', { ...good, summary: 'Engagement is good, a rate of 5% was reached.' }, /percentages|figure/],
    ['a sales claim', { ...good, summary: 'The 2 posts show that sales increased because of the campaign (simulated).' }, /sales results/],
    ['an ROI claim', { ...good, caveats: ['The ROI is excellent (simulated).'] }, /sales results|ROI/],
    ['a request to spend more on ads', { ...good, recommendations: [{ text: 'Increase your advertising budget this week.', needsMerchantApproval: true }] }, /spending more/],
    ['a recommendation without approval', { ...good, recommendations: [{ text: 'Post again tomorrow.', needsMerchantApproval: false }] }, /merchant approval/],
    ['the wrong evidence level', { ...good, evidence: 'REAL' }, /evidence must be SIMULATED_ONLY/],
    ['simulated data presented as real', { ...good, summary: 'The 2 posts reached their audience well.', observations: [], caveats: [] }, /simulated/],
  ])('rejects %s', async (_name, answer, pattern) => {
    await expect(run(answer)).rejects.toThrow(pattern);
  });
});
