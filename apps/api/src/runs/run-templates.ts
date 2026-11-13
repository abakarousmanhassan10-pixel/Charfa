import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

/** One step of a plan. Plans are defined here, in code: a caller can pick a template but never submits its own steps. */
export interface RunStepPlan {
  key: string;
  adapter: string;
  dependsOn: string[];
  /** Must be true for every step whose adapter acts outside TOUMA. Enforced when a run is created and again when a step is claimed. */
  requiresApproval: boolean;
}

export interface RunTemplate {
  name: string;
  version: number;
  steps: RunStepPlan[];
  /** Strict validation of the caller's input. Returns the cleaned input; anything unexpected is refused. */
  parseInput(input: unknown): Record<string, unknown>;
}

export const MAX_STEPS_PER_RUN = 10;
export const TOPIC_MAX = 200;

function parseTopicInput(input: unknown): Record<string, unknown> {
  const bad = (message: string) => new BadRequestException({ code: 'INVALID_RUN_INPUT', message });
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('input must be an object');
  const keys = Object.keys(input);
  if (keys.some((k) => k !== 'topic')) throw bad('input only accepts "topic"');
  const topic = (input as { topic?: unknown }).topic;
  if (typeof topic !== 'string') throw bad('topic is required');
  const clean = topic.trim().replace(/\s+/g, ' ');
  // eslint-disable-next-line no-control-regex
  if (clean.length < 1 || clean.length > TOPIC_MAX || /[\u0000-\u001f\u007f]/.test(clean)) throw bad(`topic must be 1-${TOPIC_MAX} printable characters`);
  return { topic: clean };
}

/**
 * Phase N2 template: an analysis, a draft, then a (simulated) outward action that needs a human approval.
 * Every adapter is a simulation: no model is called and nothing leaves TOUMA.
 */
export const RUN_TEMPLATES: Readonly<Record<string, RunTemplate>> = {
  'simulated-content-launch': {
    name: 'simulated-content-launch',
    version: 1,
    steps: [
      { key: 'analyze', adapter: 'simulated.analyze', dependsOn: [], requiresApproval: false },
      { key: 'draft', adapter: 'simulated.draft', dependsOn: ['analyze'], requiresApproval: false },
      { key: 'publish', adapter: 'simulated.external-action', dependsOn: ['draft'], requiresApproval: true },
    ],
    parseInput: parseTopicInput,
  },
};

export const RUN_TEMPLATE_NAMES = Object.keys(RUN_TEMPLATES);

/** Rejects a malformed plan (duplicate or unknown keys, cycles, too many steps) and unapproved external steps. */
export function assertPlan(template: RunTemplate, isExternal: (adapter: string) => boolean | undefined): void {
  const fail = (m: string) => new Error(`Invalid run template ${template.name}: ${m}`);
  const keys = template.steps.map((s) => s.key);
  if (template.steps.length === 0 || template.steps.length > MAX_STEPS_PER_RUN) throw fail('step count out of range');
  if (new Set(keys).size !== keys.length) throw fail('duplicate step key');
  for (const s of template.steps) {
    if (s.dependsOn.some((d) => !keys.includes(d) || d === s.key)) throw fail(`step ${s.key} has an invalid dependency`);
    const external = isExternal(s.adapter);
    if (external === undefined) throw fail(`unknown adapter ${s.adapter}`);
    if (external && !s.requiresApproval) throw fail(`step ${s.key} acts outside TOUMA and must require approval`);
  }
  // Cycle check: repeatedly remove steps whose dependencies are all removed.
  const left = new Map(template.steps.map((s) => [s.key, new Set(s.dependsOn)]));
  while (left.size) {
    const free = [...left].filter(([, d]) => d.size === 0).map(([k]) => k);
    if (!free.length) throw fail('dependency cycle');
    for (const k of free) left.delete(k);
    for (const d of left.values()) free.forEach((k) => d.delete(k));
  }
}

/** Stable digest of a request, to tell a safe replay from an idempotency key reused with different content. */
export function hashRequest(template: RunTemplate, input: Record<string, unknown>): string {
  const canonical = JSON.stringify({ t: template.name, v: template.version, i: Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) });
  return createHash('sha256').update(canonical).digest('hex');
}
