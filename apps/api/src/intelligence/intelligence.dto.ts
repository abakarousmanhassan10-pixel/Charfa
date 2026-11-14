import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ID_REGEX } from '../common/validators';
import { MEMORY_KINDS, PROVENANCE } from './memory.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class PutMemoryDto {
  @ApiProperty({ enum: MEMORY_KINDS }) @IsIn(MEMORY_KINDS as unknown as string[])
  kind: string;

  @ApiProperty() @IsString() @MaxLength(80)
  key: string;

  @ApiProperty({ description: 'A small object. E-mail addresses and phone numbers are refused.' }) @IsObject()
  value: Record<string, unknown>;

  @ApiProperty({ enum: PROVENANCE }) @IsIn(PROVENANCE as unknown as string[])
  provenance: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80)
  sourceRef?: string;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(730)
  retentionDays?: number;
}

export class ForgetMemoryDto {
  @ApiPropertyOptional({ enum: MEMORY_KINDS }) @IsOptional() @IsIn(MEMORY_KINDS as unknown as string[])
  kind?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80)
  key?: string;
}

export class CreateExperimentDto {
  @ApiProperty() @IsString() @Matches(ID_REGEX)
  campaignId: string;

  @ApiProperty() @Transform(trim) @IsString() @MinLength(10) @MaxLength(300)
  hypothesis: string;

  @ApiProperty({ enum: ['engagementRate', 'likes', 'reach'] }) @IsIn(['engagementRate', 'likes', 'reach'])
  metric: string;

  @ApiProperty() @IsString() @Matches(ID_REGEX)
  entryA: string;

  @ApiProperty() @IsString() @Matches(ID_REGEX)
  entryB: string;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(10) @Max(100000)
  minSamplePerArm?: number;
}

export class ImprovementDto {
  @ApiProperty() @IsString() @MaxLength(80)
  key: string;

  @ApiProperty() @Type(() => Number) @IsInt()
  value: number;
}
