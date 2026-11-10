import { createHash } from 'crypto';

/** Shape produced by the API's KnowledgeService.buildAgentContext(tenant) (verified data of ONE business). */
export interface BusinessContext {
  businessId: string;
  business: Record<string, unknown> & { name: string; currency: string };
  products: Array<Record<string, unknown> & { id: string; name: string }>;
  services: Array<Record<string, unknown> & { id: string; name: string }>;
  knowledge: Array<{ id: string; category: string; title: string; body: string }>;
  missingInformation: string[];
}

/** Source references the model may cite. Anything else is rejected as an unsupported claim. */
export function validSources(ctx: BusinessContext): Set<string> {
  return new Set([
    'business',
    ...ctx.products.map((p) => `product:${p.id}`),
    ...ctx.services.map((s) => `service:${s.id}`),
    ...ctx.knowledge.map((k) => `knowledge:${k.id}`),
  ]);
}

/** Stable hash of the facts (excludes generation time), used to reuse analyses while data is unchanged. */
export function contextHash(ctx: BusinessContext, extra: unknown = null): string {
  const { business, products, services, knowledge } = ctx;
  return createHash('sha256').update(JSON.stringify({ business, products, services, knowledge, extra })).digest('hex');
}
