import { BadRequestException, Injectable } from '@nestjs/common';
import { costMicros, usdPerMillionToMicros } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';

export interface CostEstimate { micros: number; priced: boolean; version: number | null; currency: string }

/**
 * Versioned model prices in micro-units per million tokens (integer arithmetic only). The prices of AI_MODEL_PRICING are loaded as version 1; an administrator
 * adds a new version when a provider changes a price, and a cost is always computed with the version in force at the time of the call.
 * What is computed here is an ESTIMATE from this table: it is never an invoice, and `actualCostMicros` stays empty until a real bill is known.
 */
@Injectable()
export class PricesService {
  constructor(private readonly prisma: PrismaService, @InjectEnv() private readonly env: AppEnv) {}

  async ensureConfigured(): Promise<void> {
    for (const [modelId, p] of Object.entries(this.env.AI_MODEL_PRICING)) {
      if (await this.prisma.modelPrice.findFirst({ where: { modelId }, select: { id: true } })) continue;
      try {
        await this.prisma.modelPrice.create({ data: { modelId, version: 1, inputPerMillionMicros: usdPerMillionToMicros(p.inputPerMillion.toFixed(6)), outputPerMillionMicros: usdPerMillionToMicros(p.outputPerMillion.toFixed(6)), effectiveFrom: new Date(0), source: 'configured' } });
      } catch { /* created concurrently */ }
    }
  }

  private async priceAt(modelId: string, at: Date) {
    return this.prisma.modelPrice.findFirst({ where: { modelId, effectiveFrom: { lte: at } }, orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }] });
  }

  /** The model id reported by a provider may carry a prefix (the fake provider reports "fake:<model>"): the price of the requested model is used. */
  async estimate(modelId: string, tokens: { input: number; output: number; cached?: number | null }, at = new Date()): Promise<CostEstimate> {
    const price = await this.priceAt(modelId, at);
    if (!price) return { micros: this.env.AGENT_UNPRICED_MICROS_PER_CALL, priced: false, version: null, currency: 'USD' };
    return { micros: costMicros(tokens, price), priced: true, version: price.version, currency: price.currency };
  }

  list() {
    return this.prisma.modelPrice.findMany({ orderBy: [{ modelId: 'asc' }, { version: 'desc' }] });
  }

  async addVersion(modelId: string, p: { inputPerMillionMicros: number; outputPerMillionMicros: number; cachedInputPerMillionMicros?: number | null }, actorId: string, effectiveFrom = new Date()) {
    if (!/^[A-Za-z0-9._:/-]{1,100}$/.test(modelId)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'invalid model id' });
    for (const v of [p.inputPerMillionMicros, p.outputPerMillionMicros, p.cachedInputPerMillionMicros ?? 0]) if (!Number.isInteger(v) || v < 0 || v > 2_000_000_000) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'prices are integers in micro-units per million tokens' });
    const last = await this.prisma.modelPrice.findFirst({ where: { modelId }, orderBy: { version: 'desc' }, select: { version: true } });
    return this.prisma.modelPrice.create({ data: { modelId, version: (last?.version ?? 0) + 1, inputPerMillionMicros: p.inputPerMillionMicros, outputPerMillionMicros: p.outputPerMillionMicros, cachedInputPerMillionMicros: p.cachedInputPerMillionMicros ?? null, effectiveFrom, source: 'admin', createdById: actorId } });
  }
}
