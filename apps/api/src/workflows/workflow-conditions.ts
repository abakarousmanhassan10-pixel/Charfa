import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Restricted condition format. A condition is data, never code: no expressions, no regular expressions, no function
 * calls. Fields are read from three fixed places only (`input.*`, `trigger.*`, `steps.<key>.output.*`) and values are
 * plain scalars, so nothing a caller sends can execute or escape.
 *
 *   { "all": [ { "field": "input.channel", "op": "eq", "value": "instagram" }, { "not": { "field": "trigger.priority", "op": "gt", "value": 3 } } ] }
 */
export const MAX_CONDITION_DEPTH = 3;
export const MAX_CONDITION_LEAVES = 10;

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const FIELD = /^(?:(?:input|trigger)\.[A-Za-z_][A-Za-z0-9_]{0,40}|steps\.[A-Za-z][A-Za-z0-9_]{0,30}\.output\.[A-Za-z_][A-Za-z0-9_]{0,40})$/;
const scalar = z.union([z.string().max(100), z.number().finite(), z.boolean()]);
export type Scalar = string | number | boolean;

export const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'exists'] as const;
export type Op = (typeof OPS)[number];

export interface Leaf {
  field: string;
  op: Op;
  value?: Scalar | Scalar[];
}
export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | Leaf;

const leafSchema = z
  .object({ field: z.string().regex(FIELD), op: z.enum(OPS), value: z.union([scalar, z.array(scalar).min(1).max(20)]).optional() })
  .strict();

export interface ConditionContext {
  input: Record<string, unknown>;
  trigger: Record<string, unknown>;
  steps: Record<string, { output: Record<string, unknown> | null }>;
}

const bad = (message: string) => new BadRequestException({ code: 'INVALID_CONDITION', message });

/** Throws INVALID_CONDITION for anything outside the format (unknown keys, bad field paths, too deep, too many leaves). */
export function validateCondition(c: unknown): Condition {
  let leaves = 0;
  const walk = (node: unknown, depth: number): Condition => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw bad('a condition must be an object');
    const keys = Object.keys(node);
    const isGroup = keys.length === 1 && ['all', 'any', 'not'].includes(keys[0]!);
    // Only groups count as nesting levels; a comparison inside the deepest group is fine.
    if (isGroup && depth > MAX_CONDITION_DEPTH) throw bad(`conditions can be nested at most ${MAX_CONDITION_DEPTH} levels`);
    if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
      const list = (node as Record<string, unknown>)[keys[0]];
      if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CONDITION_LEAVES) throw bad(`"${keys[0]}" needs 1-${MAX_CONDITION_LEAVES} conditions`);
      return keys[0] === 'all' ? { all: list.map((x) => walk(x, depth + 1)) } : { any: list.map((x) => walk(x, depth + 1)) };
    }
    if (keys.length === 1 && keys[0] === 'not') return { not: walk((node as { not: unknown }).not, depth + 1) };
    const parsed = leafSchema.safeParse(node);
    if (!parsed.success) throw bad('unknown condition shape');
    const leaf = parsed.data as Leaf;
    if (leaf.field.split('.').some((p) => FORBIDDEN.has(p))) throw bad('forbidden field name');
    if (leaf.op === 'exists') {
      if (leaf.value !== undefined) throw bad('"exists" takes no value');
    } else if (leaf.value === undefined) throw bad(`"${leaf.op}" needs a value`);
    if (leaf.op === 'in' && !Array.isArray(leaf.value)) throw bad('"in" needs a list');
    if (leaf.op !== 'in' && Array.isArray(leaf.value)) throw bad('only "in" takes a list');
    if (['gt', 'gte', 'lt', 'lte'].includes(leaf.op) && typeof leaf.value !== 'number') throw bad(`"${leaf.op}" needs a number`);
    if (leaf.op === 'contains' && typeof leaf.value !== 'string') throw bad('"contains" needs a string');
    if (++leaves > MAX_CONDITION_LEAVES) throw bad(`at most ${MAX_CONDITION_LEAVES} comparisons per condition`);
    return leaf;
  };
  return walk(c, 1);
}

const own = (o: unknown, k: string | undefined): unknown =>
  k !== undefined && o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;

function read(field: string, ctx: ConditionContext): unknown {
  const [root, a, , name] = field.split('.');
  if (root === 'input') return own(ctx.input, a);
  if (root === 'trigger') return own(ctx.trigger, a);
  // steps.<key>.output.<name>
  return own((own(ctx.steps, a) as { output: unknown } | undefined)?.output, name);
}

/** Evaluates a validated condition. A missing field never throws: it simply fails the comparison (except "neq" and negations). */
export function evaluateCondition(c: Condition, ctx: ConditionContext): boolean {
  if ('all' in c) return c.all.every((x) => evaluateCondition(x, ctx));
  if ('any' in c) return c.any.some((x) => evaluateCondition(x, ctx));
  if ('not' in c) return !evaluateCondition(c.not, ctx);
  const v = read(c.field, ctx);
  switch (c.op) {
    case 'exists': return v !== undefined && v !== null;
    case 'eq': return v === c.value;
    case 'neq': return v !== c.value;
    case 'gt': return typeof v === 'number' && v > (c.value as number);
    case 'gte': return typeof v === 'number' && v >= (c.value as number);
    case 'lt': return typeof v === 'number' && v < (c.value as number);
    case 'lte': return typeof v === 'number' && v <= (c.value as number);
    case 'in': return (c.value as Scalar[]).some((x) => x === v);
    case 'contains': return typeof v === 'string' && v.includes(c.value as string);
  }
}
