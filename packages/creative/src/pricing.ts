export type CreativePriceTable = Record<string, { perImageUsd?: number; perSecondUsd?: number }>;

export interface ResolvedCreativePrice {
  perImageUsd?: number;
  perSecondUsd?: number;
  source: 'model' | 'none';
  matched?: string;
}

/** Price lookup for a model; a dated snapshot name matches its base name (longest prefix wins). */
export function resolveCreativePrice(model: string, table: CreativePriceTable): ResolvedCreativePrice {
  const name = model.includes(':') ? model.slice(model.lastIndexOf(':') + 1) : model;
  const key = Object.keys(table)
    .filter((k) => name === k || name.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? { ...table[key], source: 'model', matched: key } : { source: 'none' };
}

export function imageCostUsd(price: ResolvedCreativePrice, images: number): number {
  return price.perImageUsd !== undefined ? price.perImageUsd * images : 0;
}
export function videoCostUsd(price: ResolvedCreativePrice, seconds: number): number {
  return price.perSecondUsd !== undefined ? price.perSecondUsd * seconds : 0;
}
