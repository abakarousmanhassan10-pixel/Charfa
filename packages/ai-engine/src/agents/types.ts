import type { ZodTypeAny, z } from 'zod';
import type { AiTask } from '@touma/shared';
import type { BusinessContext } from '../context';

export type AgentName = 'BUSINESS_ANALYST' | 'PRODUCT_ANALYST' | 'MARKETING_STRATEGIST' | 'CONTENT_CREATOR' | 'VIDEO_CREATOR' | 'SCHEDULER' | 'CUSTOMER_SUPPORT' | 'PERFORMANCE_ANALYST';

export interface AgentDefinition<I, S extends ZodTypeAny> {
  agent: AgentName;
  /** Generation tasks of the content pipeline, or CUSTOMER_CHAT (a conversation turn: not stored as a generation). */
  task: AiTask | 'CUSTOMER_CHAT';
  /** Bump whenever the prompt or schema changes; stored with every generation for traceability. */
  promptVersion: string;
  schemaName: string;
  schema: S;
  defaultTemperature: number;
  system(input: I): string;
  /** Trusted, structured task parameters (enums/ids only). */
  taskParams(input: I): Record<string, unknown>;
  /** Optional narrowing of the context sent to the model (least data necessary). */
  scopeContext?(ctx: BusinessContext, input: I): unknown;
  /**
   * Optional lossless clean-up of cosmetic problems (for example a repeated hashtag in another case) before validation, so a harmless
   * detail does not fail a whole generation. It must never change a fact, a price or a claim.
   */
  normalize?(output: z.infer<S>): z.infer<S>;
  /** Task-specific checks, in addition to schema validation and grounding. */
  validate(output: z.infer<S>, ctx: BusinessContext, input: I): string[];
}
