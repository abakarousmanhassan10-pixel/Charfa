import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { AgentRun, AgentRunStep } from '@touma/database';
import { AGENT_CATALOG, AGENT_TYPES, type AgentTypeName } from '@touma/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RUN_ADAPTER_REGISTRY, RunStepBlocked, RunStepError, type RunAdapter, type RunAdapterRegistry } from '../runs/run-adapters';
import type { RunGuard } from '../runs/runs.service';
import { RunsService } from '../runs/runs.service';
import { AgentGuardian } from './agent-guardian.service';
import { GuardianDenied } from './agent-errors';
import { AgentRunner } from './agent-runner';
import { KillSwitchService } from './kill-switch.service';
import { contentHash } from './tool-registry';

export const AGENT_TEMPLATE_PREFIX = 'agents-';

/**
 * Plugs the agents into the run engine: one adapter per agent kind, plus the SIMULATED publication step (external, so it always needs a human approval and
 * is bound to a single-use approval of the exact content version). Also registers the run guard: the stop switches (for every outward step of any run and for
 * every step of an agent task) and, for agent tasks, the subscription, so an expired subscription blocks a task that was queued earlier.
 */
@Injectable()
export class AgentAdapters implements OnModuleInit, RunGuard {
  constructor(
    private readonly runner: AgentRunner,
    private readonly runs: RunsService,
    private readonly guardian: AgentGuardian,
    private readonly kill: KillSwitchService,
    private readonly prisma: PrismaService,
    @Inject(RUN_ADAPTER_REGISTRY) private readonly registry: RunAdapterRegistry,
  ) {}

  onModuleInit() {
    for (const kind of AGENT_TYPES) {
      const adapter: RunAdapter = { name: `agent.${kind.toLowerCase()}`, external: false, execute: (ctx) => this.runner.execute(kind, ctx) };
      this.registry.register?.(adapter);
    }
    this.registry.register?.({ name: 'agent.publish-simulated', external: true, execute: (ctx) => this.publishSimulated(ctx) });
    this.runs.setGuard(this);
  }

  async check(run: AgentRun, step: AgentRunStep, external: boolean): Promise<{ code: string; message: string } | null> {
    const isAgentRun = run.template.startsWith(AGENT_TEMPLATE_PREFIX);
    if (!isAgentRun && !external) return null;
    const stop = await this.kill.active(run.businessId);
    if (stop) return { code: 'AGENTS_STOPPED', message: `Stopped by an administrator (${stop.scope})` };
    if (!isAgentRun) return null;
    try {
      await this.guardian.assertMayRun(run.businessId, null);
    } catch (e) {
      if (e instanceof GuardianDenied) return { code: e.code, message: e.message };
      throw e;
    }
    void step;
    return null;
  }

  /** Simulated publication: no network is contacted. It needs an APPROVED, unused approval of the content version that exists NOW, and consumes it. */
  private async publishSimulated(ctx: { runId: string; stepKey: string; businessId: string }): Promise<Record<string, unknown>> {
    const stop = await this.kill.active(ctx.businessId);
    if (stop) throw new RunStepBlocked('AGENTS_STOPPED', `Stopped by an administrator (${stop.scope})`);
    const approval = await this.prisma.agentApproval.findFirst({ where: { runId: ctx.runId, stepKey: ctx.stepKey, businessId: ctx.businessId, status: 'APPROVED', consumedAt: null }, orderBy: { createdAt: 'desc' } });
    if (!approval) throw new RunStepError('APPROVAL_REQUIRED', 'No valid approval exists for this publication', false);
    const c = await this.prisma.content.findFirst({ where: { id: approval.contentId, businessId: ctx.businessId, deletedAt: null }, select: { title: true, caption: true, hashtags: true } });
    const current = c ? contentHash({ title: c.title, body: c.caption, hashtags: c.hashtags, platform: approval.channel }) : null;
    if (current !== approval.contentHash) {
      await this.prisma.agentApproval.updateMany({ where: { id: approval.id, status: 'APPROVED' }, data: { status: 'SUPERSEDED' } });
      throw new RunStepError('APPROVAL_STALE', 'The content changed after it was approved: a new approval is needed', false);
    }
    const used = await this.prisma.agentApproval.updateMany({ where: { id: approval.id, status: 'APPROVED', consumedAt: null }, data: { status: 'CONSUMED', consumedAt: new Date() } });
    if (!used.count) throw new RunStepError('APPROVAL_ALREADY_USED', 'This approval was already used', false);
    return { simulated: true, published: false, channel: approval.channel, contentId: approval.contentId, contentHash: approval.contentHash, note: 'Simulation: no social network was contacted' };
  }
}

/** Plan of an agent task: research -> content -> supervision -> publication (simulated, approval required). */
export const AGENT_TEMPLATES: Record<string, { steps: Array<{ key: string; adapter: string; dependsOn: string[]; requiresApproval: boolean }>; kinds: AgentTypeName[] }> = {
  'agents-research-brief': { kinds: ['RESEARCH'], steps: [{ key: 'research', adapter: 'agent.research', dependsOn: [], requiresApproval: false }] },
  'agents-support-reply': { kinds: ['SUPPORT'], steps: [{ key: 'support', adapter: 'agent.support', dependsOn: [], requiresApproval: false }] },
  'agents-analytics-report': { kinds: ['ANALYTICS'], steps: [{ key: 'analytics', adapter: 'agent.analytics', dependsOn: [], requiresApproval: false }] },
  'agents-content-launch': {
    kinds: ['RESEARCH', 'CONTENT', 'SUPERVISOR'],
    steps: [
      { key: 'research', adapter: 'agent.research', dependsOn: [], requiresApproval: false },
      { key: 'content', adapter: 'agent.content', dependsOn: ['research'], requiresApproval: false },
      { key: 'review', adapter: 'agent.supervisor', dependsOn: ['content'], requiresApproval: false },
      { key: 'publish', adapter: 'agent.publish-simulated', dependsOn: ['review'], requiresApproval: true },
    ],
  },
};
void AGENT_CATALOG;
