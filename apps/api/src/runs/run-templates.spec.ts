import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrchestratorEnabledGuard } from './runs.guard';
import { RUN_TEMPLATES, TOPIC_MAX, assertPlan, hashRequest, type RunTemplate } from './run-templates';
import type { AppEnv } from '../config';

const external = (a: string) => (a === 'x.out' ? true : a.startsWith('x.') ? false : undefined);
const tpl = (steps: RunTemplate['steps']): RunTemplate => ({ name: 't', version: 1, steps, parseInput: (i) => i as Record<string, unknown> });
const step = (key: string, dependsOn: string[] = [], adapter = 'x.in', requiresApproval = false) => ({ key, adapter, dependsOn, requiresApproval });

describe('run templates', () => {
  const t = RUN_TEMPLATES['simulated-content-launch']!;

  it('the shipped template is a valid plan and its outward step requires approval', () => {
    expect(() => assertPlan(t, (a) => (a === 'simulated.external-action' ? true : a.startsWith('simulated.') ? false : undefined))).not.toThrow();
    expect(t.steps.find((s) => s.adapter === 'simulated.external-action')?.requiresApproval).toBe(true);
  });

  it('refuses malformed plans: duplicates, unknown or self dependencies, cycles, unknown adapters, unapproved outward steps', () => {
    expect(() => assertPlan(tpl([step('a'), step('a')]), external)).toThrow(/duplicate/);
    expect(() => assertPlan(tpl([step('a', ['zz'])]), external)).toThrow(/dependency/);
    expect(() => assertPlan(tpl([step('a', ['a'])]), external)).toThrow(/dependency/);
    expect(() => assertPlan(tpl([step('a', ['b']), step('b', ['a'])]), external)).toThrow(/cycle/);
    expect(() => assertPlan(tpl([step('a', [], 'nope')]), external)).toThrow(/unknown adapter/);
    expect(() => assertPlan(tpl([step('a', [], 'x.out', false)]), external)).toThrow(/must require approval/);
    expect(() => assertPlan(tpl([step('a', [], 'x.out', true)]), external)).not.toThrow();
    expect(() => assertPlan(tpl([]), external)).toThrow(/step count/);
  });

  it('validates the input strictly and normalises the topic', () => {
    expect(t.parseInput({ topic: '  Autumn   launch ' })).toEqual({ topic: 'Autumn launch' });
    for (const bad of [null, [], 'x', {}, { topic: 1 }, { topic: '   ' }, { topic: 'a'.repeat(TOPIC_MAX + 1) }, { topic: 'a\u0000b' }, { topic: 'ok', extra: 1 }]) {
      expect(() => t.parseInput(bad)).toThrow(BadRequestException);
    }
  });

  it('hashes equal requests equally and different ones differently', () => {
    expect(hashRequest(t, { topic: 'a' })).toBe(hashRequest(t, { topic: 'a' }));
    expect(hashRequest(t, { topic: 'a' })).not.toBe(hashRequest(t, { topic: 'b' }));
  });
});

describe('OrchestratorEnabledGuard (feature flag)', () => {
  it('hides the endpoints unless ORCHESTRATOR_ENABLED', () => {
    expect(() => new OrchestratorEnabledGuard({ ORCHESTRATOR_ENABLED: false } as AppEnv).canActivate()).toThrow(NotFoundException);
    expect(new OrchestratorEnabledGuard({ ORCHESTRATOR_ENABLED: true } as AppEnv).canActivate()).toBe(true);
  });
});
