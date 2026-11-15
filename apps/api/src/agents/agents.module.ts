import { Module, OnModuleInit, Injectable } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BillingCoreModule } from '../billing/billing.module';
import { FounderService } from '../billing/founder.service';
import { NotificationsCoreModule } from '../notifications/notifications.module';
import { RunsCoreModule } from '../runs/runs.module';
import { AgentAdapters } from './agent-adapters';
import { AgentGuardian } from './agent-guardian.service';
import { AgentRunner } from './agent-runner';
import { AgentsAdminController } from './agents-admin.controller';
import { AgentsAdminService } from './agents-admin.service';
import { AgentsEnabledGuard } from './agents.guard';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { ApprovalsService } from './approvals.service';
import { ConversationStore } from './conversation.store';
import { KillSwitchService } from './kill-switch.service';
import { ModelRouter } from './model-router';
import { PricesService } from './prices.service';
import { ToolRegistry } from './tool-registry';

/** Periodic housekeeping: stale reservations are reconciled (released), expired conversations purged, prices seeded from configuration. */
@Injectable()
export class AgentsHousekeeping implements OnModuleInit {
  private timer?: NodeJS.Timeout;
  constructor(private readonly guardian: AgentGuardian, private readonly prices: PricesService, private readonly conversations: ConversationStore) {}
  async onModuleInit() {
    await this.prices.ensureConfigured().catch(() => undefined);
    if (process.env.APP_ENV === 'test' && process.env.AGENTS_HOUSEKEEPING !== 'true') return;
    this.timer = setInterval(() => { void this.guardian.reconcileStale().catch(() => undefined); void this.conversations.purgeExpired().catch(() => undefined); }, 60_000);
    this.timer.unref();
  }
}

/** Everything the agents need without HTTP (also imported by the standalone worker so its process runs the adapters and the run guard). */
@Module({
  imports: [AuditModule, RunsCoreModule, BillingCoreModule, NotificationsCoreModule],
  providers: [AgentGuardian, KillSwitchService, ModelRouter, PricesService, ConversationStore, ToolRegistry, AgentRunner, ApprovalsService, AgentAdapters, AgentsHousekeeping, FounderService],
  exports: [AgentGuardian, KillSwitchService, ModelRouter, PricesService, ConversationStore, ApprovalsService, AgentRunner],
})
export class AgentsCoreModule {}

@Module({
  imports: [AgentsCoreModule, RunsCoreModule, AuditModule],
  controllers: [AgentsController, AgentsAdminController],
  providers: [AgentsService, AgentsAdminService, AgentsEnabledGuard],
})
export class AgentsModule {}

