import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { AI_CONTENT_PURPOSES, AI_FORMATS, AI_LANGUAGES, AI_PLATFORMS, AI_TASKS, AI_TONES } from '@touma/shared';
import { PageQueryDto } from '../common/pagination';
import { ID_REGEX } from '../common/validators';

const trimOrUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);

class BaseAiDto {
  @ApiProperty({ enum: AI_LANGUAGES, description: 'Language of the generated output' })
  @IsIn(AI_LANGUAGES as unknown as string[])
  language: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Optional focus or style guidance. Treated as untrusted data; cannot override safety rules.' })
  @IsOptional()
  @Transform(trimOrUndefined)
  @IsString()
  @MaxLength(500)
  instructions?: string;
}

export class BusinessAnalysisDto extends BaseAiDto {}

export class ProductAnalysisDto extends BaseAiDto {
  @ApiProperty({ enum: ['PRODUCT', 'SERVICE'] }) @IsIn(['PRODUCT', 'SERVICE'])
  itemType: 'PRODUCT' | 'SERVICE';

  @ApiProperty() @IsString() @Matches(ID_REGEX)
  itemId: string;
}

export class StrategyDto extends BaseAiDto {
  @ApiProperty({ enum: AI_PLATFORMS, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsIn(AI_PLATFORMS as unknown as string[], { each: true })
  platforms: string[];

  @ApiPropertyOptional({ maxLength: 300, example: 'Increase weekday lunch orders' })
  @IsOptional()
  @Transform(trimOrUndefined)
  @IsString()
  @MaxLength(300)
  goal?: string;

  @ApiPropertyOptional({ type: [String], description: 'Product/service ids to feature (must be ACTIVE items of this business)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Matches(ID_REGEX, { each: true })
  focusItemIds?: string[];
}

export class ContentDto extends BaseAiDto {
  @ApiProperty({ enum: AI_FORMATS }) @IsIn(AI_FORMATS as unknown as string[])
  format: string;

  @ApiProperty({ enum: AI_CONTENT_PURPOSES }) @IsIn(AI_CONTENT_PURPOSES as unknown as string[])
  purpose: string;

  @ApiProperty({ enum: AI_TONES }) @IsIn(AI_TONES as unknown as string[])
  tone: string;

  @ApiPropertyOptional({ enum: ['PRODUCT', 'SERVICE'] }) @IsOptional() @IsIn(['PRODUCT', 'SERVICE'])
  itemType?: 'PRODUCT' | 'SERVICE';

  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID_REGEX)
  itemId?: string;
}

export class RegenerateDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trimOrUndefined)
  @IsString()
  @MaxLength(500)
  instructions?: string;
}

export class SaveDraftDto {
  @ApiPropertyOptional({ description: 'Edited content object (same schema as the generated output). Omit to save the output as generated.' })
  @IsOptional()
  @IsObject()
  output?: Record<string, unknown>;
}

export class GenerationQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: AI_TASKS }) @IsOptional() @IsIn(AI_TASKS as unknown as string[])
  task?: string;

  @ApiPropertyOptional({ enum: ['SUCCEEDED', 'FAILED', 'BLOCKED'] }) @IsOptional() @IsIn(['SUCCEEDED', 'FAILED', 'BLOCKED'])
  status?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID_REGEX)
  itemId?: string;
}

export class UsageQueryDto {
  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 366 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(366)
  days: number = 30;
}
