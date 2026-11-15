import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

export type ControlScopeName = 'GLOBAL' | 'TENANT' | 'AGENT';

/**
 * Emergency stop switches: all agents (GLOBAL), the agents and tasks of one business (TENANT), or one agent (AGENT). While a switch is on nothing new
 * starts, no model is called and no step that acts outside TOUMA runs. Checked at admission, right before every step, and before every outward action.
 * Switching is audited. A stop never deletes anything and never cancels in-flight work silently: blocked runs can be retried after a resume.
 */
@Injectable()
export class KillSwitchService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** The first active switch that applies to this business/agent, or null. */
  async active(businessId: string, agentId?: string | null): Promise<{ scope: ControlScopeName; reason: string | null } | null> {
    const keys: Array<{ scope: ControlScopeName; scopeId: string }> = [{ scope: 'GLOBAL', scopeId: '' }, { scope: 'TENANT', scopeId: businessId }, ...(agentId ? [{ scope: 'AGENT' as const, scopeId: agentId }] : [])];
    const rows = await this.prisma.agentControl.findMany({ where: { stopped: true, OR: keys } });
    const hit = keys.map((k) => rows.find((r) => r.scope === k.scope && r.scopeId === k.scopeId)).find(Boolean);
    return hit ? { scope: hit.scope, reason: hit.reason } : null;
  }

  async list() {
    return this.prisma.agentControl.findMany({ where: { stopped: true }, orderBy: { changedAt: 'desc' } });
  }

  async set(scope: ControlScopeName, scopeId: string, stopped: boolean, reason: string | null, actorId: string) {
    const id = scope === 'GLOBAL' ? '' : scopeId;
    const row = await this.prisma.agentControl.upsert({
      where: { scope_scopeId: { scope, scopeId: id } },
      create: { scope, scopeId: id, stopped, reason, changedById: actorId },
      update: { stopped, reason, changedById: actorId, changedAt: new Date() },
    });
    await this.audit.record({ action: stopped ? 'agents.stopped' : 'agents.resumed', actorId, businessId: scope === 'TENANT' ? scopeId : null, entityType: 'AgentControl', entityId: row.id, metadata: { scope, scopeId: id, reason: reason?.slice(0, 200) } });
    return row;
  }
}
