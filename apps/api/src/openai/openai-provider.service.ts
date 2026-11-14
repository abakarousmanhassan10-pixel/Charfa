import { BadRequestException, Injectable } from '@nestjs/common';
import { AI_CONTENT_PURPOSES, AI_FORMATS, AI_LANGUAGES, AI_TONES, type AiContentPurpose, type AiFormat, type AiLanguage, type AiTone } from '@touma/shared';
import { AI_TASK_NAMES, modelFor } from '@touma/config';
import { AiOrchestratorService } from '../ai/orchestrator.service';
import { AppEnv, InjectEnv } from '../config';
import { SalesAgentService } from '../sales/sales-agent.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { ID_REGEX } from '../common/validators';

export interface ItemRef { type: 'PRODUCT' | 'SERVICE'; id: string }
interface Common { language: string; instructions?: string | null }

const bad = (message: string) => new BadRequestException({ code: 'VALIDATION', message });

/**
 * The single entry point for OpenAI-backed capabilities. Every method:
 *  - validates its input (it can be called from a controller, a job or a script);
 *  - goes through the AI orchestrator: tenant-scoped verified data only, monthly quotas, token reservation, bounded retries, audit;
 *  - returns the accepted generation (poll /ai/generations/:id/status): it never calls OpenAI from the browser and never returns a key.
 * Nothing here publishes, sends a message or spends money. Models are chosen by configuration (AI_MODEL, AI_TASK_MODELS).
 */
@Injectable()
export class OpenAIProviderService {
  constructor(
    private readonly orchestrator: AiOrchestratorService,
    private readonly sales: SalesAgentService,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  /** What is wired, with no secret: the provider, whether it can answer, and the model of each task. */
  describe() {
    return { provider: this.env.AI_PROVIDER, configured: this.orchestrator.configured, defaultModel: this.env.AI_MODEL, models: Object.fromEntries(AI_TASK_NAMES.map((t) => [t, modelFor(this.env, t)])) };
  }

  private language(v: string): AiLanguage {
    if (!(AI_LANGUAGES as readonly string[]).includes(v)) throw bad(`language must be one of ${AI_LANGUAGES.join(', ')}`);
    return v as AiLanguage;
  }
  private item(i: ItemRef): ItemRef {
    if (!i || (i.type !== 'PRODUCT' && i.type !== 'SERVICE') || typeof i.id !== 'string' || !ID_REGEX.test(i.id)) throw bad('item must be { type: PRODUCT | SERVICE, id }');
    return { type: i.type, id: i.id };
  }
  private instructions(v?: string | null) {
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || v.length > 500) throw bad('instructions are limited to 500 characters');
    return v.trim();
  }
  private pick<T extends string>(v: string | undefined, allowed: readonly string[], fallback: T, name: string): T {
    if (v === undefined) return fallback;
    if (!allowed.includes(v)) throw bad(`${name} must be one of ${allowed.join(', ')}`);
    return v as T;
  }

  /** A product or service description, written only from its verified catalog data. */
  async generateProductDescription(tenant: TenantContext, i: Common & { item: ItemRef; tone?: string; purpose?: string }) {
    return this.orchestrator.submit(tenant, {
      task: 'CONTENT', format: 'PRODUCT_DESCRIPTION', language: this.language(i.language), item: this.item(i.item), instructions: this.instructions(i.instructions),
      tone: this.pick<AiTone>(i.tone, AI_TONES, 'FRIENDLY', 'tone'), purpose: this.pick<AiContentPurpose>(i.purpose, AI_CONTENT_PURPOSES, 'PROMOTIONAL', 'purpose'),
    });
  }

  /** Benefits, customer problems, segments, angles, objections and FAQs of one item, each tied to verified data. */
  async analyzeProduct(tenant: TenantContext, i: Common & { item: ItemRef }) {
    return this.orchestrator.submit(tenant, { task: 'PRODUCT_ANALYSIS', language: this.language(i.language), item: this.item(i.item), instructions: this.instructions(i.instructions) });
  }

  /** A caption, ad copy or script for a platform. A draft only: publication still needs the merchant's individual approval. */
  async generateMarketingCopy(tenant: TenantContext, i: Common & { format: string; tone?: string; purpose?: string; item?: ItemRef | null }) {
    return this.orchestrator.submit(tenant, {
      task: 'CONTENT', format: this.pick<AiFormat>(i.format, AI_FORMATS, 'INSTAGRAM_CAPTION', 'format'), language: this.language(i.language), item: i.item ? this.item(i.item) : null,
      instructions: this.instructions(i.instructions), tone: this.pick<AiTone>(i.tone, AI_TONES, 'FRIENDLY', 'tone'), purpose: this.pick<AiContentPurpose>(i.purpose, AI_CONTENT_PURPOSES, 'PROMOTIONAL', 'purpose'),
    });
  }

  /** Name used by the N23.1 specification; identical to generateMarketingCopy. */
  async generateMarketingContent(tenant: TenantContext, i: Parameters<OpenAIProviderService['generateMarketingCopy']>[1]) {
    return this.generateMarketingCopy(tenant, i);
  }

  /** Audience ideas for one item: the `customerSegments` of its analysis (name and reason, from verified data). Non-sensitive by construction. */
  async suggestAudience(tenant: TenantContext, i: Common & { item: ItemRef }) {
    return this.analyzeProduct(tenant, i);
  }
  /** Reads the audience out of a finished product analysis. */
  static audienceOf(output: unknown): Array<{ name: string; reason: string }> {
    const segments = (output as { customerSegments?: Array<{ name: string; reason: string }> } | null)?.customerSegments;
    return Array.isArray(segments) ? segments.map((s) => ({ name: String(s.name), reason: String(s.reason) })) : [];
  }

  /** Explains the measured results of an evaluated campaign. The figures come from TOUMA's own report; no sales claim, no spend advice. */
  async analyzeCampaign(tenant: TenantContext, i: Common & { campaignId: string }) {
    if (typeof i.campaignId !== 'string' || !ID_REGEX.test(i.campaignId)) throw bad('campaignId is invalid');
    return this.orchestrator.submit(tenant, { task: 'CAMPAIGN_ANALYSIS', language: this.language(i.language), campaignId: i.campaignId, instructions: this.instructions(i.instructions) });
  }

  /**
   * Drafts the answer to the customer's last question in a conversation, from verified data. The draft is for a person to review: this
   * method never sends anything. `mode` says what the merchant chose for automatic answers (they are only sent by the customer chat
   * itself, and only in AUTO); a PAUSED agent produces no draft.
   */
  async answerCustomerQuestion(tenant: TenantContext, conversationId: string) {
    if (typeof conversationId !== 'string' || !ID_REGEX.test(conversationId)) throw bad('conversationId is invalid');
    const cfg = await this.sales.config(tenant.businessId);
    const mode = !cfg.enabled ? ('PAUSED' as const) : cfg.replyMode === 'AUTO' && cfg.autoReplyAuthorizedAt ? ('AUTO' as const) : ('MANUAL' as const);
    if (mode === 'PAUSED') return { drafted: false as const, mode, autoSendAllowed: false, reason: 'The sales agent is paused' };
    const r = await this.sales.suggestReply(tenant, conversationId);
    return r.ok ? { drafted: true as const, mode, autoSendAllowed: false, messageId: r.messageId } : { drafted: false as const, mode, autoSendAllowed: false, reason: r.error };
  }
}
