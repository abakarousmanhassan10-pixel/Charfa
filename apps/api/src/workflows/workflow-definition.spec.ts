import { BadRequestException } from '@nestjs/common';
import { MAX_STEPS, parseExecutionInput, parseWorkflowDefinition, sanitizeEventPayload } from './workflow-definition';
import { WorkflowsEnabledGuard } from './workflows.guard';
import type { AppEnv } from '../config';

const rules = { isExternal: (a: string) => (a === 'x.out' ? true : a.startsWith('x.') ? false : undefined), minScheduleMinutes: 15 };
const step = (key: string, extra: Record<string, unknown> = {}) => ({ key, adapter: 'x.in', ...extra });
const doc = (over: Record<string, unknown> = {}) => ({ triggers: [{ type: 'manual' }], steps: [step('a')], ...over });
const parse = (d: unknown) => parseWorkflowDefinition(d, rules);

describe('workflow definition', () => {
  it('accepts a full definition and fills defaults', () => {
    const d = parse(doc({ input: { topic: { type: 'string', required: true } }, defaultInput: { topic: 't' }, steps: [step('a'), step('b', { dependsOn: ['a'], condition: { field: 'input.topic', op: 'exists' }, retry: { maxAttempts: 2, backoffMs: 50 } }), step('c', { adapter: 'x.out', dependsOn: ['b'], requiresApproval: true })] }));
    expect(d.steps.map((s) => s.key)).toEqual(['a', 'b', 'c']);
    expect(d.steps[1]).toMatchObject({ retry: { maxAttempts: 2, backoffMs: 50 }, condition: { field: 'input.topic' } });
  });

  it('refuses anything that is not plain, known data (no code, URLs or extra keys)', () => {
    const bad: unknown[] = [
      null, [], {}, doc({ steps: [] }), doc({ steps: [step('a', { command: 'rm -rf /' })] }), doc({ steps: [step('a', { url: 'https://evil.test' })] }), doc({ script: 'x' }),
      doc({ steps: [step('A')] }), doc({ steps: [step('a'), step('a')] }), doc({ steps: [step('a', { dependsOn: ['zz'] })] }), doc({ steps: [step('a', { dependsOn: ['a'] })] }),
      doc({ steps: [step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })] }), doc({ steps: [step('a', { adapter: 'http.fetch' })] }), doc({ steps: [step('a', { adapter: 'x.out' })] }),
      doc({ steps: [step('a', { retry: { maxAttempts: 9, backoffMs: 50 } })] }), doc({ steps: [step('a', { retry: { maxAttempts: 2, backoffMs: 1 } })] }),
      doc({ steps: [step('a', { condition: { field: 'env.SECRET', op: 'exists' } })] }), doc({ triggers: [] }), doc({ triggers: [{ type: 'webhook' }] }),
      doc({ triggers: [{ type: 'manual' }, { type: 'manual' }] }), doc({ triggers: [{ type: 'event', event: 'user.deleted' }] }), doc({ triggers: [{ type: 'schedule', everyMinutes: 5 }] }),
      doc({ triggers: [{ type: 'schedule', everyMinutes: 0 }] }), doc({ input: { 'Bad-Key': { type: 'string' } } }), doc({ input: { a: { type: 'object' } } }), doc({ defaultInput: { unknown: 'x' } }),
      doc({ steps: Array.from({ length: MAX_STEPS + 1 }, (_, i) => step(`s${i}`)) }),
    ];
    for (const b of bad) expect(() => parse(b)).toThrow(BadRequestException);
  });

  it('an outward step must require approval, whatever the document says', () => {
    expect(() => parse(doc({ steps: [step('a', { adapter: 'x.out', requiresApproval: false })] }))).toThrow(/must require approval/);
    expect(() => parse(doc({ steps: [step('a', { adapter: 'x.out', requiresApproval: true })] }))).not.toThrow();
  });

  it('checks execution input against the input spec', () => {
    const d = { input: { topic: { type: 'string', required: true, maxLength: 10 }, n: { type: 'number' } } } as Parameters<typeof parseExecutionInput>[0];
    expect(parseExecutionInput(d, { topic: ' hi ', n: 3 })).toEqual({ topic: 'hi', n: 3 });
    for (const bad of [{}, { topic: 'x', extra: 1 }, { topic: 5 }, { topic: 'a'.repeat(11) }, { topic: 'a\u0000b' }, { topic: 'x', n: 'z' }, [], 'x']) {
      expect(() => parseExecutionInput(d, bad)).toThrow(BadRequestException);
    }
    expect(() => parseExecutionInput(d, { __proto__: { x: 1 }, topic: 'ok' })).not.toThrow();
  });

  it('reduces an event payload to a few short scalars', () => {
    const p = sanitizeEventPayload({ a: 'x'.repeat(500), b: 1, c: true, d: { nested: 1 }, e: [1], f: NaN, __proto__: 1, 'bad key': 1, constructor: 'x' });
    expect(p).toEqual({ a: 'x'.repeat(200), b: 1, c: true });
    expect(Object.keys(sanitizeEventPayload(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])))).length).toBe(10);
    expect(sanitizeEventPayload('x')).toEqual({});
  });

  it('the workflow feature flag hides the endpoints unless both flags are on', () => {
    const g = (o: Partial<AppEnv>) => () => new WorkflowsEnabledGuard(o as AppEnv).canActivate();
    expect(g({ WORKFLOWS_ENABLED: false, ORCHESTRATOR_ENABLED: true })).toThrow();
    expect(g({ WORKFLOWS_ENABLED: true, ORCHESTRATOR_ENABLED: false })).toThrow();
    expect(g({ WORKFLOWS_ENABLED: true, ORCHESTRATOR_ENABLED: true })()).toBe(true);
  });
});
