import { Module } from '@nestjs/common';
import { AgentsCoreModule } from '../agents/agents.module';
import { AuditModule } from '../audit/audit.module';
import { AgentBuilderController, AgentBuilderEnabledGuard } from './agent-builder.controller';
import { AgentBuilderService } from './agent-builder.service';

@Module({ imports: [AgentsCoreModule, AuditModule], controllers: [AgentBuilderController], providers: [AgentBuilderService, AgentBuilderEnabledGuard] })
export class AgentBuilderModule {}
