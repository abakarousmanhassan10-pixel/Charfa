import { Injectable } from '@nestjs/common';
import { AGENT_CATALOG, type AgentConfig, type AgentTypeName, type ModelTier } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';
import { GuardianDenied } from './agent-errors';
import { HttpStatus } from '@nestjs/common';

export interface RouteDecision { modelId: string; tier: Exclude<ModelTier, 'auto'>; reason: string }
const UP: Record<'economy' | 'standard' | 'advanced', 'economy' | 'standard' | 'advanced'> = { economy: 'standard', standard: 'advanced', advanced: 'advanced' };

/**
 * Chooses the model for an agent call from the server's configuration: an economical tier for simple tasks and a stronger one for complex tasks.
 * It never invents model names: the models come from AGENT_MODEL_TIERS (or AI_MODEL) and an explicit per-agent model must be on the server's allowed list.
 * Whether those names really exist and are accessible has to be checked against the provider's model list when the real API is configured.
 */
@Injectable()
export class ModelRouter {
  constructor(@InjectEnv() private readonly env: AppEnv) {}

  tierModel(tier: 'economy' | 'standard' | 'advanced'): string {
    return this.env.AGENT_MODEL_TIERS[tier] ?? this.env.AI_MODEL;
  }

  allowedModels(): string[] {
    const set = new Set<string>([this.env.AI_MODEL, ...Object.values(this.env.AGENT_MODEL_TIERS), ...this.env.AGENT_ALLOWED_MODELS]);
    return [...set];
  }

  route(type: AgentTypeName, config: Pick<AgentConfig, 'modelTier' | 'model'>, inputChars: number): RouteDecision {
    if (config.model) {
      if (!this.allowedModels().includes(config.model)) throw new GuardianDenied('MODEL_NOT_ALLOWED', 'This model is not on the server\'s allowed list', HttpStatus.BAD_REQUEST);
      return { modelId: config.model, tier: 'standard', reason: 'explicit_model' };
    }
    if (config.modelTier !== 'auto') return { modelId: this.tierModel(config.modelTier), tier: config.modelTier, reason: 'configured_tier' };
    // auto: simple tasks use the economical tier, complex ones the standard tier; a large input moves one tier up.
    let tier: 'economy' | 'standard' | 'advanced' = AGENT_CATALOG[type].complexity === 'simple' ? 'economy' : 'standard';
    let reason = AGENT_CATALOG[type].complexity === 'simple' ? 'auto_simple' : 'auto_complex';
    if (inputChars > 6000) { tier = UP[tier]; reason += '_large_input'; }
    return { modelId: this.tierModel(tier), tier, reason };
  }
}
