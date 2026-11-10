import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const UNSUPPORTED = ['minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'default', '$schema', 'multipleOf'];

/**
 * Converts a Zod schema into a JSON Schema accepted by strict structured-output modes:
 * every object is closed (additionalProperties: false) and lists all properties as required;
 * keywords providers may not support are removed. The full Zod schema (with lengths, counts and
 * ranges) is still enforced locally on every answer.
 */
export function toStrictJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = zodToJsonSchema(schema as any, { target: 'openAi', $refStrategy: 'none' }) as Record<string, unknown>;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED.includes(k)) continue;
      out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, walk(pv)])) : walk(v);
    }
    if (out.type === 'object' && out.properties) {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties as object);
    }
    return out;
  };
  return walk(raw) as Record<string, unknown>;
}
