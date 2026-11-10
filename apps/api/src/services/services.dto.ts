import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CATALOG_STATUSES, SERVICE_AVAILABILITY } from '@touma/shared';
import { PageQueryDto } from '../common/pagination';
import { CleanList, HTTP_URL_REGEX, ID_REGEX, MONEY_REGEX, Trim, TrimToNull, Upper } from '../common/validators';

export class CreateServiceDto {
  @ApiProperty({ example: 'Home delivery' }) @Trim() @IsString() @MinLength(1) @MaxLength(200)
  name: string;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @MaxLength(5000)
  description?: string | null;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @Matches(ID_REGEX)
  categoryId?: string | null;

  @ApiPropertyOptional({ example: '25000.00' })
  @IsOptional() @TrimToNull() @IsString() @Matches(MONEY_REGEX, { message: 'price must be a positive decimal string with at most 2 decimals' })
  price?: string | null;

  @ApiPropertyOptional({ example: 'XAF' }) @IsOptional() @Upper() @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @ApiPropertyOptional({ example: 60 })
  @IsOptional() @Transform(({ value }) => (value === '' ? null : value)) @Type(() => Number) @IsInt() @Min(1) @Max(43_200)
  durationMinutes?: number | null;

  @ApiPropertyOptional({ enum: SERVICE_AVAILABILITY }) @IsOptional() @IsIn(SERVICE_AVAILABILITY as unknown as string[])
  availability?: string;

  @ApiPropertyOptional({ example: 'Mon–Sat 9:00–18:00' }) @IsOptional() @TrimToNull() @IsString() @MaxLength(500)
  availabilityNotes?: string | null;

  @ApiPropertyOptional({ example: 'Call or WhatsApp +235 66 00 00 00' }) @IsOptional() @TrimToNull() @IsString() @MaxLength(2000)
  bookingInfo?: string | null;

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @MaxLength(2048) @Matches(HTTP_URL_REGEX, { message: 'bookingUrl must start with http(s)://' })
  bookingUrl?: string | null;

  @ApiPropertyOptional({ enum: CATALOG_STATUSES }) @IsOptional() @IsIn(CATALOG_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ type: [String] }) @IsOptional() @CleanList() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(200, { each: true })
  features?: string[];

  @ApiPropertyOptional({ type: [String] }) @IsOptional() @CleanList() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(200, { each: true })
  benefits?: string[];

  @ApiPropertyOptional() @IsOptional() @TrimToNull() @IsString() @MaxLength(2000)
  targetAudience?: string | null;
}

export class UpdateServiceDto extends PartialType(CreateServiceDto) {}

export class ServiceQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Category id, or "none"' }) @IsOptional() @IsString() @Matches(/^(none|[a-z0-9]{20,40})$/)
  categoryId?: string;

  @ApiPropertyOptional({ enum: CATALOG_STATUSES }) @IsOptional() @IsIn(CATALOG_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ enum: SERVICE_AVAILABILITY }) @IsOptional() @IsIn(SERVICE_AVAILABILITY as unknown as string[])
  availability?: string;

  @ApiPropertyOptional({ enum: ['updatedAt', 'createdAt', 'name', 'price'] }) @IsOptional() @IsIn(['updatedAt', 'createdAt', 'name', 'price'])
  sort: 'updatedAt' | 'createdAt' | 'name' | 'price' = 'updatedAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'] }) @IsOptional() @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc' = 'desc';
}
