import { detectRegression } from './evaluators';
import { improvementCorpus } from './recommendations.service';

describe('improvement corpus (offline evaluation)', () => {
  it('passes at the default limit and at a reasonable limit', () => {
    expect(improvementCorpus(900).passed).toBe(true);
    expect(improvementCorpus(600).passed).toBe(true);
  });
  it('catches a limit tight enough to truncate real wording', () => {
    const base = improvementCorpus(900);
    const tight = improvementCorpus(150);
    expect(tight.passed).toBe(false);
    expect(tight.results.filter((r) => !r.pass).length).toBeGreaterThan(0);
    expect(detectRegression(base, tight).regressed).toBe(true);
  });
});
