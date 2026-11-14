import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CAMPAIGN_GOALS, CAMPAIGN_LIMITS, SOCIAL_PLATFORMS } from '@touma/shared';
import { PageQueryDto } from '../common/pagination';
import { ID_REGEX } from '../common/validators';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateCampaignDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(CAMPAIGN_LIMITS.nameMax)
  name: string;

  @ApiProperty({ enum: CAMPAIGN_GOALS }) @IsIn(CAMPAIGN_GOALS as unknown as string[])
  goalType: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(CAMPAIGN_LIMITS.goalTextMax)
  goalText?: string;

  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(CAMPAIGN_LIMITS.productsMax) @ArrayUnique() @IsString({ each: true }) @Matches(ID_REGEX, { each: true })
  productIds: string[];
}

export class PlanCampaignDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(CAMPAIGN_LIMITS.daysMax)
  days?: number;

  @ApiPropertyOptional({ example: '2026-12-01' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate?: string;

  @ApiPropertyOptional({ enum: ['en', 'fr'], isArray: true }) @IsOptional() @IsArray() @ArrayMaxSize(2) @ArrayUnique() @IsIn(['en', 'fr'], { each: true })
  languages?: Array<'en' | 'fr'>;

  @ApiPropertyOptional({ enum: SOCIAL_PLATFORMS, isArray: true }) @IsOptional() @IsArray() @ArrayMaxSize(5) @ArrayUnique() @IsIn(SOCIAL_PLATFORMS as unknown as string[], { each: true })
  platforms?: string[];
}

export class EvaluateCampaignDto {
  @ApiPropertyOptional({ description: 'Read fresh metrics from the platform first (read-only, only when the account permits it).' }) @IsOptional() @Transform(({ value }) => value === true || value === 'true')
  refresh?: boolean;
}

export class CampaignsQueryDto extends PageQueryDto {}
