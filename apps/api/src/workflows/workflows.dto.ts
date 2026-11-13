import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const WORKFLOW_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9 _-]{1,59}$/;

export class CreateWorkflowDto {
  @ApiProperty({ description: '2-60 characters: letters, digits, space, - and _' })
  @Matches(WORKFLOW_NAME_REGEX)
  name: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ description: 'Validated definition document: triggers, input spec, steps (see docs/WORKFLOWS.md). Never code.' })
  @IsObject()
  definition: Record<string, unknown>;
}

export class UpdateWorkflowDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ description: 'The new definition: saved as a NEW version; executions in progress keep theirs' })
  @IsObject()
  definition: Record<string, unknown>;
}

export class StartExecutionDto {
  @ApiPropertyOptional({ description: 'Execution input, checked against the workflow input spec' })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}
