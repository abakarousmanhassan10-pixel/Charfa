import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type MarketAnalysis, type MarketProduct } from '@touma/database';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { PageQueryDto, pageArgs, toPage } from '../common/pagination';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { NEAR_DUPLICATE_THRESHOLD, analyze, dedupeKey, freshness, nameSimilarity, normalizeName, normalizeUrl, type Assumptions, type FreshnessLevel, type MarketProductInput } from './market-calc';
import type { ImportMarketProductDto, ListMarketProductsQueryDto } from './market.dto';

const DAY = 86_400_000;
const amount = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/);
const percent = z.string().regex(/^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/);
const assumptionsSchema = z
  .object({
    paymentFeePercent: percent.optional(),
    paymentFixedFee: amount.optional(),
    returnsAllowancePercent: percent.optional(),
    advertisingCostPerAcquisition: amount.optional(),
    fx: z
      .object({
        source: z.string().trim().min(3).max(100),
        asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.string().regex(/^(?!0+(\.0+)?$)\d{1,9}(\.\d{1,6})?$/)).refine((r) => Object.keys(r).length <= 10, 'at most 10 rates'),
      })
      .strict()
      .optional(),
  })
  .strict();

function toInput(p: MarketProduct): MarketProductInput {
  return {
    observedAt: p.observedAt,
    costCurrency: p.costCurrency,
    unitCost: p.unitCost?.toFixed(2) ?? null,
    shippingCost: p.shippingCost?.toFixed(2) ?? null,
    sellingCurrency: p.sellingCurrency,
    sellingPrice: p.sellingPrice?.toFixed(2) ?? null,
    estimatedDeliveryDays: p.estimatedDeliveryDays,
    supplierRating: p.supplierRating?.toFixed(2) ?? null,
    supplierRatingSource: p.supplierRatingSource,
    monthlySearches: p.monthlySearches,
    demandSource: p.demandSource,
    competitorCount: p.competitorCount,
    competitorSource: p.competitorSource,
  };
}

export function analysisView(a: MarketAnalysis) {
  return { id: a.id, asOf: a.asOf, createdAt: a.createdAt, modelVersion: a.modelVersion, assumptions: a.assumptions, profitability: a.profitability, score: a.score, quality: a.quality };
}

export function productView(p: MarketProduct, latest: MarketAnalysis | null, now = new Date()) {
  const i = toInput(p);
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    country: p.country,
    supplierName: p.supplierName,
    source: { type: p.sourceType, name: p.sourceName, url: p.sourceUrl },
    observedAt: p.observedAt,
    freshness: freshness(p.observedAt, now),
    costCurrency: p.costCurrency,
    unitCost: i.unitCost,
    shippingCost: i.shippingCost,
    sellingCurrency: p.sellingCurrency,
    sellingPrice: i.sellingPrice,
    estimatedDeliveryDays: p.estimatedDeliveryDays,
    supplierRating: i.supplierRating,
    supplierRatingSource: p.supplierRatingSource,
    monthlySearches: p.monthlySearches,
    demandSource: p.demandSource,
    competitorCount: p.competitorCount,
    competitorSource: p.competitorSource,
    createdAt: p.createdAt,
    latestAnalysis: latest ? analysisView(latest) : null,
  };
}

/**
 * Market intelligence, first vertical slice: a person enters a researched product from a source they name; TOUMA stores
 * the provenance, detects duplicates, and computes profitability and an explainable score deterministically. No provider,
 * no scraping, no AI: a figure nobody supplied stays UNKNOWN.
 */
@Injectable()
export class MarketService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @InjectEnv() private readonly env: AppEnv) {}

  parseAssumptions(raw: unknown): Assumptions {
    const r = assumptionsSchema.safeParse(raw);
    if (!r.success) {
      const first = r.error.issues[0];
      throw new BadRequestException({ code: 'INVALID_ASSUMPTIONS', message: `Invalid assumptions: ${first ? `${first.path.join('.') || '(root)'} ${first.message}` : 'unknown error'}`.slice(0, 200) });
    }
    return r.data as Assumptions;
  }

  private checkSource(url: string): { url: string; key: string } {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new BadRequestException({ code: 'INVALID_SOURCE_URL', message: 'sourceUrl must be a valid http(s) URL' });
    }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !u.hostname.includes('.')) {
      throw new BadRequestException({ code: 'INVALID_SOURCE_URL', message: 'sourceUrl must be a public http(s) URL without credentials' });
    }
    return { url: u.toString().slice(0, 500), key: normalizeUrl(url) };
  }

  async importProduct(tenant: TenantContext, dto: ImportMarketProductDto) {
    const bad = (code: string, message: string) => new BadRequestException({ code, message });
    const src = this.checkSource(dto.sourceUrl);
    const observedAt = new Date(dto.observedAt);
    if (Number.isNaN(observedAt.getTime())) throw bad('INVALID_OBSERVED_AT', 'observedAt must be a valid date');
    if (observedAt.getTime() > Date.now() + DAY) throw bad('OBSERVED_IN_FUTURE', 'observedAt cannot be in the future');
    // Evidence needs a named source: an unsourced figure is refused instead of being stored as if it were measured.
    if (dto.supplierRating !== undefined && !dto.supplierRatingSource) throw bad('SOURCE_REQUIRED', 'supplierRating needs supplierRatingSource');
    if (dto.monthlySearches !== undefined && !dto.demandSource) throw bad('SOURCE_REQUIRED', 'monthlySearches needs demandSource');
    if (dto.competitorCount !== undefined && !dto.competitorSource) throw bad('SOURCE_REQUIRED', 'competitorCount needs competitorSource');
    if (!normalizeName(dto.name)) throw bad('INVALID_NAME', 'The name must contain letters or digits');

    if ((await this.prisma.marketProduct.count({ where: { businessId: tenant.businessId } })) >= this.env.MARKET_MAX_PRODUCTS_PER_BUSINESS) {
      throw new HttpException({ code: 'MARKET_LIMIT_REACHED', message: `At most ${this.env.MARKET_MAX_PRODUCTS_PER_BUSINESS} researched products per business` }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const key = dedupeKey(dto.name, dto.country, dto.supplierName);
    const dupe = await this.prisma.marketProduct.findUnique({ where: { businessId_dedupeKey: { businessId: tenant.businessId, dedupeKey: key } }, select: { id: true } });
    if (dupe) throw new ConflictException({ code: 'DUPLICATE_PRODUCT', message: 'This product is already in your research for this market and supplier', existingId: dupe.id });
    const sameUrl = await this.prisma.marketProduct.findFirst({ where: { businessId: tenant.businessId, sourceUrlKey: src.key }, select: { id: true } });
    if (sameUrl) throw new ConflictException({ code: 'DUPLICATE_SOURCE_URL', message: 'A product from this source page is already in your research', existingId: sameUrl.id });

    // Near duplicates are reported, not refused: the person decides.
    const sameMarket = await this.prisma.marketProduct.findMany({ where: { businessId: tenant.businessId, country: dto.country }, select: { id: true, name: true }, orderBy: { createdAt: 'desc' }, take: 500 });
    const possibleDuplicates = sameMarket
      .map((o) => ({ id: o.id, name: o.name, similarity: Math.round(nameSimilarity(dto.name, o.name) * 100) / 100 }))
      .filter((o) => o.similarity >= NEAR_DUPLICATE_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);

    try {
      const p = await this.prisma.marketProduct.create({
        data: {
          businessId: tenant.businessId,
          createdById: tenant.userId,
          name: dto.name,
          normalizedName: normalizeName(dto.name),
          dedupeKey: key,
          category: dto.category,
          country: dto.country,
          supplierName: dto.supplierName,
          sourceType: 'MANUAL',
          sourceName: dto.sourceName,
          sourceUrl: src.url,
          sourceUrlKey: src.key,
          observedAt,
          costCurrency: dto.costCurrency,
          unitCost: dto.unitCost,
          shippingCost: dto.shippingCost,
          sellingCurrency: dto.sellingCurrency,
          sellingPrice: dto.sellingPrice,
          estimatedDeliveryDays: dto.estimatedDeliveryDays,
          supplierRating: dto.supplierRating,
          supplierRatingSource: dto.supplierRatingSource,
          monthlySearches: dto.monthlySearches,
          demandSource: dto.demandSource,
          competitorCount: dto.competitorCount,
          competitorSource: dto.competitorSource,
        },
      });
      await this.audit.record({ action: 'market.product_imported', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'MarketProduct', entityId: p.id, metadata: { country: p.country, sourceType: p.sourceType } });
      return { ...productView(p, null), possibleDuplicates };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await this.prisma.marketProduct.findUnique({ where: { businessId_dedupeKey: { businessId: tenant.businessId, dedupeKey: key } }, select: { id: true } });
        throw new ConflictException({ code: 'DUPLICATE_PRODUCT', message: 'This product is already in your research for this market and supplier', existingId: again?.id });
      }
      throw err;
    }
  }

  private async find(tenant: Pick<TenantContext, 'businessId'>, id: string) {
    const p = await this.prisma.marketProduct.findFirst({ where: { id, businessId: tenant.businessId } });
    if (!p) throw new NotFoundException({ code: 'MARKET_PRODUCT_NOT_FOUND', message: 'Researched product not found' });
    return p;
  }

  async list(tenant: TenantContext, q: ListMarketProductsQueryDto & PageQueryDto) {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const range: Record<FreshnessLevel, Prisma.DateTimeFilter> = {
      FRESH: { gt: ago(8) },
      RECENT: { lte: ago(8), gt: ago(31) },
      STALE: { lte: ago(31), gt: ago(91) },
      OUTDATED: { lte: ago(91) },
    };
    const where: Prisma.MarketProductWhereInput = {
      businessId: tenant.businessId,
      ...(q.country ? { country: q.country } : {}),
      ...(q.category ? { category: { equals: q.category, mode: 'insensitive' } } : {}),
      ...(q.freshness ? { observedAt: range[q.freshness] } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.marketProduct.findMany({ where, orderBy: { createdAt: 'desc' }, include: { analyses: { orderBy: { createdAt: 'desc' }, take: 1 } }, ...pageArgs(q) }),
      this.prisma.marketProduct.count({ where }),
    ]);
    return toPage(items.map((p) => productView(p, p.analyses[0] ?? null, now)), total, q);
  }

  async get(tenant: TenantContext, id: string) {
    const p = await this.find(tenant, id);
    const latest = await this.prisma.marketAnalysis.findFirst({ where: { productId: p.id, businessId: tenant.businessId }, orderBy: { createdAt: 'desc' } });
    return productView(p, latest);
  }

  /** Runs the deterministic model with the assumptions given and keeps the result as research history. */
  async analyze(tenant: TenantContext, id: string, rawAssumptions: unknown) {
    const p = await this.find(tenant, id);
    const assumptions = this.parseAssumptions(rawAssumptions);
    const since = new Date(Date.now() - DAY);
    if ((await this.prisma.marketAnalysis.count({ where: { businessId: tenant.businessId, createdAt: { gte: since } } })) >= this.env.MARKET_MAX_ANALYSES_PER_DAY) {
      throw new HttpException({ code: 'MARKET_ANALYSIS_LIMIT', message: `At most ${this.env.MARKET_MAX_ANALYSES_PER_DAY} analyses per 24 hours` }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const asOf = new Date();
    const r = analyze(toInput(p), assumptions, asOf);
    const row = await this.prisma.marketAnalysis.create({
      data: {
        businessId: tenant.businessId,
        productId: p.id,
        createdById: tenant.userId,
        modelVersion: r.modelVersion,
        asOf,
        assumptions: assumptions as unknown as Prisma.InputJsonObject,
        profitability: r.profitability as unknown as Prisma.InputJsonObject,
        score: r.score as unknown as Prisma.InputJsonObject,
        quality: r.quality as unknown as Prisma.InputJsonObject,
      },
    });
    await this.audit.record({ action: 'market.analysis_created', actorId: tenant.userId, businessId: tenant.businessId, entityType: 'MarketProduct', entityId: p.id, metadata: { analysisId: row.id, score: r.score.score, verdict: r.score.verdict } });
    return analysisView(row);
  }

  async history(tenant: TenantContext, id: string, q: PageQueryDto) {
    const p = await this.find(tenant, id);
    const where = { productId: p.id, businessId: tenant.businessId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.marketAnalysis.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.marketAnalysis.count({ where }),
    ]);
    return toPage(items.map(analysisView), total, q);
  }
}
