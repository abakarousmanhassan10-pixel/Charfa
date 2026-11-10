import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { CATALOG_STATUSES, PRODUCT_AVAILABILITY } from '@touma/shared';
import { PageQueryDto } from '../common/pagination';
import { CleanList, HTTP_URL_REGEX, ID_REGEX, MONEY_REGEX, Trim, TrimToNull, Upper } from '../common/validators';

const MONEY_MSG = 'must be a positive decimal string with at most 2 decimals, e.g. "19.99"';

export class CreateProductDto {
  @ApiProperty({ example: 'Bissap juice 1L' }) @Trim() @IsString() @MinLength(1) @MaxLength(200)
  name: string;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @MaxLength(5000)
  description?: string | null;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @Matches(ID_REGEX)
  categoryId?: string | null;

  @ApiPropertyOptional({ example: '1500.00', description: 'Decimal string (never a float)' })
  @IsOptional() @TrimToNull() @IsString() @Matches(MONEY_REGEX, { message: `price ${MONEY_MSG}` })
  price?: string | null;

  @ApiPropertyOptional({ example: '1200.00', description: 'Must be lower than price' })
  @IsOptional() @TrimToNull() @IsString() @Matches(MONEY_REGEX, { message: `discountPrice ${MONEY_MSG}` })
  discountPrice?: string | null;

  @ApiPropertyOptional({ example: 'XAF', description: 'Defaults to the business currency' })
  @IsOptional() @Upper() @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @ApiPropertyOptional({ example: 'BSP-1L' }) @IsOptional() @TrimToNull() @IsString() @MaxLength(64) @Matches(/^[\w.\-/ ]+$/u, { message: 'sku contains invalid characters' })
  sku?: string | null;

  @ApiPropertyOptional({ description: 'Null = stock not tracked' })
  @IsOptional() @Transform(({ value }) => (value === '' ? null : value)) @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000_000)
  stockQuantity?: number | null;

  @ApiPropertyOptional({ enum: PRODUCT_AVAILABILITY }) @IsOptional() @IsIn(PRODUCT_AVAILABILITY as unknown as string[])
  availability?: string;

  @ApiPropertyOptional({ enum: CATALOG_STATUSES }) @IsOptional() @IsIn(CATALOG_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ type: [String] }) @IsOptional() @CleanList() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(200, { each: true })
  features?: string[];

  @ApiPropertyOptional({ type: [String] }) @IsOptional() @CleanList() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(200, { each: true })
  benefits?: string[];

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @MaxLength(2000)
  targetAudience?: string | null;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @MaxLength(2048) @Matches(HTTP_URL_REGEX, { message: 'url must start with http(s)://' })
  url?: string | null;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {}

export class SetProductMediaDto {
  @ApiProperty({ type: [String], description: 'Ordered media ids (images/videos of this business)' })
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @Matches(ID_REGEX, { each: true })
  mediaIds: string[];
}

export class ProductQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Category id, or "none" for uncategorised' })
  @IsOptional() @IsString() @Matches(/^(none|[a-z0-9]{20,40})$/)
  categoryId?: string;

  @ApiPropertyOptional({ enum: CATALOG_STATUSES }) @IsOptional() @IsIn(CATALOG_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ enum: PRODUCT_AVAILABILITY }) @IsOptional() @IsIn(PRODUCT_AVAILABILITY as unknown as string[])
  availability?: string;

  @ApiPropertyOptional({ enum: ['updatedAt', 'createdAt', 'name', 'price'], default: 'updatedAt' })
  @IsOptional() @IsIn(['updatedAt', 'createdAt', 'name', 'price'])
  sort: 'updatedAt' | 'createdAt' | 'name' | 'price' = 'updatedAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' }) @IsOptional() @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc' = 'desc';
}
