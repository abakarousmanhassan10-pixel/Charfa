import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { type Condition, validateCondition } from './workflow-conditions';

/**
 * A workflow definition is a validated JSON document: triggers, an input specification and steps with dependencies, a
 * restricted condition and a retry policy. It names adapters from a fixed registry; it can never contain code, URLs or secrets.
 */
export const MAX_STEPS = 10;
export const MAX_INPUT_KEYS = 10;
export const MAX_STRING = 500;
const KEY = /^[a-z][a-z0-9_]{0,30}$/;
const EVENT_TYPES = ['product.created', 'product.updated', 'workflow.execution.completed', 'workflow.execution.failed'] as const;
export const WORKFLOW_EVENT_TYPES = EVENT_TYPES;
export type WorkflowEventType = (typeof EVENT_TYPES)[number];

const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }).strict(),
  z.object({ type: z.literal('schedule'), everyMinutes: z.number().int().min(1).max(10_080) }).strict(),
  z.object({ type: z.literal('event'), event: z.enum(EVENT_TYPES), condition: z.unknown().optional() }).strict(),
]);

const inputSpecSchema = z.object({ type: z.enum(['string', 'number', 'boolean']), required: z.boolean().optional(), maxLength: z.number().int().min(1).max(MAX_STRING).optional() }).strict();

const stepSchema = z
  .object({
    key: z.string().regex(KEY),
    adapter: z.string().min(3).max(60),
    dependsOn: z.array(z.string().regex(KEY)).max(MAX_STEPS).default([]),
    requiresApproval: z.boolean().default(false),
    condition: z.unknown().optional(),
    retry: z.object({ maxAttempts: z.number().int().min(1).max(5), backoffMs: z.number().int().min(10).max(3_600_000) }).strict().optional(),
  })
  .strict();

const definitionSchema = z
  .object({
    description: z.string().max(300).optional(),
    triggers: z.array(triggerSchema).min(1).max(3),
    input: z.record(z.string().regex(KEY), inputSpecSchema).default({}),
    defaultInput: z.record(z.string().regex(KEY), z.union([z.string().max(MAX_STRING), z.number().finite(), z.boolean()])).default({}),
    steps: z.array(stepSchema).min(1).max(MAX_STEPS),
  })
  .strict();

export type InputSpec = z.infer<typeof inputSpecSchema>;
export interface WorkflowStepDef {
  key: string;
  adapter: string;
  dependsOn: string[];
  requiresApproval: boolean;
  condition?: Condition;
  retry?: { maxAttempts: number; backoffMs: number };
}
export interface WorkflowTrigger {
  type: 'manual' | 'schedule' | 'event';
  everyMinutes?: number;
  event?: WorkflowEventType;
  condition?: Condition;
}
export interface WorkflowDoc {
  description?: string;
  triggers: WorkflowTrigger[];
  input: Record<string, InputSpec>;
  defaultInput: Record<string, string | number | boolean>;
  steps: WorkflowStepDef[];
}

const bad = (message: string, code = 'INVALID_WORKFLOW') => new BadRequestException({ code, message });

export interface DefinitionRules {
  /** true = the adapter acts outside TOUMA, false = internal, undefined = unknown adapter. */
  isExternal: (adapter: string) => boolean | undefined;
  minScheduleMinutes: number;
}

/** Validates a definition end to end. Throws a 400 with a code and a short message; never echoes the document back. */
export function parseWorkflowDefinition(raw: unknown, rules: DefinitionRules): WorkflowDoc {
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw bad(`Invalid workflow definition: ${first ? `${first.path.join('.') || '(root)'} ${first.message}` : 'unknown error'}`.slice(0, 200));
  }
  const d = parsed.data;
  const keys = d.steps.map((s) => s.key);
  if (new Set(keys).size !== keys.length) throw bad('Duplicate step key');
  if (d.triggers.filter((t) => t.type === 'manual').length > 1 || new Set(d.triggers.map((t) => t.type + (t.type === 'event' ? t.event : ''))).size !== d.triggers.length) throw bad('Duplicate trigger');
  if (Object.keys(d.input).length > MAX_INPUT_KEYS) throw bad(`At most ${MAX_INPUT_KEYS} input fields`);

  const triggers: WorkflowTrigger[] = d.triggers.map((t) => {
    if (t.type === 'schedule' && t.everyMinutes < rules.minScheduleMinutes) throw bad(`A schedule must repeat at most every ${rules.minScheduleMinutes} minutes`);
    return t.type === 'event' ? { type: 'event', event: t.event, ...(t.condition !== undefined ? { condition: validateCondition(t.condition) } : {}) } : (t as WorkflowTrigger);
  });

  const steps: WorkflowStepDef[] = d.steps.map((s) => {
    const external = rules.isExternal(s.adapter);
    if (external === undefined) throw bad(`Unknown adapter "${s.adapter}"`, 'UNKNOWN_ADAPTER');
    // Sensitive actions cannot be defined without a human in the loop, whatever the document says.
    if (external && !s.requiresApproval) throw bad(`Step "${s.key}" acts outside TOUMA and must require approval`, 'APPROVAL_REQUIRED');
    if (s.dependsOn.some((x) => !keys.includes(x) || x === s.key)) throw bad(`Step "${s.key}" has an invalid dependency`);
    return { key: s.key, adapter: s.adapter, dependsOn: s.dependsOn, requiresApproval: s.requiresApproval, ...(s.condition !== undefined ? { condition: validateCondition(s.condition) } : {}), ...(s.retry ? { retry: s.retry } : {}) };
  });
  const left = new Map(steps.map((s) => [s.key, new Set(s.dependsOn)]));
  while (left.size) {
    const free = [...left].filter(([, deps]) => deps.size === 0).map(([k]) => k);
    if (!free.length) throw bad('Dependency cycle');
    for (const k of free) left.delete(k);
    for (const deps of left.values()) free.forEach((k) => deps.delete(k));
  }
  const doc: WorkflowDoc = { ...(d.description ? { description: d.description } : {}), triggers, input: d.input, defaultInput: d.defaultInput, steps };
  parseExecutionInput(doc, doc.defaultInput, { partial: true });
  return doc;
}

/** Validates an execution input against the workflow's input spec: known keys only, right types, bounded strings. */
export function parseExecutionInput(doc: Pick<WorkflowDoc, 'input'>, input: unknown, opts: { partial?: boolean } = {}): Record<string, string | number | boolean> {
  const err = (m: string) => new BadRequestException({ code: 'INVALID_RUN_INPUT', message: m });
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw err('input must be an object');
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const spec = Object.prototype.hasOwnProperty.call(doc.input, k) ? doc.input[k] : undefined;
    if (!spec) throw err(`unknown input field "${k}"`);
    if (typeof v !== spec.type) throw err(`"${k}" must be a ${spec.type}`);
    if (typeof v === 'string') {
      // eslint-disable-next-line no-control-regex
      if (v.length > (spec.maxLength ?? 200) || /[\u0000-\u001f\u007f]/.test(v)) throw err(`"${k}" is too long or contains control characters`);
    }
    if (typeof v === 'number' && !Number.isFinite(v)) throw err(`"${k}" must be a finite number`);
    out[k] = (typeof v === 'string' ? v.trim() : v) as string | number | boolean;
  }
  if (!opts.partial) for (const [k, spec] of Object.entries(doc.input)) if (spec.required && out[k] === undefined) throw err(`"${k}" is required`);
  return out;
}

/** Scalars of an event payload that conditions can read as `trigger.*`: at most 10 keys, short strings. */
export function sanitizeEventPayload(payload: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>).slice(0, 10)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) || ['__proto__', 'constructor', 'prototype'].includes(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
