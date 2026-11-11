import type { ModelPricing } from './provider';

/** Per-model prices in USD per 1M tokens, e.g. { "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 } }. */
export type PricingTable = Record<string, ModelPricing>;

export interface ResolvedPricing {
  pricing: ModelPricing;
  /** model = matched an entry of the table; default = flat fallback prices; none = nothing configured. */
  source: 'model' | 'default' | 'none';
  /** Table key that matched (for audit/reporting). */
  matched?: string;
}

/**
 * Price lookup for the model that actually served a call. Provider responses often name a dated
 * snapshot ("gpt-4o-mini-2024-07-18"), so the longest table key that is a prefix of the model wins.
 * A "provider:" prefix (e.g. test models) is ignored. Falls back to the flat default prices.
 */
export function resolvePricing(model: string, table: PricingTable, fallback: ModelPricing): ResolvedPricing {
  const name = model.includes(':') ? model.slice(model.lastIndexOf(':') + 1) : model;
  const keys = Object.keys(table)
    .filter((k) => name === k || name.startsWith(k))
    .sort((a, b) => b.length - a.length);
  if (keys.length) return { pricing: table[keys[0]!]!, source: 'model', matched: keys[0] };
  if (fallback.inputPerMillion > 0 || fallback.outputPerMillion > 0) return { pricing: fallback, source: 'default' };
  return { pricing: { inputPerMillion: 0, outputPerMillion: 0 }, source: 'none' };
}
