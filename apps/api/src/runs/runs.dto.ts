import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsObject, IsOptional, Matches } from 'class-validator';
import { PageQueryDto } from '../common/pagination';
import { RUN_TEMPLATE_NAMES } from './run-templates';

export const RUN_STATUSES = ['PENDING', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'PAUSED', 'CANCELLED'] as const;
/** Header value: 8-64 URL-safe characters, chosen by the client (a UUID is fine). */
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

export class CreateRunDto {
  @ApiProperty({ enum: RUN_TEMPLATE_NAMES, description: 'A predefined plan. Callers choose a template; they never submit their own steps.' })
  @IsIn(RUN_TEMPLATE_NAMES)
  template: string;

  @ApiProperty({ description: 'Template input, validated strictly (for the current template: { topic: string up to 200 characters }).' })
  @IsObject()
  input: Record<string, unknown>;
}

export class ListRunsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: RUN_STATUSES })
  @IsOptional()
  @IsIn(RUN_STATUSES as unknown as string[])
  status?: (typeof RUN_STATUSES)[number];

  @ApiPropertyOptional({ description: 'Only executions of this workflow' })
  @IsOptional()
  @Matches(/^[a-z0-9]{10,40}$/)
  workflowId?: string;

  @ApiPropertyOptional({ description: 'true: the dead-letter list (failed runs waiting for a person)' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  deadLettered?: boolean;
}

export class ResolveOutcomeDto {
  @ApiProperty({ enum: ['EXECUTED', 'NOT_EXECUTED'], description: 'Did the action really happen outside TOUMA?' })
  @IsIn(['EXECUTED', 'NOT_EXECUTED'])
  resolution: 'EXECUTED' | 'NOT_EXECUTED';
}
