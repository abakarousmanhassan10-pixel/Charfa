import { BadRequestException } from '@nestjs/common';
import { evaluateCondition, validateCondition, type ConditionContext } from './workflow-conditions';

const ctx: ConditionContext = {
  input: { channel: 'instagram', qty: 5, vip: true, note: 'Autumn collection' },
  trigger: { price: 150 },
  steps: { analyze: { output: { score: 72 } }, skipped: { output: null } },
};
const ev = (c: unknown) => evaluateCondition(validateCondition(c), ctx);

describe('workflow conditions: validation', () => {
  it('accepts the documented shapes', () => {
    expect(() => validateCondition({ field: 'input.channel', op: 'eq', value: 'x' })).not.toThrow();
    expect(() => validateCondition({ all: [{ field: 'trigger.price', op: 'gte', value: 1 }, { not: { field: 'input.vip', op: 'exists' } }] })).not.toThrow();
    expect(() => validateCondition({ any: [{ field: 'steps.analyze.output.score', op: 'in', value: [1, 2] }] })).not.toThrow();
  });

  it('refuses everything outside the format: no code, no unknown places, no prototype keys', () => {
    const bad: unknown[] = [
      null, 'x', [], {}, { field: 'input.a' }, { field: 'input.a', op: 'eq' }, { field: 'input.a', op: 'eq', value: 1, extra: true },
      { field: 'env.PATH', op: 'exists' }, { field: 'input', op: 'exists' }, { field: 'input.a.b', op: 'exists' }, { field: 'input.__proto__', op: 'exists' },
      { field: 'trigger.constructor', op: 'exists' }, { field: 'steps.a.output.prototype', op: 'exists' }, { field: 'steps.a.input.x', op: 'exists' },
      { field: 'input.a', op: 'regex', value: '.*' }, { field: 'input.a', op: 'eq', value: { nested: 1 } }, { field: 'input.a', op: 'eq', value: 'a'.repeat(101) },
      { field: 'input.a', op: 'gt', value: 'text' }, { field: 'input.a', op: 'contains', value: 5 }, { field: 'input.a', op: 'in', value: 1 }, { field: 'input.a', op: 'eq', value: [1] },
      { field: 'input.a', op: 'exists', value: 1 }, { all: [] }, { all: 'x' }, { all: [{ field: 'input.a', op: 'exists' }], any: [] }, { not: [] },
      { constructor: 'x' }, { $eval: 'process.exit()' },
    ];
    for (const c of bad) expect(() => validateCondition(c)).toThrow(BadRequestException);
  });

  it('bounds depth and size', () => {
    const leaf = { field: 'input.a', op: 'exists' };
    expect(() => validateCondition({ all: [{ all: [{ all: [leaf] }] }] })).not.toThrow();
    expect(() => validateCondition({ all: [{ all: [{ all: [{ all: [leaf] }] }] }] })).toThrow(/nested/);
    expect(() => validateCondition({ all: Array.from({ length: 11 }, () => leaf) })).toThrow(BadRequestException);
    expect(() => validateCondition({ all: [{ all: Array.from({ length: 6 }, () => leaf) }, { all: Array.from({ length: 6 }, () => leaf) }] })).toThrow(/at most 10/);
  });
});

describe('workflow conditions: evaluation', () => {
  it('compares input, trigger and earlier step outputs', () => {
    expect(ev({ field: 'input.channel', op: 'eq', value: 'instagram' })).toBe(true);
    expect(ev({ field: 'input.channel', op: 'neq', value: 'instagram' })).toBe(false);
    expect(ev({ field: 'input.qty', op: 'gt', value: 4 })).toBe(true);
    expect(ev({ field: 'input.qty', op: 'lte', value: 4 })).toBe(false);
    expect(ev({ field: 'trigger.price', op: 'gte', value: 150 })).toBe(true);
    expect(ev({ field: 'steps.analyze.output.score', op: 'lt', value: 80 })).toBe(true);
    expect(ev({ field: 'input.channel', op: 'in', value: ['x', 'instagram'] })).toBe(true);
    expect(ev({ field: 'input.note', op: 'contains', value: 'Autumn' })).toBe(true);
    expect(ev({ field: 'input.vip', op: 'eq', value: true })).toBe(true);
    expect(ev({ all: [{ field: 'input.vip', op: 'exists' }, { any: [{ field: 'input.qty', op: 'eq', value: 1 }, { not: { field: 'input.qty', op: 'eq', value: 2 } }] }] })).toBe(true);
  });

  it('treats missing fields as unknown, never as an error, and ignores inherited properties', () => {
    expect(ev({ field: 'input.missing', op: 'eq', value: 'x' })).toBe(false);
    expect(ev({ field: 'input.missing', op: 'gt', value: 1 })).toBe(false);
    expect(ev({ field: 'input.missing', op: 'exists' })).toBe(false);
    expect(ev({ field: 'input.missing', op: 'neq', value: 'x' })).toBe(true);
    expect(ev({ field: 'input.toString', op: 'exists' })).toBe(false); // not an own property
    expect(ev({ field: 'steps.skipped.output.score', op: 'exists' })).toBe(false);
    expect(ev({ field: 'steps.unknown.output.score', op: 'exists' })).toBe(false);
  });

  it('a string that looks like code is only ever compared, never executed', () => {
    const marker = { ran: false };
    (globalThis as Record<string, unknown>).__touma_marker = marker;
    expect(ev({ field: 'input.note', op: 'eq', value: '${globalThis.__touma_marker.ran = true}' })).toBe(false);
    expect(ev({ field: 'input.note', op: 'contains', value: 'process.exit(1)' })).toBe(false);
    expect(marker.ran).toBe(false);
  });
});
