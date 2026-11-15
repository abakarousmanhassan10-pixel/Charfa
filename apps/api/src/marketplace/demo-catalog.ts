import { derivePermissions, defaultBuilderConfig, type AgentManifestV1 } from '@touma/shared';

/** The three FICTITIOUS demo listings. Instructions are plain data; nothing here is executed and no real product, price or customer exists. */
const agent = (name: string, category: string, mission: string, instructions: string, tools: string[], tone: 'friendly' | 'professional' = 'friendly') => ({ ...defaultBuilderConfig(), name, category: category as never, mission, instructions, tools, tone });
const manifest = (o: { id: string; version: string; name: string; summary: string; category: string; tags: string[]; a: ReturnType<typeof agent>; license: AgentManifestV1['license']; budget: number; variables?: AgentManifestV1['variables'] }): AgentManifestV1 => ({
  schemaVersion: 1, id: o.id, version: o.version, name: o.name, summary: o.summary, category: o.category, tags: o.tags, agent: o.a, workflows: [], variables: o.variables ?? [], recommendedBudget: { monthlyMicros: o.budget }, compatibleModels: ['mock-model'], license: o.license, author: { name: 'Demo Studio (fictitious)' }, permissions: derivePermissions(o.a.tools),
});

export const DEMO_CREATOR = { displayName: 'Demo Studio (fictitious)', bio: 'A fictitious creator used to demonstrate the marketplace. Nothing it publishes is real.' };

export const DEMO_LISTINGS = [
  {
    slug: 'marketing-ai-pro', name: 'Marketing AI Pro', category: 'MARKETING', tags: ['calendar', 'social', 'content'], pricing: 'FREE' as const, simulated: false,
    summary: 'Prepares a weekly editorial calendar and post drafts from your own catalog. Drafts always wait for your approval.',
    description: 'Marketing AI Pro looks at your catalog and your goals and proposes a weekly editorial calendar with short post drafts. It saves drafts only; publishing stays under your publishing policy and your approvals. This is a fictitious demo listing.',
    versions: [
      { version: '1.0.0', changelog: 'First release: weekly calendar proposal and short drafts.', m: manifest({ id: 'demo.marketing-ai-pro', version: '1.0.0', name: 'Marketing AI Pro', summary: 'Prepares a weekly editorial calendar and post drafts from your catalog.', category: 'MARKETING', tags: ['calendar', 'social'], a: agent('Marketing AI Pro', 'MARKETING', 'Prepare a weekly editorial calendar for the business using its catalog.', 'Propose one post idea per day from the catalog, in a friendly tone, with a short draft each. Never promise results.', ['catalog.search', 'draft.save']), license: { type: 'FREE', terms: 'Free to use inside TOUMA for any business.' }, budget: 1_000_000, variables: [{ key: 'brandName', label: 'Brand name', type: 'text' }] }) },
      { version: '1.1.0', changelog: 'Adds knowledge lookup so drafts can use your approved business knowledge. Requests one extra read-only permission.', m: manifest({ id: 'demo.marketing-ai-pro', version: '1.1.0', name: 'Marketing AI Pro', summary: 'Prepares a weekly editorial calendar and post drafts from your catalog and approved knowledge.', category: 'MARKETING', tags: ['calendar', 'social'], a: agent('Marketing AI Pro', 'MARKETING', 'Prepare a weekly editorial calendar for the business using its catalog and approved knowledge.', 'Propose one post idea per day from the catalog and approved knowledge, in a friendly tone, with a short draft each. Never promise results.', ['knowledge.lookup', 'catalog.search', 'draft.save']), license: { type: 'FREE', terms: 'Free to use inside TOUMA for any business.' }, budget: 1_000_000, variables: [{ key: 'brandName', label: 'Brand name', type: 'text' }] }) },
    ],
  },
  {
    slug: 'customer-support-ai', name: 'Customer Support AI', category: 'SUPPORT', tags: ['support', 'replies'], pricing: 'PREMIUM' as const, simulated: true,
    summary: 'Prepares replies to customer messages from your verified knowledge. Premium (simulated: no real price or payment exists).',
    description: 'Customer Support AI prepares draft replies using only your approved knowledge and catalog. Replies are drafts for your review; nothing is sent to customers. This is a fictitious premium listing: the premium licence and any price are simulated and no payment can be made.',
    versions: [
      { version: '1.0.0', changelog: 'First release: draft replies from approved knowledge.', m: manifest({ id: 'demo.customer-support-ai', version: '1.0.0', name: 'Customer Support AI', summary: 'Prepares draft replies to customer messages from your approved knowledge.', category: 'SUPPORT', tags: ['support'], a: agent('Customer Support AI', 'SUPPORT', 'Prepare polite draft replies to customer messages using approved knowledge only.', 'Answer only from approved knowledge and the catalog. If the answer is not there, say you will check and hand over to a person. Keep replies short and polite.', ['knowledge.lookup', 'catalog.search', 'draft.save'], 'professional'), license: { type: 'PREMIUM_SIMULATED', terms: 'Simulated premium licence for demonstration. No price is set and no payment is possible.' }, budget: 2_000_000 }) },
    ],
  },
  {
    slug: 'ecommerce-research-ai', name: 'E-commerce Research AI', category: 'ECOMMERCE', tags: ['research', 'products'], pricing: 'FREE' as const, simulated: false,
    summary: 'Summarizes your catalog and usage figures into a short research brief. Read-only: it changes nothing.',
    description: 'E-commerce Research AI reads your own catalog and usage counters and writes a short research brief: which products lack data and what to look at next. It is read-only. This is a fictitious demo listing.',
    versions: [
      { version: '1.0.0', changelog: 'First release: catalog research brief (read-only).', m: manifest({ id: 'demo.ecommerce-research-ai', version: '1.0.0', name: 'E-commerce Research AI', summary: 'Summarizes your catalog and usage into a short, read-only research brief.', category: 'ECOMMERCE', tags: ['research'], a: agent('E-commerce Research AI', 'ECOMMERCE', 'Summarize the catalog and usage into a short research brief for the owner.', 'Read the catalog and the usage counters and list products with missing data and three things to look at next. State clearly what you could not see.', ['catalog.search', 'usage.summary'], 'professional'), license: { type: 'FREE', terms: 'Free to use inside TOUMA for any business.' }, budget: 500_000 }) },
    ],
  },
];
