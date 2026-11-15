import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@touma/database';
import { AGENT_CATEGORIES, compareSemver, deriveCapabilities, validateManifest, type AgentManifestV1 } from '@touma/shared';
import { AuditService } from '../audit/audit.service';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { DEMO_CREATOR, DEMO_LISTINGS } from './demo-catalog';

/** Canonical JSON (sorted keys at every level), so the hash depends on content only. */
export const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v));
export const manifestHash = (m: unknown) => createHash('sha256').update(canonical(m)).digest('hex');
const INSTALL_NOTE = 'Installation counts start when installation exists; no count is shown until then.';
const PRICE_NOTE = 'Premium licences are simulated in this release: no price is set and no payment can be made.';

export interface CatalogQuery { q?: string; category?: string; pricing?: 'FREE' | 'PREMIUM'; model?: string; sort: 'newest' | 'name'; page: number; pageSize: number }

/**
 * The agent catalog (N24 block A). Read-only for clients: it lists PUBLISHED listings that have at least one PUBLISHED version, shows what the package declares (capabilities,
 * permissions, models, licence, history) and never invents activity: installs are not counted until installation exists and a review only counts once moderated.
 * Ranking is by date or name only: there is no popularity score to manipulate.
 */
@Injectable()
export class MarketplaceService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @InjectEnv() private readonly env: AppEnv) {}

  private latest<T extends { version: string; status: string }>(versions: T[]) {
    return versions.filter((v) => v.status === 'PUBLISHED').sort((a, b) => compareSemver(b.version, a.version))[0] ?? null;
  }

  private async reviewStats(listingIds: string[]) {
    const g = await this.prisma.marketplaceReview.groupBy({ by: ['listingId'], where: { listingId: { in: listingIds }, status: 'APPROVED' }, _count: { _all: true }, _avg: { rating: true } });
    return new Map(g.map((x) => [x.listingId, { count: x._count._all, average: x._avg.rating === null ? null : Math.round(x._avg.rating * 10) / 10 }]));
  }

  async catalog(q: CatalogQuery) {
    const where: Prisma.MarketplaceListingWhereInput = {
      status: 'PUBLISHED', creator: { status: 'ACTIVE' }, versions: { some: { status: 'PUBLISHED' } },
      ...(q.category ? { category: q.category } : {}), ...(q.pricing ? { pricing: q.pricing } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { summary: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }, { tags: { has: q.q.toLowerCase() } }] } : {}),
    };
    const rows = await this.prisma.marketplaceListing.findMany({ where, include: { creator: true, versions: { where: { status: 'PUBLISHED' } } }, orderBy: q.sort === 'name' ? { name: 'asc' } : { publishedAt: 'desc' } });
    const stats = await this.reviewStats(rows.map((r) => r.id));
    const items = rows.map((r) => {
      const v = this.latest(r.versions)!;
      const m = v.manifest as unknown as AgentManifestV1;
      return { slug: r.slug, name: r.name, summary: r.summary, category: r.category, tags: r.tags, demo: r.demo, publishedAt: r.publishedAt,
        creator: { displayName: r.creator.displayName, verified: r.creator.verified, demo: r.creator.demo },
        pricing: { type: r.pricing, simulated: r.pricingSimulated, note: r.pricing === 'PREMIUM' ? PRICE_NOTE : null },
        latestVersion: v.version, compatibleModels: m.compatibleModels, tools: m.agent.tools,
        permissions: { count: m.permissions.length, sensitive: m.permissions.filter((p) => p.sensitive).length },
        installs: { count: null, note: INSTALL_NOTE }, reviews: stats.get(r.id) ?? { count: 0, average: null } };
    }).filter((i) => !q.model || i.compatibleModels.includes(q.model));
    const total = items.length;
    return { total, page: q.page, pageSize: q.pageSize, items: items.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), note: 'Fictitious entries are marked demo. Listings are never ranked by popularity.' };
  }

  async categories() {
    const g = await this.prisma.marketplaceListing.groupBy({ by: ['category'], where: { status: 'PUBLISHED', creator: { status: 'ACTIVE' }, versions: { some: { status: 'PUBLISHED' } } }, _count: { _all: true } });
    const n = new Map(g.map((x) => [x.category, x._count._all]));
    return AGENT_CATEGORIES.map((c) => ({ category: c, listings: n.get(c) ?? 0 }));
  }

  async detail(slug: string) {
    const r = await this.prisma.marketplaceListing.findFirst({ where: { slug, status: 'PUBLISHED', creator: { status: 'ACTIVE' } }, include: { creator: true, versions: { where: { status: 'PUBLISHED' } } } });
    const v = r ? this.latest(r.versions) : null;
    if (!r || !v) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Listing not found' });
    const m = v.manifest as unknown as AgentManifestV1;
    const [stats, reviews] = await Promise.all([this.reviewStats([r.id]), this.prisma.marketplaceReview.findMany({ where: { listingId: r.id, status: 'APPROVED' }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, rating: true, comment: true, versionId: true, createdAt: true } })]);
    const versionOf = new Map(r.versions.map((x) => [x.id, x.version]));
    return {
      slug: r.slug, name: r.name, summary: r.summary, description: r.description, category: r.category, tags: r.tags, demo: r.demo, publishedAt: r.publishedAt,
      creator: { displayName: r.creator.displayName, bio: r.creator.bio, verified: r.creator.verified, demo: r.creator.demo },
      pricing: { type: r.pricing, simulated: r.pricingSimulated, note: r.pricing === 'PREMIUM' ? PRICE_NOTE : null }, license: m.license,
      latestVersion: { version: v.version, publishedAt: v.publishedAt, changelog: v.changelog, manifestHash: v.manifestHash },
      capabilities: deriveCapabilities(m.agent.tools), permissions: m.permissions, compatibleModels: m.compatibleModels,
      agent: { category: m.agent.category, language: m.agent.language, tone: m.agent.tone, mode: m.agent.mode, mission: m.agent.mission, instructions: m.agent.instructions, tools: m.agent.tools },
      variables: m.variables, recommendedBudget: m.recommendedBudget,
      history: r.versions.filter((x) => x.status === 'PUBLISHED').sort((a, b) => compareSemver(b.version, a.version)).map((x) => ({ version: x.version, publishedAt: x.publishedAt, changelog: x.changelog, manifestHash: x.manifestHash, permissions: (x.manifest as unknown as AgentManifestV1).permissions.map((p) => p.key) })),
      installs: { count: null, note: INSTALL_NOTE },
      reviews: { ...(stats.get(r.id) ?? { count: 0, average: null }), verifiedOnly: true, items: reviews.map((x) => ({ rating: x.rating, comment: x.comment, version: x.versionId ? versionOf.get(x.versionId) ?? null : null, date: x.createdAt })), note: 'Only moderated reviews from businesses that installed the agent are shown, without any identity.' },
    };
  }

  /** Creates the three fictitious listings (idempotent). Their manifests are validated like any package; an invalid one is a programming error and aborts. */
  async seedDemo(actorId: string) {
    if (!this.env.MARKETPLACE_DEMO_ENABLED) throw new ConflictException({ code: 'DEMO_DISABLED', message: 'Demo data is not enabled on this deployment' });
    const creator = (await this.prisma.creatorProfile.findFirst({ where: { demo: true, displayName: DEMO_CREATOR.displayName } })) ?? (await this.prisma.creatorProfile.create({ data: { ...DEMO_CREATOR, demo: true, verified: false } }));
    let created = 0;
    for (const l of DEMO_LISTINGS) {
      for (const v of l.versions) { const r = validateManifest(v.m); if (!r.ok) throw new Error(`Demo manifest ${l.slug}@${v.version} is invalid: ${r.issues.map((i) => i.code).join(',')}`); }
      let listing = await this.prisma.marketplaceListing.findUnique({ where: { slug: l.slug } });
      if (!listing) { listing = await this.prisma.marketplaceListing.create({ data: { slug: l.slug, creatorId: creator.id, name: l.name, summary: l.summary, description: l.description, category: l.category, tags: l.tags, status: 'PUBLISHED', pricing: l.pricing, pricingSimulated: l.simulated, demo: true, publishedAt: new Date() } }); created++; }
      for (const v of l.versions) {
        const exists = await this.prisma.marketplaceVersion.findUnique({ where: { listingId_version: { listingId: listing.id, version: v.version } } });
        if (!exists) await this.prisma.marketplaceVersion.create({ data: { listingId: listing.id, version: v.version, manifest: v.m as unknown as Prisma.InputJsonObject, manifestHash: manifestHash(v.m), changelog: v.changelog, status: 'PUBLISHED', publishedAt: new Date() } });
      }
    }
    await this.audit.record({ action: 'marketplace.demo_seeded', actorId, entityType: 'MarketplaceListing', metadata: { created } });
    return { listings: DEMO_LISTINGS.length, created, demo: true };
  }
}
