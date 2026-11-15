import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@touma/database';
import { AGENT_CATEGORIES, BUILDER_LANGUAGES, BUILDER_PROVIDERS, BUILDER_TONES, BUILDER_TOOLS, hasErrors, MOCK_MODEL, normalizeConfig, validateBuilderConfig, type AgentBuilderConfig, type BuilderIssue } from '@touma/shared';
import { AgentGuardian } from '../agents/agent-guardian.service';
import { KillSwitchService } from '../agents/kill-switch.service';
import { AuditService } from '../audit/audit.service';
import { AppEnv, InjectEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { runSandbox } from './agent-sandbox';

const hashOf = (c: AgentBuilderConfig) => createHash('sha256').update(JSON.stringify(c)).digest('hex');
const http = (code: string, message: string, status: HttpStatus) => new HttpException({ code, message }, status);
const view = (d: { id: string; name: string; category: string; status: string; config: unknown; configHash: string; revision: number; duplicatedFromId: string | null; createdAt: Date; updatedAt: Date }, issues: BuilderIssue[]) =>
  ({ id: d.id, name: d.name, category: d.category, status: d.status, revision: d.revision, config: d.config, configHash: d.configHash, duplicatedFromId: d.duplicatedFromId, createdAt: d.createdAt, updatedAt: d.updatedAt, issues, valid: !hasErrors(issues) });

/**
 * Custom agents defined without code (N23, first slice): create, save a draft, validate, duplicate, archive and TEST in a simulator. An agent stays a DRAFT here:
 * activation, versions, workflows, memory and real tools come in later, separately verified phases. Every rule is enforced by the server; the plan (subscription,
 * agent count, monthly budget) is read from the existing billing guardian.
 */
@Injectable()
export class AgentBuilderService {
  constructor(private readonly prisma: PrismaService, private readonly guardian: AgentGuardian, private readonly kill: KillSwitchService, private readonly audit: AuditService, @InjectEnv() private readonly env: AppEnv) {}

  private allowedModels() { return [MOCK_MODEL, ...this.env.AGENT_ALLOWED_MODELS]; }

  /** Subscription and plan, from the same source as the other agents. */
  private async plan(businessId: string) {
    const L = await this.guardian.limitsFor(businessId);
    if (L.hasSubscription ? !L.access.hasAccess : this.env.BILLING_ENFORCEMENT_ENABLED && !L.founder) throw http('SUBSCRIPTION_REQUIRED', 'An active trial or subscription is required', HttpStatus.PAYMENT_REQUIRED);
    if (L.features && !L.features.includes('agents')) throw http('FEATURE_NOT_IN_PLAN', 'AI agents are not included in your plan', HttpStatus.PAYMENT_REQUIRED);
    return L;
  }

  private async issues(businessId: string, c: AgentBuilderConfig) {
    const L = await this.guardian.limitsFor(businessId);
    return validateBuilderConfig(c, { allowedModels: this.allowedModels(), maxMonthlyMicros: Number(L.budgetLimitMicros) });
  }

  options() {
    return { categories: AGENT_CATEGORIES, tones: BUILDER_TONES, languages: BUILDER_LANGUAGES, providers: BUILDER_PROVIDERS.map((p) => ({ id: p, available: p === 'mock', note: p === 'mock' ? 'Simulator: no cost, no network.' : 'Not enabled: needs an authorized provider. Tests always use the simulator.' })), models: this.allowedModels(), tools: BUILDER_TOOLS, modes: { HYBRID: 'Risky or outward actions wait for a person.', AUTO: 'Allowed actions run by themselves inside your publishing policy; risky content still waits.' }, note: 'Nothing here is connected to a real service. External tools stay disabled until an authorized connection exists.' };
  }

  async list(t: TenantContext) {
    const rows = await this.prisma.agentDefinition.findMany({ where: { businessId: t.businessId, status: { not: 'ARCHIVED' } }, orderBy: { updatedAt: 'desc' }, take: 100 });
    return Promise.all(rows.map(async (d) => view(d, await this.issues(t.businessId, d.config as unknown as AgentBuilderConfig))));
  }

  private async find(t: TenantContext, id: string) {
    const d = await this.prisma.agentDefinition.findFirst({ where: { id, businessId: t.businessId } });
    if (!d) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Agent not found' });
    return d;
  }

  async get(t: TenantContext, id: string) {
    const d = await this.find(t, id);
    return view(d, await this.issues(t.businessId, d.config as unknown as AgentBuilderConfig));
  }

  /** Saves a draft. It may be incomplete: the issues are returned and a draft with errors simply cannot be tested yet. */
  async create(t: TenantContext, raw: unknown) {
    const L = await this.plan(t.businessId);
    const c = normalizeConfig(raw);
    if (L.maxAgentInstances !== null) {
      const count = await this.prisma.agentDefinition.count({ where: { businessId: t.businessId, status: { not: 'ARCHIVED' } } });
      if (count >= L.maxAgentInstances) throw http('AGENT_LIMIT_REACHED', `Your plan allows at most ${L.maxAgentInstances} agents`, HttpStatus.CONFLICT);
    }
    return this.persist(t, () => this.prisma.agentDefinition.create({ data: { businessId: t.businessId, name: c.name || `Untitled agent ${Date.now().toString(36)}`, category: c.category, config: c as unknown as Prisma.InputJsonObject, configHash: hashOf(c), createdById: t.userId, updatedById: t.userId } }), 'agent_builder.created');
  }

  async update(t: TenantContext, id: string, raw: unknown) {
    await this.plan(t.businessId);
    const cur = await this.find(t, id);
    if (cur.status === 'ARCHIVED') throw new ConflictException({ code: 'ARCHIVED', message: 'An archived agent cannot be edited' });
    const c = normalizeConfig(raw);
    const h = hashOf(c);
    return this.persist(t, () => this.prisma.agentDefinition.update({ where: { id }, data: { name: c.name || cur.name, category: c.category, config: c as unknown as Prisma.InputJsonObject, configHash: h, revision: h === cur.configHash ? cur.revision : cur.revision + 1, updatedById: t.userId } }), 'agent_builder.updated');
  }

  private async persist(t: TenantContext, op: () => Promise<{ id: string; name: string; category: string; status: string; config: unknown; configHash: string; revision: number; duplicatedFromId: string | null; createdAt: Date; updatedAt: Date }>, action: string) {
    try {
      const d = await op();
      await this.audit.record({ action, actorId: t.userId, businessId: t.businessId, entityType: 'AgentDefinition', entityId: d.id });
      return view(d, await this.issues(t.businessId, d.config as unknown as AgentBuilderConfig));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'NAME_TAKEN', message: 'An agent with this name already exists' });
      throw e;
    }
  }

  async validate(t: TenantContext, raw: unknown) {
    const c = normalizeConfig(raw);
    const issues = await this.issues(t.businessId, c);
    return { valid: !hasErrors(issues), issues, config: c };
  }

  /** A copy as a new DRAFT (same configuration, a free name); the original is untouched. */
  async duplicate(t: TenantContext, id: string) {
    const src = await this.find(t, id);
    const L = await this.plan(t.businessId);
    if (L.maxAgentInstances !== null && (await this.prisma.agentDefinition.count({ where: { businessId: t.businessId, status: { not: 'ARCHIVED' } } })) >= L.maxAgentInstances) throw http('AGENT_LIMIT_REACHED', `Your plan allows at most ${L.maxAgentInstances} agents`, HttpStatus.CONFLICT);
    const base = `${src.name} (copy)`.slice(0, 56);
    let name = base;
    for (let i = 2; await this.prisma.agentDefinition.count({ where: { businessId: t.businessId, name } }); i++) name = `${base} ${i}`;
    const c = { ...(src.config as unknown as AgentBuilderConfig), name };
    return this.persist(t, () => this.prisma.agentDefinition.create({ data: { businessId: t.businessId, name, category: src.category, config: c as unknown as Prisma.InputJsonObject, configHash: hashOf(c), duplicatedFromId: src.id, createdById: t.userId, updatedById: t.userId } }), 'agent_builder.duplicated');
  }

  /** Archived agents no longer count against the plan; their history stays. */
  async archive(t: TenantContext, id: string) {
    await this.find(t, id);
    const d = await this.prisma.agentDefinition.update({ where: { id }, data: { status: 'ARCHIVED', updatedById: t.userId } });
    await this.audit.record({ action: 'agent_builder.archived', actorId: t.userId, businessId: t.businessId, entityType: 'AgentDefinition', entityId: id });
    return view(d, []);
  }

  /**
   * Tests the CURRENT saved configuration in the simulator. Refused when the configuration has errors, when an emergency stop is on, when the subscription is not
   * active or when the daily test quota is used. Writes only the test record: no usage, reservation, publication or business data is touched.
   */
  async test(t: TenantContext, id: string, input: string) {
    await this.plan(t.businessId);
    const stop = await this.kill.active(t.businessId);
    if (stop) throw http('AGENTS_STOPPED', `Agents are stopped by an administrator (${stop.scope})`, HttpStatus.SERVICE_UNAVAILABLE);
    const d = await this.find(t, id);
    if (d.status === 'ARCHIVED') throw new ConflictException({ code: 'ARCHIVED', message: 'An archived agent cannot be tested' });
    const since = new Date(Date.now() - 86_400_000);
    if ((await this.prisma.agentTestRun.count({ where: { businessId: t.businessId, createdAt: { gte: since } } })) >= this.env.AGENT_BUILDER_TESTS_PER_DAY) throw http('TEST_QUOTA', `The limit of ${this.env.AGENT_BUILDER_TESTS_PER_DAY} tests per day was reached`, HttpStatus.TOO_MANY_REQUESTS);
    const c = d.config as unknown as AgentBuilderConfig;
    const issues = await this.issues(t.businessId, c);
    const base = { businessId: t.businessId, definitionId: d.id, configHash: d.configHash, revision: d.revision, input: input.slice(0, 1000), createdById: t.userId };
    if (hasErrors(issues)) {
      const row = await this.prisma.agentTestRun.create({ data: { ...base, status: 'INVALID_CONFIG', trace: issues as unknown as Prisma.InputJsonArray } });
      return { id: row.id, status: 'INVALID_CONFIG', simulated: true, issues, output: null, trace: [], cost: { estimatedMicros: 0, note: 'Nothing was run.' } };
    }
    const r = runSandbox(c, input);
    const row = await this.prisma.agentTestRun.create({ data: { ...base, status: r.status, output: r.output as unknown as Prisma.InputJsonObject, trace: r.trace as unknown as Prisma.InputJsonArray, inputTokens: r.inputTokens, outputTokens: r.outputTokens } });
    return { id: row.id, status: r.status, simulated: true, configHash: d.configHash, revision: d.revision, output: r.output, trace: r.trace, tokens: { input: r.inputTokens, output: r.outputTokens, estimated: true }, cost: { estimatedMicros: 0, note: 'Simulator: no model call, no cost. Real runs will be priced and capped by the plan.' } };
  }

  async tests(t: TenantContext, id: string) {
    await this.find(t, id);
    return this.prisma.agentTestRun.findMany({ where: { businessId: t.businessId, definitionId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, status: true, revision: true, configHash: true, input: true, createdAt: true } });
  }
}
