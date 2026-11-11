import type { BusinessContext } from './context';

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STOP = new Set(['the', 'and', 'for', 'you', 'are', 'what', 'how', 'much', 'with', 'this', 'that', 'have', 'does', 'des', 'les', 'une', 'pour', 'est', 'que', 'quel', 'quelle', 'avez', 'vous', 'dans', 'avec', 'sur', 'pas', 'bir', 'bu', 'icin', 'var', 'mi', 'ne', 'kadar', 'fiyat', 'price', 'prix', 'cost', 'combien']);

export function tokens(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3 && !STOP.has(t));
}

type Item = Record<string, unknown> & { id: string; name: string };

function score(item: Item, q: Set<string>): number {
  let s = 0;
  const name = new Set(tokens(item.name));
  const sku = typeof item.sku === 'string' ? fold(item.sku) : null;
  const rest = new Set(tokens([item.description, item.category, ...(Array.isArray(item.features) ? item.features : []), ...(Array.isArray(item.benefits) ? item.benefits : [])].filter((x) => typeof x === 'string').join(' ')));
  for (const t of q) {
    if (name.has(t)) s += 4;
    else if ([...name].some((n) => n.startsWith(t) || t.startsWith(n))) s += 2; // plural / suffix variants (robe/robes, elbise/elbisenin)
    if (sku && sku.includes(t)) s += 5;
    if (rest.has(t)) s += 1;
  }
  return s;
}

/**
 * Picks the catalog items worth giving the model for this conversation: items matching the customer's words (the last messages),
 * items already discussed, and, when nothing matches (a generic "what do you sell?"), the first items of the catalog.
 * Keeps prompts small without ever reaching outside the tenant's own verified context.
 */
export function selectRelevantItems(ctx: BusinessContext, customerTexts: string[], opts: { focusIds?: string[]; max?: number } = {}): string[] {
  const max = opts.max ?? 12;
  const q = new Set(customerTexts.slice(-3).flatMap(tokens));
  const all: Item[] = [...ctx.products, ...ctx.services];
  const scored = all.map((i, idx) => ({ id: i.id, s: score(i, q) + (opts.focusIds?.includes(i.id) ? 3 : 0), idx })).sort((a, b) => b.s - a.s || a.idx - b.idx);
  const matched = scored.filter((x) => x.s > 0).slice(0, max).map((x) => x.id);
  if (matched.length) return matched;
  return all.slice(0, max).map((i) => i.id);
}
