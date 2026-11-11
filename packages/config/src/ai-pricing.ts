export type ModelPriceTable = Record<string, { inputPerMillion: number; outputPerMillion: number }>;

/** Parses AI_MODEL_PRICING (USD per 1M tokens, keyed by model name). Throws a readable error for malformed input. */
export function parsePricingTable(json: string | undefined): ModelPriceTable {
  if (!json || !json.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('AI_MODEL_PRICING must be valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('AI_MODEL_PRICING must be an object keyed by model name');
  const out: ModelPriceTable = {};
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  for (const [model, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = v as { inputPerMillion?: unknown; outputPerMillion?: unknown } | null;
    if (!p || !ok(p.inputPerMillion) || !ok(p.outputPerMillion)) {
      throw new Error(`AI_MODEL_PRICING["${model}"] needs numeric inputPerMillion and outputPerMillion (USD per 1M tokens, >= 0)`);
    }
    out[model] = { inputPerMillion: p.inputPerMillion, outputPerMillion: p.outputPerMillion };
  }
  return out;
}
