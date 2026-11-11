import { resolvePricing } from './pricing';
import { estimateCostUsd } from './provider';

const table = { 'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 }, 'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 } };
const none = { inputPerMillion: 0, outputPerMillion: 0 };

describe('model pricing', () => {
  it('matches the longest model prefix, including dated snapshots', () => {
    expect(resolvePricing('gpt-4o-mini-2024-07-18', table, none)).toMatchObject({ source: 'model', matched: 'gpt-4o-mini' });
    expect(resolvePricing('gpt-4o-2024-08-06', table, none)).toMatchObject({ source: 'model', matched: 'gpt-4o' });
    expect(resolvePricing('fake:gpt-4o-mini', table, none).matched).toBe('gpt-4o-mini');
  });
  it('falls back to the flat prices, then to "not configured"', () => {
    expect(resolvePricing('other', table, { inputPerMillion: 1, outputPerMillion: 2 })).toMatchObject({ source: 'default', pricing: { inputPerMillion: 1 } });
    expect(resolvePricing('other', table, none).source).toBe('none');
    expect(resolvePricing('x', {}, none).source).toBe('none');
  });
  it('computes cost from input and output tokens separately', () => {
    const { pricing } = resolvePricing('gpt-4o-mini', table, none);
    expect(estimateCostUsd(1_000_000, 0, pricing)).toBeCloseTo(0.15);
    expect(estimateCostUsd(0, 1_000_000, pricing)).toBeCloseTo(0.6);
    expect(estimateCostUsd(2000, 500, pricing)).toBeCloseTo(0.0006, 6);
  });
});
