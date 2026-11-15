import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { integrationStatus } from '@touma/config';
import { AppEnv, InjectEnv } from '../config';

/**
 * What this deployment offers (Phase N14). Booleans only, for signed-in users: the web app hides the modules that are switched
 * off instead of showing screens that cannot work. The API still enforces every flag itself.
 */
@ApiTags('features')
@ApiBearerAuth()
@Controller('features')
export class FeaturesController {
  constructor(@InjectEnv() private readonly env: AppEnv) {}

  @Get()
  features() {
    const i = integrationStatus(this.env);
    return {
      workflows: this.env.ORCHESTRATOR_ENABLED && this.env.WORKFLOWS_ENABLED,
      market: this.env.MARKET_INTELLIGENCE_ENABLED,
      salesAssist: this.env.SALES_ASSIST_ENABLED,
      campaigns: this.env.CAMPAIGNS_ENABLED,
      intelligence: this.env.INTELLIGENCE_ENABLED,
      autopilot: this.env.AUTOPILOT_ENABLED,
      billing: this.env.BILLING_ENABLED,
      agents: this.env.AGENTS_ENABLED,
      autopublish: this.env.AUTOPUBLISH_ENABLED,
      learning: this.env.LEARNING_ENABLED,
      agentBuilder: this.env.AGENT_BUILDER_ENABLED,
      ai: i.openai,
      media: i.storage,
    };
  }
}
