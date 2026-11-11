import type { ZodTypeAny, z } from 'zod';
import type { AiTask } from '@touma/shared';
import type { BusinessContext } from '../context';

export type AgentName = 'BUSINESS_ANALYST' | 'PRODUCT_ANALYST' | 'MARKETING_STRATEGIST' | 'CONTENT_CREATOR' | 'VIDEO_CREATOR';

export interface AgentDefinition<I, S extends ZodTypeAny> {
  agent: AgentName;
  task: AiTask;
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
  /** Task-specific checks, in addition to schema validation and grounding. */
  validate(output: z.infer<S>, ctx: BusinessContext, input: I): string[];
}
