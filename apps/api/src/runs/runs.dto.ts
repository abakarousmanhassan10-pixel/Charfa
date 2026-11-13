import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional } from 'class-validator';
import { PageQueryDto } from '../common/pagination';
import { RUN_TEMPLATE_NAMES } from './run-templates';

export const RUN_STATUSES = ['PENDING', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED'] as const;
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
}
