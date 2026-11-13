import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../common/pagination';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Money is sent as a decimal string ("12.50"), never as a float. */
export const MONEY = /^\d{1,9}(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

export class ImportMarketProductDto {
  @ApiProperty({ maxLength: 160 }) @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) name: string;
  @ApiPropertyOptional({ maxLength: 60 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(60) category?: string;
  @ApiProperty({ description: 'Target market, ISO 3166-1 alpha-2', example: 'TD' }) @Matches(/^[A-Z]{2}$/) country: string;
  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(120) supplierName?: string;

  @ApiProperty({ description: 'Where the figures come from. It is stored and shown, never fetched.', maxLength: 500 }) @Transform(trim) @IsString() @MaxLength(500) sourceUrl: string;
  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @Transform(trim) @IsString() @MaxLength(120) sourceName?: string;
  @ApiProperty({ description: 'When the figures were true at the source (ISO 8601). Not the import time.' }) @IsISO8601() observedAt: string;

  @ApiProperty({ example: 'CNY' }) @Matches(CURRENCY) costCurrency: string;
  @ApiPropertyOptional({ example: '20.00' }) @IsOptional() @Matches(MONEY) unitCost?: string;
  @ApiPropertyOptional({ example: '5.00', description: 'Shipping per unit, in the cost currency' }) @IsOptional() @Matches(MONEY) shippingCost?: string;
  @ApiProperty({ example: 'USD' }) @Matches(CURRENCY) sellingCurrency: string;
  @ApiPropertyOptional({ example: '49.90' }) @IsOptional() @Matches(MONEY) sellingPrice?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 120 }) @IsOptional() @IsInt() @Min(1) @Max(120) estimatedDeliveryDays?: number;
  @ApiPropertyOptional({ example: '4.50', description: '0-5, with its source' }) @IsOptional() @Matches(/^(?:[0-4](?:\.\d{1,2})?|5(?:\.0{1,2})?)$/) supplierRating?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(120) supplierRatingSource?: string;
  @ApiPropertyOptional({ description: 'A measured figure from a named source: never an estimate made up to fill the field' }) @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000) monthlySearches?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(120) demandSource?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1_000_000) competitorCount?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(120) competitorSource?: string;
}

export class AnalyzeMarketProductDto {
  @ApiProperty({ description: 'Assumptions to compute with (payment fees, returns allowance, advertising cost per acquisition, exchange rates with a source and date). Anything left out stays UNKNOWN.' })
  @IsObject()
  assumptions: Record<string, unknown>;
}

export const FRESHNESS_FILTERS = ['FRESH', 'RECENT', 'STALE', 'OUTDATED'] as const;

export class ListMarketProductsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @Matches(/^[A-Z]{2}$/) country?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(60) category?: string;
  @ApiPropertyOptional({ enum: FRESHNESS_FILTERS }) @IsOptional() @IsIn(FRESHNESS_FILTERS as unknown as string[]) freshness?: (typeof FRESHNESS_FILTERS)[number];
}
