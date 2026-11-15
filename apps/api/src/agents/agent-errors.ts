import { HttpException, HttpStatus } from '@nestjs/common';

/** A policy refused an agent action (subscription, plan, quota, budget, stop switch). `status` is the HTTP code when it happens during an API request. */
export class GuardianDenied extends Error {
  constructor(readonly code: string, message: string, readonly status: HttpStatus = HttpStatus.FORBIDDEN) {
    super(message);
    this.name = 'GuardianDenied';
  }
  toHttp() {
    return new HttpException({ code: this.code, message: this.message }, this.status);
  }
}

export const DENIED = {
  stopped: (scope: string) => new GuardianDenied('AGENTS_STOPPED', `Agents are stopped by an administrator (${scope})`, HttpStatus.SERVICE_UNAVAILABLE),
  subscription: () => new GuardianDenied('SUBSCRIPTION_REQUIRED', 'An active trial or subscription is required to run agents', HttpStatus.PAYMENT_REQUIRED),
  feature: () => new GuardianDenied('FEATURE_NOT_IN_PLAN', 'AI agents are not included in your plan', HttpStatus.PAYMENT_REQUIRED),
  agentType: () => new GuardianDenied('AGENT_NOT_IN_PLAN', 'This kind of agent is not included in your plan', HttpStatus.PAYMENT_REQUIRED),
  instances: (max: number) => new GuardianDenied('AGENT_LIMIT_REACHED', `Your plan allows at most ${max} agents`, HttpStatus.CONFLICT),
  disabled: () => new GuardianDenied('AGENT_DISABLED', 'This agent is disabled', HttpStatus.CONFLICT),
  calls: () => new GuardianDenied('CALLS_QUOTA_EXHAUSTED', 'The agent call quota of this billing period is used up', HttpStatus.TOO_MANY_REQUESTS),
  budget: () => new GuardianDenied('BUDGET_EXHAUSTED', 'The AI budget of this billing period is used up', HttpStatus.TOO_MANY_REQUESTS),
  daily: () => new GuardianDenied('DAILY_CAP_REACHED', 'The daily AI spending cap is reached', HttpStatus.TOO_MANY_REQUESTS),
  monthly: () => new GuardianDenied('MONTHLY_CAP_REACHED', 'The AI spending cap of this period is reached', HttpStatus.TOO_MANY_REQUESTS),
  run: () => new GuardianDenied('RUN_CAP_REACHED', 'The spending cap of this task is reached', HttpStatus.TOO_MANY_REQUESTS),
  agentDaily: () => new GuardianDenied('AGENT_DAILY_LIMIT', 'This agent reached its daily call limit', HttpStatus.TOO_MANY_REQUESTS),
};
